import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path

import httpx2
import pytest


def load_runner():
    spec = importlib.util.spec_from_file_location("region_conflict_runner", Path(__file__).with_name("run.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def runner(tmp_path, monkeypatch):
    module = load_runner()
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    return module


def test_plan_does_not_read_credentials_create_outputs_or_run_phases(runner, monkeypatch, capsys):
    def forbidden(*args, **kwargs):
        raise AssertionError("execution was attempted in plan mode")
    monkeypatch.setattr(runner, "read_api_key", forbidden)
    monkeypatch.setattr(runner, "run_phase", forbidden)
    assert asyncio.run(runner.run(key_file="missing-secret-file")) == 0
    plan = json.loads(capsys.readouterr().out)
    assert plan["plannedRankingCalls"] == plan["maximumTotalAttempts"] == 8
    assert plan["candidateCounts"] == {"synthetic": 18, "public": 20}
    assert plan["embeddingCalls"] == 0
    assert list(runner.ROOT.iterdir()) == []


def test_key_file_reads_only_the_named_variable_without_shell_expansion(runner, tmp_path, capsys):
    key_file = tmp_path / ".env"
    key_file.write_text("DATABASE_PASSWORD=do-not-load\nexport OPENAI_API_KEY='offline-dummy' # comment\n")
    assert runner.read_api_key(key_file) == "offline-dummy"
    key_file.write_text("OPENAI_API_KEY=$(touch forbidden)\n")
    with pytest.raises(runner.GuardRejected, match="MISSING_OR_INVALID_API_KEY"):
        runner.read_api_key(key_file)
    assert capsys.readouterr().out == ""


def test_duplicate_key_definitions_are_rejected(runner, tmp_path):
    key_file = tmp_path / ".env"
    key_file.write_text("OPENAI_API_KEY=first\nOPENAI_API_KEY=second\n")
    with pytest.raises(runner.GuardRejected, match="MISSING_OR_DUPLICATE_API_KEY"):
        runner.read_api_key(key_file)


def test_ledger_preserves_failed_attempts_and_refuses_phase_or_attempt_repeats(runner):
    ledger = runner.ROOT / "ledger-live.jsonl"
    for phase in runner.PHASES:
        runner.ledger_event(ledger, {"event": "phase_reserved", "phase": phase})
        for case, repetition in runner.PLANS[phase]:
            runner.ledger_event(ledger, {"event": "attempt", "phase": phase, "caseId": case, "repetition": repetition})
    entries = [json.loads(line) for line in ledger.read_text().splitlines()]
    assert sum(entry["event"] == "attempt" for entry in entries) == 8
    with pytest.raises(runner.GuardRejected, match="PHASE_ALREADY_RESERVED"):
        runner.ledger_event(ledger, {"event": "phase_reserved", "phase": "baseline"})
    with pytest.raises(runner.GuardRejected, match="ATTEMPT_BUDGET_OR_DUPLICATE"):
        runner.ledger_event(ledger, {"event": "attempt", "phase": "after", "caseId": "PUBLIC_FUNDS", "repetition": 2})
    assert len(ledger.read_text().splitlines()) == 10


def wire_example(runner):
    payload = {"model": runner.MODEL, "store": False, "max_output_tokens": 10000,
               "reasoning": {"effort": "low"}, "service_tier": "priority", "tools": [],
               "input": [{"role": "user", "content": "fixed input"}], "instructions": "fixed prompt",
               "text": {"format": {"type": "json_schema", "strict": True, "schema": {"type": "object"}}}}
    active = {"runnerVerified": True, "schemaSha256": runner.sha(payload["text"]["format"]["schema"]),
              "modelInputSha256": runner.sha(payload["input"]), "promptSha256": runner.sha(payload["instructions"])}
    return payload, active


@pytest.mark.parametrize("url,method", [
    ("https://unapproved.example/v1/responses", "POST"),
    ("http://api.openai.com/v1/responses", "POST"),
    ("https://api.openai.com/v1/embeddings", "POST"),
    ("https://api.openai.com/v1/responses?extra=true", "POST"),
    ("https://api.openai.com/v1/responses", "GET"),
])
def test_destination_guard(runner, url, method):
    payload, active = wire_example(runner)
    request = httpx2.Request(method, url, extensions={"timeout": {"read": 45}})
    with pytest.raises(runner.GuardRejected, match="DESTINATION_REJECTED"):
        runner.check_wire_request(request, payload, tier="priority", active=active)


@pytest.mark.parametrize("change", [
    {"model": "other-model"}, {"store": True}, {"max_output_tokens": 10001},
    {"reasoning": {"effort": "high"}}, {"service_tier": "default"}, {"tools": [{"type": "web_search"}]},
    {"stream": True}, {"input": []}, {"instructions": "changed prompt"},
])
def test_settings_and_content_guards(runner, change):
    payload, active = wire_example(runner)
    request = httpx2.Request("POST", "https://api.openai.com/v1/responses", extensions={"timeout": {"read": 45}})
    runner.check_wire_request(request, payload, tier="priority", active=active)
    with pytest.raises(runner.GuardRejected):
        runner.check_wire_request(request, {**payload, **change}, tier="priority", active=active)
    active["sent"] = True
    with pytest.raises(runner.GuardRejected, match="WIRE_SETTINGS_OR_DUPLICATE"):
        runner.check_wire_request(request, payload, tier="priority", active=active)


@pytest.mark.parametrize("timeout", [None, {"read": 46}, {"read": 45, "connect": None}])
def test_timeout_guard(runner, timeout):
    payload, active = wire_example(runner)
    request = httpx2.Request("POST", "https://api.openai.com/v1/responses",
                            extensions={} if timeout is None else {"timeout": timeout})
    with pytest.raises(runner.GuardRejected, match="HTTP_TIMEOUT_CHANGED"):
        runner.check_wire_request(request, payload, tier="priority", active=active)


def test_offline_all_phases_make_eight_mock_calls_and_capture_every_assessment(runner):
    assert asyncio.run(runner.run(execute=True, offline=True)) == 0
    for phase in runner.PHASES:
        output = runner.ROOT / "offline-output" / phase
        manifest = json.loads((output / "manifest.json").read_text())
        capture = json.loads((output / "capture.json").read_text())
        usage = json.loads((output / "usage.json").read_text())
        assert manifest["provenance"] == "mock"
        assert manifest["attempts"] == manifest["actualCalls"] == manifest["completedRankings"] == len(runner.PLANS[phase])
        assert manifest["failedRankings"] == 0
        assert len(capture["observations"]) == len(runner.PLANS[phase])
        assert all(len(item["assessments"]["rankings"]) == (20 if item["identity"][0] == "PUBLIC_FUNDS" else 18)
                   for item in capture["observations"])
        receipts = [item for item in usage if item["event"] == "response"]
        assert len(receipts) == len(runner.PLANS[phase])
        assert all(item["cachedInputTokens"] == item["reasoningTokens"] == 0 for item in receipts)
        assert {item["returnedServiceTier"] for item in receipts} == {"priority"}
    assert not (runner.ROOT / "ledger-live.jsonl").exists()
    with pytest.raises(FileExistsError):
        asyncio.run(runner.run(execute=True, offline=True, phase="baseline"))


def test_failed_calls_keep_all_three_attempts_and_only_save_safe_errors(runner, monkeypatch):
    def rejected(*args, **kwargs):
        raise RuntimeError("sensitive upstream error content")
    monkeypatch.setattr(runner, "check_wire_request", rejected)
    assert asyncio.run(runner.run(execute=True, offline=True, phase="baseline")) == 2
    output = runner.ROOT / "offline-output/baseline"
    manifest = json.loads((output / "manifest.json").read_text())
    capture = (output / "capture.json").read_text()
    assert manifest["attempts"] == manifest["failedRankings"] == 3
    assert manifest["actualCalls"] == 0
    assert "sensitive upstream" not in capture
    assert len([line for line in (runner.ROOT / "ledger-offline.jsonl").read_text().splitlines()
                if json.loads(line)["event"] == "attempt"]) == 3


def test_fixture_labels_are_exhaustive_and_never_sent(runner):
    fixture = json.loads(runner.FIXTURE_FILE.read_text())
    candidates, cases = runner.evaluator().validate_fixture(fixture)
    assert len(candidates) == 18
    assert len(cases) == 3
    requests = runner.requests_for_cases()
    for name, _ in runner.SYNTHETIC_PLAN:
        encoded = json.dumps(requests[name], ensure_ascii=False)
        assert "expected" not in encoded
        assert "requiredEvidence" not in encoded
        assert "rationale" not in encoded
        assert "labelProvenance" not in encoded
        assert not any(term in encoded for term in ("MATCH", "INCOMPATIBLE", "UNKNOWN"))
    labels = {case["id"]: case["expected"] for case in fixture["cases"]}
    assert labels["REGION_SEOUL"]["SYNTH:ANSAN"]["eligibility"] == "INCOMPATIBLE"
    assert labels["REGION_SEOUL"]["SYNTH:DANWON"]["eligibility"] == "INCOMPATIBLE"
    assert labels["REGION_ANSAN"]["SYNTH:DANWON"]["eligibility"] == "UNKNOWN"
    assert labels["REGION_SEOUL"]["SYNTH:SEOUL_OR_MOVE"]["eligibility"] == "MATCH"
    assert labels["REGION_ANSAN"]["SYNTH:SEOUL_OR_MOVE"]["eligibility"] == "UNKNOWN"
    assert labels["REGION_ANSAN"]["SYNTH:ANY_SITE"]["eligibility"] == "UNKNOWN"
    assert "만" not in candidates["SYNTH:ANSAN"]["summary"]


def test_saved_baseline_prompt_is_independent_of_current_prompt(runner, monkeypatch):
    from app.support_program_ranking import prompt
    for name in runner.PROMPT_NAMES:
        monkeypatch.setattr(prompt, name, "changed-current-prompt")
    baseline = runner.load_snapshot(runner.BASELINE_FILE, "baseline")
    saved = runner.load_snapshot(runner.BASELINE_PROMPT_FILE, "test_baseline_prompt")
    for name in runner.PROMPT_NAMES:
        assert getattr(baseline, name) == getattr(saved, name) != "changed-current-prompt"


def test_saved_after_sources_match_actual_v1_execution_and_ignore_current_prompt(runner, monkeypatch):
    from app.support_program_ranking import prompt
    recorded_root = Path(__file__).parent
    manifest = json.loads((recorded_root / "output/after/manifest.json").read_text())
    assert hashlib.sha256(runner.AFTER_FILE.read_bytes()).hexdigest() == manifest["agentSourceSha256"]
    assert hashlib.sha256(runner.AFTER_PROMPT_FILE.read_bytes()).hexdigest() == manifest["promptSourceSha256"]
    for name in runner.PROMPT_NAMES:
        monkeypatch.setattr(prompt, name, "changed-current-prompt")
    after = runner.load_snapshot(runner.AFTER_FILE, "after")
    saved = runner.load_snapshot(runner.AFTER_PROMPT_FILE, "test_after_prompt")
    for name in runner.PROMPT_NAMES:
        assert getattr(after, name) == getattr(saved, name) != "changed-current-prompt"
    assert asyncio.run(runner.run(execute=True, offline=True, phase="after")) == 0
    simulated = json.loads((runner.ROOT / "offline-output/after/capture.json").read_text())["observations"]
    recorded = json.loads((recorded_root / "output/after/capture.json").read_text())["observations"]
    for actual, previous in zip(simulated, recorded, strict=True):
        for key in ("identity", "requestSha256", "candidateSha256", "schemaSha256", "modelInputSha256", "promptSha256"):
            assert actual[key] == previous[key]


def test_phases_cannot_borrow_each_others_budget(runner):
    ledger = runner.ROOT / "ledger-live.jsonl"
    runner.ledger_event(ledger, {"event": "phase_reserved", "phase": "baseline"})
    with pytest.raises(runner.GuardRejected, match="ATTEMPT_BUDGET_OR_DUPLICATE"):
        runner.ledger_event(ledger, {"event": "attempt", "phase": "baseline", "caseId": "PUBLIC_FUNDS", "repetition": 1})


def test_mock_report_does_not_claim_live_or_successful_quality(runner):
    assert asyncio.run(runner.run(execute=True, offline=True, phase="after")) == 0
    output = runner.ROOT / "offline-output/after"
    report = json.loads((output / "report.json").read_text())
    assert report["assessmentCount"] == 54
    assert report["provenance"]["kind"] == "mock"
    assert report["provenanceVerified"] is False
    assert report["passed"] is False
    checks = json.loads((output / "public-checks.json").read_text())
    assert all(not row["checks"][0]["passed"] for row in checks["observations"])
