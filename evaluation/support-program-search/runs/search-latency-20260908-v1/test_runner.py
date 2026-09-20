import asyncio
import importlib.util
import json
from pathlib import Path

import httpx2
import pytest


def load_runner():
    spec = importlib.util.spec_from_file_location("latency_runner", Path(__file__).with_name("run.py"))
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
    assert plan["plannedRankingCalls"] == plan["maximumTotalAttempts"] == 18
    assert plan["candidateCount"] == 20
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
        for case, repetition in runner.PLAN:
            runner.ledger_event(ledger, {"event": "attempt", "phase": phase, "caseId": case, "repetition": repetition})
    entries = [json.loads(line) for line in ledger.read_text().splitlines()]
    assert sum(entry["event"] == "attempt" for entry in entries) == 18
    with pytest.raises(runner.GuardRejected, match="PHASE_ALREADY_RESERVED"):
        runner.ledger_event(ledger, {"event": "phase_reserved", "phase": "baseline"})
    with pytest.raises(runner.GuardRejected, match="ATTEMPT_BUDGET_OR_DUPLICATE"):
        runner.ledger_event(ledger, {"event": "attempt", "phase": "fast", "caseId": "FUNDS", "repetition": 2})
    assert len(ledger.read_text().splitlines()) == 21


def wire_example(runner):
    payload = {"model": runner.MODEL, "store": False, "max_output_tokens": 10000,
               "reasoning": {"effort": "low"}, "service_tier": "default", "tools": [],
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
        runner.check_wire_request(request, payload, tier="default", active=active)


@pytest.mark.parametrize("change", [
    {"model": "other-model"}, {"store": True}, {"max_output_tokens": 10001},
    {"reasoning": {"effort": "high"}}, {"service_tier": "priority"}, {"tools": [{"type": "web_search"}]},
    {"stream": True}, {"input": []}, {"instructions": "changed prompt"},
])
def test_settings_and_content_guards(runner, change):
    payload, active = wire_example(runner)
    request = httpx2.Request("POST", "https://api.openai.com/v1/responses", extensions={"timeout": {"read": 45}})
    runner.check_wire_request(request, payload, tier="default", active=active)
    with pytest.raises(runner.GuardRejected):
        runner.check_wire_request(request, {**payload, **change}, tier="default", active=active)
    active["sent"] = True
    with pytest.raises(runner.GuardRejected, match="WIRE_SETTINGS_OR_DUPLICATE"):
        runner.check_wire_request(request, payload, tier="default", active=active)


@pytest.mark.parametrize("timeout", [None, {"read": 46}, {"read": 45, "connect": None}])
def test_timeout_guard(runner, timeout):
    payload, active = wire_example(runner)
    request = httpx2.Request("POST", "https://api.openai.com/v1/responses",
                            extensions={} if timeout is None else {"timeout": timeout})
    with pytest.raises(runner.GuardRejected, match="HTTP_TIMEOUT_CHANGED"):
        runner.check_wire_request(request, payload, tier="default", active=active)


def test_offline_all_phases_make_18_mock_calls_and_capture_all_20_assessments(runner, monkeypatch):
    from app.support_program_ranking import agent as production_agent, prompt as production_prompt

    def forbidden(*args, **kwargs):
        raise AssertionError("historical evaluation used the current production agent")

    # Production changes must not change this historical model-facing prompt or schema.
    for module in (production_agent, production_prompt):
        monkeypatch.setattr(module, "SUPPORT_PROGRAM_RANKING_INSTRUCTIONS", "changed production ranking policy")
        monkeypatch.setattr(module, "SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS", "changed production company policy")
    monkeypatch.setattr(production_agent, "SupportProgramRecommendationAgent", forbidden)
    assert asyncio.run(runner.run(execute=True, offline=True)) == 0
    for phase in runner.PHASES:
        output = runner.ROOT / "offline-output" / phase
        manifest = json.loads((output / "manifest.json").read_text())
        capture = json.loads((output / "capture.json").read_text())
        usage = json.loads((output / "usage.json").read_text())
        assert manifest["provenance"] == "mock"
        assert manifest["attempts"] == manifest["actualCalls"] == manifest["completedRankings"] == 6
        assert manifest["failedRankings"] == 0
        assert len(capture["observations"]) == 6
        assert all(len(item["assessments"]["rankings"]) == 20 for item in capture["observations"])
        historical = json.loads((Path(__file__).parent / "output" / phase / "capture.json").read_text())
        expected_by_identity = {tuple(item["identity"]): item for item in historical["observations"]}
        for item in capture["observations"]:
            expected = expected_by_identity[tuple(item["identity"])]
            for field in ("promptSha256", "schemaSha256", "modelInputSha256"):
                assert item[field] == expected[field], (phase, item["identity"], field)
        source = runner.BASELINE_FILE if phase == "baseline" else runner.COMPACT_FILE
        assert manifest["agentSourceSha256"] == runner.hashlib.sha256(source.read_bytes()).hexdigest()
        assert manifest["promptSourceSha256"] == runner.hashlib.sha256(runner.PROMPT_FILE.read_bytes()).hexdigest()
        receipts = [item for item in usage if item["event"] == "response"]
        assert len(receipts) == 6
        assert all(item["cachedInputTokens"] == item["reasoningTokens"] == 0 for item in receipts)
        assert {item["returnedServiceTier"] for item in receipts} == {"priority" if phase == "fast" else "default"}
    assert not (runner.ROOT / "ledger-live.jsonl").exists()
    assert production_agent.SUPPORT_PROGRAM_RANKING_INSTRUCTIONS == "changed production ranking policy"
    assert production_prompt.SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS == "changed production company policy"
    with pytest.raises(FileExistsError):
        asyncio.run(runner.run(execute=True, offline=True, phase="baseline"))


def test_offline_fast_compact_format_uses_the_same_guard_and_budget(runner):
    assert asyncio.run(runner.run(execute=True, offline=True, phase="fast", fast_format="compact")) == 0
    manifest = json.loads((runner.ROOT / "offline-output/fast/manifest.json").read_text())
    assert manifest["outputFormat"] == "compact"
    assert manifest["requestedServiceTier"] == "priority"
    assert manifest["actualCalls"] == 6


def test_failed_calls_keep_all_six_attempts_and_only_save_safe_errors(runner, monkeypatch):
    def rejected(*args, **kwargs):
        raise RuntimeError("sensitive upstream error content")
    monkeypatch.setattr(runner, "check_wire_request", rejected)
    assert asyncio.run(runner.run(execute=True, offline=True, phase="baseline")) == 2
    output = runner.ROOT / "offline-output/baseline"
    manifest = json.loads((output / "manifest.json").read_text())
    capture = (output / "capture.json").read_text()
    assert manifest["attempts"] == manifest["failedRankings"] == 6
    assert manifest["actualCalls"] == 0
    assert "sensitive upstream" not in capture
    assert len([line for line in (runner.ROOT / "ledger-offline.jsonl").read_text().splitlines()
                if json.loads(line)["event"] == "attempt"]) == 6
