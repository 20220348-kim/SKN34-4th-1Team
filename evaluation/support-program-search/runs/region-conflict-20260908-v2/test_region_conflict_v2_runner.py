import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest


@pytest.fixture
def runner(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("region_conflict_v2_runner", Path(__file__).with_name("run.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.engine, "ROOT", tmp_path)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    return module


def test_default_plan_is_five_calls_without_execution_or_key_read(runner, monkeypatch, capsys):
    def forbidden(*args, **kwargs):
        raise AssertionError("Plan must not execute or read credentials")
    monkeypatch.setattr(runner.engine, "read_api_key", forbidden)
    monkeypatch.setattr(runner.engine, "run_phase", forbidden)
    assert asyncio.run(runner.run(key_file="does-not-exist")) == 0
    plan = json.loads(capsys.readouterr().out)
    assert plan["plannedRankingCalls"] == plan["maximumTotalAttempts"] == 5
    assert plan["actualApiCalls"] == plan["embeddingCalls"] == 0
    assert plan["phases"] == ["after"]
    assert not list(runner.engine.ROOT.iterdir())


def test_v2_does_not_allow_a_baseline_phase(runner):
    with pytest.raises(runner.engine.GuardRejected, match="INVALID_PHASE"):
        asyncio.run(runner.run(phase="baseline"))


def test_v2_reuses_unchanged_v1_inputs_and_saved_v2_source(runner):
    engine = runner.engine
    assert engine.FIXTURE_FILE == runner.V1 / "fixture.json"
    fixture = json.loads(engine.FIXTURE_FILE.read_text())
    assert engine.sha(fixture) == runner.FIXTURE_SHA256
    assert engine.AFTER_FILE == Path(__file__).parent / "after_agent.py"
    assert engine.AFTER_PROMPT_FILE == Path(__file__).parent / "after_prompt.py"
    recorded = json.loads((runner.V1 / "output/after/requests.json").read_text())
    assert engine.requests_for_cases() == recorded


def test_modified_expectations_are_rejected_before_execution(runner, tmp_path, monkeypatch):
    fixture = json.loads(runner.engine.FIXTURE_FILE.read_text())
    fixture["cases"][2]["expected"]["SYNTH:ANY_SITE"]["eligibility"] = "INCOMPATIBLE"
    changed = tmp_path / "changed.json"
    changed.write_text(json.dumps(fixture))
    monkeypatch.setattr(runner.engine, "FIXTURE_FILE", changed)
    with pytest.raises(runner.engine.GuardRejected, match="FROZEN_V1_FIXTURE_CHANGED"):
        asyncio.run(runner.run())


def test_offline_v2_uses_five_guarded_requests_and_separate_ledger(runner):
    old_ledger = (runner.V1 / "ledger-live.jsonl").read_bytes()
    assert asyncio.run(runner.run(execute=True, offline=True)) == 0
    root = runner.engine.ROOT
    output = root / "offline-output/after"
    manifest = json.loads((output / "manifest.json").read_text())
    assert manifest["maximumTotalAttempts"] == manifest["attempts"] == manifest["actualCalls"] == 5
    assert manifest["provenance"] == "mock"
    assert manifest["requestedServiceTier"] == "priority"
    assert manifest["sdkMaxRetries"] == manifest["embeddingCalls"] == 0
    capture = json.loads((output / "capture.json").read_text())
    assert [len(row["assessments"]["rankings"]) for row in capture["observations"]] == [18, 18, 18, 20, 20]
    report = json.loads((output / "report.json").read_text())
    assert report["assessmentCount"] == 54
    assert report["fixtureSha256"] == runner.FIXTURE_SHA256
    assert report["passed"] is False
    ledger = [json.loads(line) for line in (root / "ledger-offline.jsonl").read_text().splitlines()]
    assert sum(row["event"] == "attempt" for row in ledger) == 5
    assert (runner.V1 / "ledger-live.jsonl").read_bytes() == old_ledger
    assert not (root / "ledger-live.jsonl").exists()
    with pytest.raises(FileExistsError):
        asyncio.run(runner.run(execute=True, offline=True))


def test_v2_ledger_rejects_sixth_attempt_and_repeated_phase(runner):
    engine = runner.engine
    ledger = engine.ROOT / "ledger-live.jsonl"
    engine.ledger_event(ledger, {"event": "phase_reserved", "phase": "after"})
    for name, repetition in engine.PLANS["after"]:
        engine.ledger_event(ledger, {"event": "attempt", "phase": "after", "caseId": name, "repetition": repetition})
    with pytest.raises(engine.GuardRejected, match="ATTEMPT_BUDGET_OR_DUPLICATE"):
        engine.ledger_event(ledger, {"event": "attempt", "phase": "after", "caseId": "PUBLIC_FUNDS", "repetition": 3})
    with pytest.raises(engine.GuardRejected, match="PHASE_ALREADY_RESERVED"):
        engine.ledger_event(ledger, {"event": "phase_reserved", "phase": "after"})


def test_snapshot_reproduces_live_sources_and_wire_hashes_after_production_changes(runner, monkeypatch):
    from app.support_program_ranking import prompt
    engine = runner.engine
    recorded_root = Path(__file__).parent
    manifest = json.loads((recorded_root / "output/after/manifest.json").read_text())
    assert hashlib.sha256(engine.AFTER_FILE.read_bytes()).hexdigest() == manifest["agentSourceSha256"]
    assert hashlib.sha256(engine.AFTER_PROMPT_FILE.read_bytes()).hexdigest() == manifest["promptSourceSha256"]
    for name in engine.PROMPT_NAMES:
        monkeypatch.setattr(prompt, name, "changed-current-prompt")
    assert asyncio.run(runner.run(execute=True, offline=True)) == 0
    simulated = json.loads((engine.ROOT / "offline-output/after/capture.json").read_text())["observations"]
    recorded = json.loads((recorded_root / "output/after/capture.json").read_text())["observations"]
    for actual, previous in zip(simulated, recorded, strict=True):
        for key in ("identity", "requestSha256", "candidateSha256", "schemaSha256", "modelInputSha256", "promptSha256"):
            assert actual[key] == previous[key]
