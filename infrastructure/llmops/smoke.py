"""실제 개발 서버에 무료 trace·점수·보고서를 저장하고 다시 조회한다."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import time
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "backend/ai-service"), str(ROOT / "evaluation/support-program-evidence")]
os.environ["DO_NOT_TRACK"] = "1"
os.environ["PREFECT_SERVER_ANALYTICS_ENABLED"] = "false"
os.environ.setdefault("PREFECT_HOME", str(ROOT / "work/llmops/prefect-client"))

import httpx
from app.config import LangfuseSettings
from app.support_program_evidence.agent import SupportProgramEvidenceAnswerAgent
from app.support_program_evidence.answer_service import SupportProgramEvidenceAnswerService
from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.support_program_evidence.tracing import EvidenceTracing
from tests.langchain_stub import ResponsesChatStub, response_message
from tests.support_program_evidence.test_agent import answer_request, valid_selection
from llmops import evaluate_capture, write_json


def wait_ready(base_url: str, path: str) -> None:
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        try:
            response = httpx.get(base_url + path, timeout=5)
            if response.status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(2)
    raise RuntimeError("Local LLMOps server readiness timed out")


async def trace_examples(settings):
    tracing = EvidenceTracing(settings)
    records = []
    try:
        for failing in [False, True]:
            trace_id = uuid4().hex
            stub = ResponsesChatStub([[response_message("invalid-private-output" if failing else valid_selection().model_dump_json(by_alias=True))]])
            agent = SupportProgramEvidenceAnswerAgent(model=stub.model, model_timeout_seconds=10,
                                                       run_timeout_seconds=15, tracing=tracing)
            service = SupportProgramEvidenceAnswerService(agent, tracing)
            try:
                await service.answer(answer_request(), trace_id=trace_id)
                assert not failing
            except SupportProgramEvidenceError:
                assert failing
            assert len(stub.calls) == 1
            await stub.model.root_async_client.close()
            records.append({"trace_id": trace_id, "expected_failure": failing})
    finally:
        await tracing.close()
    return records


def verify_traces(settings, records):
    with httpx.Client(base_url=settings.base_url, auth=(settings.public_key, settings.secret_key), timeout=10) as client:
        for record in records:
            deadline = time.monotonic() + 60
            while True:
                response = client.get("/api/public/v2/observations", params={
                    "traceId": record["trace_id"], "fields": "basic,io,metadata,model,usage", "limit": 10,
                })
                response.raise_for_status()
                observations = response.json()["data"]
                if len(observations) == 2:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("Trace readback timed out")
                time.sleep(1)
            root = next(item for item in observations if item["name"] == "evidence.answer")
            model = next(item for item in observations if item["name"] == "evidence.model")
            assert model["parentObservationId"] == root["id"]
            assert (root["level"] == "ERROR") == record["expected_failure"]
            for item in observations:
                assert item.get("input") in (None, "", "null") and item.get("output") in (None, "", "null")
            serialized = json.dumps(observations, ensure_ascii=False)
            for private in [answer_request().question, valid_selection().answer, "invalid-private-output", settings.secret_key]:
                assert private not in serialized


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    settings = LangfuseSettings.from_environment()
    if not settings.enabled or not os.environ.get("PREFECT_API_URL"):
        parser.error("explicit local Langfuse and Prefect settings required")
    # 이 검증 도구는 오직 로컬 개발 서버에만 합성 데이터를 보낸다.
    from urllib.parse import urlsplit
    for url in [settings.base_url, os.environ["PREFECT_API_URL"]]:
        if urlsplit(url).hostname not in {"localhost", "127.0.0.1"}:
            parser.error("smoke test requires loopback endpoints")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    wait_ready(settings.base_url, "/api/public/health")
    wait_ready(os.environ["PREFECT_API_URL"], "/health")
    traces = asyncio.run(trace_examples(settings))
    verify_traces(settings, traces)
    fixture = str(ROOT / "evaluation/support-program-evidence/target-coverage-fixture.json")
    capture = str(ROOT / "evaluation/support-program-evidence/runs/target-coverage-20260907-v1/capture.json")
    first = evaluate_capture(fixture, capture, capture, str(output / "first"))
    second = evaluate_capture(fixture, capture, capture, str(output / "replay"))
    assert first["evaluation_run_id"] == second["evaluation_run_id"]
    assert first["score_ids"] == second["score_ids"]
    bad = output / "invalid-capture.json"
    bad.write_text("{}")
    try:
        evaluate_capture(fixture, str(bad), capture, str(output / "failed"))
    except ValueError:
        pass
    else:
        raise AssertionError("Invalid input must fail the flow")
    failed = json.loads((output / "failed/manifest.json").read_text())
    with httpx.Client(base_url=os.environ["PREFECT_API_URL"], timeout=10) as client:
        for run, expected in [(first, "COMPLETED"), (second, "COMPLETED"), (failed, "FAILED")]:
            response = client.get(f'/flow_runs/{run["prefect_flow_run_id"]}')
            response.raise_for_status()
            assert response.json()["state_type"] == expected
    summary = {"python_version": sys.version.split()[0],
               "trace_checks": traces, "evaluation_run_id": first["evaluation_run_id"],
               "score_count": len(first["score_ids"]), "prefect_states": ["COMPLETED", "COMPLETED", "FAILED"],
               "model_api_calls": 0, "report": "first/report.html"}
    write_json(output / "verification.json", summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
