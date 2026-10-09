"""Offline recorder and real AI/SDK/local-Qdrant checks; the JVM/MySQL path runs in CI."""

import asyncio
import importlib.util
import json
import threading
from dataclasses import replace
from http.server import ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

import core_rag_capture as capture
import pytest
import rag_capture_app as recorder
from app.main import create_app
from fastapi.testclient import TestClient
from qdrant_client import AsyncQdrantClient
from test_core_evidence_trace import documents
from tests.support_program_evidence.test_tracing import (
    trace_environment as trace_environment,  # noqa: PLC0414
)
from tests.test_bootstrap import OPENAI_SETTINGS

spec = importlib.util.spec_from_file_location(
    "rag_openai_fixture", Path(__file__).resolve().parents[1] / "stubs/openai/server.py"
)
stub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stub)


def chunks_for(content):
    # This helper only builds test doubles; Core's own unit and HTTP CI tests verify actual chunking.
    return [
        {
            "id": capture.rag.digest(
                f"{recorder.PROGRAM}\0{capture.rag.digest(content)}\0{order}"
            ),
            "documentId": recorder.PROGRAM,
            "order": order,
            "text": text,
            "contentHash": capture.rag.digest(text),
        }
        for order, text in enumerate(content.split("\n\n"))
    ]


def metadata():
    return {
        "kind": "integration-stub",
        "model": "test-model",
        "embeddingModel": "text-embedding-3-small",
        "promptSha256": "a" * 64,
        "recorderSha256": "b" * 64,
        "paidModelApiCalls": 0,
    }


@pytest.mark.parametrize(
    "environment",
    [
        {},
        {"RAG_CAPTURE_FIXTURE": "true"},
        {
            "RAG_CAPTURE_FIXTURE": "true",
            "OPENAI_API_KEY": "catalog-verification-key-never-sent",
            "OPENAI_BASE_URL": "https://api.openai.com/v1",
        },
        {
            "RAG_CAPTURE_FIXTURE": "true",
            "OPENAI_API_KEY": "actual-key",
            "OPENAI_BASE_URL": "http://govbiz-catalog-check-123456789abc-openai-stub-1:8002/v1",
        },
    ],
)
def test_recorder_refuses_non_fixture_execution(monkeypatch, tmp_path, environment):
    for key in ("RAG_CAPTURE_FIXTURE", "OPENAI_API_KEY", "OPENAI_BASE_URL"):
        monkeypatch.delenv(key, raising=False)
    for key, value in environment.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(recorder, "CAPTURE_PATH", tmp_path / "wire.jsonl")
    with pytest.raises(ValueError, match="disposable"):
        recorder.create_app()
    assert not recorder.CAPTURE_PATH.exists()


def test_recorder_uses_runtime_settings_and_refuses_to_overwrite_an_old_run(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("RAG_CAPTURE_FIXTURE", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "catalog-verification-key-never-sent")
    monkeypatch.setenv(
        "OPENAI_BASE_URL",
        "http://govbiz-catalog-check-123456789abc-openai-stub-1:8002/v1",
    )
    monkeypatch.setenv("OPENAI_MODEL", "explicit-fixture-model")
    monkeypatch.setattr(recorder, "CAPTURE_PATH", tmp_path / "wire.jsonl")
    monkeypatch.setattr("app.main.create_app", lambda **kwargs: object())
    assert isinstance(recorder.create_app(), recorder.RagCaptureApp)
    execution = json.loads(recorder.CAPTURE_PATH.read_text())["execution"]
    assert (
        execution["model"] == "explicit-fixture-model"
        and execution["paidModelApiCalls"] == 0
    )
    with pytest.raises(FileExistsError):
        recorder.create_app()


def test_recorder_preserves_segmented_http_bytes_without_recording_unrelated_text(
    tmp_path,
):
    async def run(payload, path):
        incoming = json.dumps(payload).encode()
        outgoing = b'{"indexedCount":6}'
        messages = iter(
            [
                {"type": "http.request", "body": incoming[:10], "more_body": True},
                {"type": "http.request", "body": incoming[10:], "more_body": False},
            ]
        )
        sent = []

        async def receive():
            return next(messages)

        async def send(message):
            sent.append(message)

        async def app(scope, receive, send):
            assert (await receive())["body"] + (await receive())["body"] == incoming
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send(
                {"type": "http.response.body", "body": outgoing[:5], "more_body": True}
            )
            await send(
                {"type": "http.response.body", "body": outgoing[5:], "more_body": False}
            )

        wrapper = recorder.RagCaptureApp(app, path)
        await wrapper(
            {
                "type": "http",
                "path": recorder.PREFIX + "chunks",
                "headers": [
                    (b"traceparent", b"00-" + b"a" * 32 + b"-" + b"b" * 16 + b"-01")
                ],
            },
            receive,
            send,
        )
        assert b"".join(item.get("body", b"") for item in sent) == outgoing

    source = json.loads(capture.SOURCE.read_bytes())["content"]
    path = tmp_path / "wire.jsonl"
    asyncio.run(run({"chunks": chunks_for(source)}, path))
    assert json.loads(path.read_text())["request"]["chunks"] == chunks_for(source)
    before = path.read_bytes()
    asyncio.run(
        run(
            {"chunks": [{"documentId": recorder.PROGRAM, "text": "user private data"}]},
            path,
        )
    )
    assert path.read_bytes() == before


def test_source_update_refuses_foreign_existing_snapshot():
    calls = []

    def sql(service, statement):
        calls.append(statement)
        return "unexpected-source-hash"

    with pytest.raises(AssertionError, match="unexpected source"):
        capture.replace_owned_source(sql, "synthetic", "a" * 64)
    assert len(calls) == 1 and calls[0].startswith("SELECT")


def test_real_ai_capture_separates_retrieval_citations_failures_and_new_source_ids(
    trace_environment, monkeypatch, tmp_path
):
    settings, exporter = trace_environment
    monkeypatch.setenv("CORE_TRACE_FIXTURE", "true")
    stub.TRACE_COUNTS.clear()
    server = ThreadingHTTPServer(("127.0.0.1", 0), stub.Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("OPENAI_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1")
    monkeypatch.setattr(
        "app.bootstrap.AsyncQdrantClient",
        lambda **kwargs: AsyncQdrantClient(location=":memory:"),
    )
    source = json.loads(capture.SOURCE.read_bytes())
    app = create_app(
        settings=replace(
            OPENAI_SETTINGS, langfuse=settings, openai_embedding_dimensions=3
        )
    )
    path = tmp_path / "wire.jsonl"
    path.write_text(json.dumps({"execution": metadata()}) + "\n")
    nonce = uuid4().hex
    replay = []
    try:
        with TestClient(recorder.RagCaptureApp(app, path)) as client:
            old_ids = set()
            for version, content, scenarios in [
                ("v1", source["content"], capture.SCENARIOS),
                ("v2", source["updatedContent"], ("ok",)),
            ]:
                chunks = chunks_for(content)
                cases, observations = [], []
                directory = tmp_path / version
                directory.mkdir()
                for scenario in scenarios:
                    tid = uuid4().hex
                    question = f"PRIVATE-RAG-QUERY-{nonce}-{'ok' if scenario == 'hit' else scenario}"
                    case = {
                        "id": scenario,
                        "documentId": recorder.PROGRAM,
                        "question": question,
                        "expectedStatus": "INSUFFICIENT_EVIDENCE"
                        if scenario == "insufficient"
                        else "ANSWERED",
                        "expectedEvidence": [],
                    }
                    cases.append(case)
                    headers = {"traceparent": f"00-{tid}-{'1' * 16}-01"}
                    assert (
                        client.put(
                            recorder.PREFIX + "chunks",
                            json={"chunks": chunks},
                            headers=headers,
                        ).status_code
                        == 200
                    )
                    search = client.post(
                        recorder.PREFIX + "search",
                        json=capture.rag.search_request(case, {"chunks": chunks}),
                        headers=headers,
                    )
                    body, code = {"code": "AI_SERVICE_UNAVAILABLE"}, 503
                    if search.status_code == 200:
                        by_id = {chunk["id"]: chunk for chunk in chunks}
                        retrieved = [
                            {
                                k: v
                                for k, v in by_id[match["id"]].items()
                                if k != "contentHash"
                            }
                            for match in search.json()["matches"]
                        ]
                        answer = client.post(
                            recorder.PREFIX + "answers",
                            json={"question": question, "chunks": retrieved},
                            headers=headers,
                        )
                        if answer.status_code == 200:
                            code, result = 200, answer.json()
                            body = {
                                "answer": result["answer"],
                                "answerStatus": result["answerStatus"],
                                "citations": [
                                    {
                                        "excerpt": by_id[cid]["text"],
                                        "sourceUrl": "https://example.invalid/fixture",
                                        "sourceLabel": "기업마당 상세 본문",
                                        "chunkOrder": by_id[cid]["order"],
                                    }
                                    for cid in result["citationChunkIds"]
                                ],
                            }
                    wire = [json.loads(line) for line in path.read_text().splitlines()][
                        1:
                    ]
                    calls = [row for row in wire if row["traceId"] == tid]
                    replay.append((version, scenario, question, tid, code, body, calls))
                    observations.append(
                        capture.observation(
                            scenario, tid, content, chunks, calls, code, body
                        )
                    )
                fixture = capture.fixture_for(
                    content, chunks, cases, "https://example.invalid/fixture", version
                )
                capture.write(directory / "fixture.json", fixture)
                record = {
                    "schemaVersion": "support-program-rag-capture-v2",
                    "scope": capture.rag.SCOPE,
                    "fixtureSha256": capture.rag.digest(
                        (directory / "fixture.json").read_bytes()
                    ),
                    "execution": metadata(),
                    "cases": observations,
                }
                capture.write(directory / "capture.json", record)
                report = capture.rag.evaluate(
                    directory / "fixture.json", directory / "capture.json"
                )
                rows = {row["caseId"]: row for row in report["cases"]}
                assert (
                    rows["ok"]["retrievalRecallAtK"]
                    == rows["ok"]["answerCitationRecall"]
                    == 1
                )
                assert (
                    report["measurementKind"] == "integration-stub-replay"
                    and not report["baselineEligible"]
                )
                if version == "v1":
                    assert (
                        rows["hit"]["retrievalResultSha256"]
                        == rows["ok"]["retrievalResultSha256"]
                    )
                    assert (
                        rows["miss"]["retrievalRecallAtK"]
                        == rows["miss"]["answerCitationRecall"]
                        == 0
                    )
                    assert (
                        rows["citation-miss"]["retrievalRecallAtK"] == 1
                        and rows["citation-miss"]["answerCitationRecall"] == 0.5
                    )
                    assert (
                        rows["insufficient"]["answerStatusMatches"]
                        and rows["insufficient"]["answerCitationRecall"] is None
                    )
                    assert rows["search-fail"]["retrievalRecallAtK"] is None
                    assert all(
                        rows[name]["retrievalRecallAtK"] == 1
                        and rows[name]["answerCitationRecall"] is None
                        for name in ("fail", "timeout", "invalid-citation")
                    )
                    assert report["coverage"]["failedCaseCount"] == 4
                assert not old_ids.intersection(chunk["id"] for chunk in chunks)
                old_ids = {chunk["id"] for chunk in chunks}
        assert exporter.get_finished_spans()
        # Source refresh changes eligible chunk IDs but can legitimately reuse the question embedding.
        assert stub.TRACE_COUNTS[f"PRIVATE-RAG-QUERY-{nonce}-ok"] == {
            "embedding": 1,
            "answer": 3,
        }
        verify_driver_replays_actual_ai_records(monkeypatch, tmp_path, nonce, replay)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def verify_driver_replays_actual_ai_records(monkeypatch, tmp_path, nonce, replay):
    # Core HTTP and Langfuse are controlled here; the full JVM/MySQL/readback path is a CI check.
    monkeypatch.setattr(
        capture.uuid, "uuid4", lambda: type("Nonce", (), {"hex": nonce})()
    )
    updates = []
    monkeypatch.setattr(
        capture,
        "replace_owned_source",
        lambda sql, content, previous: updates.append((content, previous)),
    )
    program = {
        "id": "PBLN_COMPOSE_EXPORT",
        "sourceCode": "BIZINFO",
        "sourceUrl": "https://example.invalid/fixture",
    }
    for partial in (False, True):
        logs, wire, spans = [], [{"execution": metadata()}], []
        sequence = iter(replay)

        def post(
            url,
            question,
            sequence=sequence,
            partial=partial,
            logs=logs,
            wire=wire,
            spans=spans,
        ):
            version, scenario, expected_question, tid, code, body, calls = next(
                sequence
            )
            assert question == expected_question
            if partial and scenario == "hit":
                raise OSError("injected Core disconnect")
            logs.append("support_program_evidence trace_id=" + tid)
            wire.extend(calls)
            base = (
                scenario
                if scenario
                in {"ok", "hit", "fail", "timeout", "invalid-citation", "search-fail"}
                else "hit"
            )
            spans[:] = documents(base, tid, query_cache="hit" if version == "v2" or scenario == "hit" else "miss")
            for span in spans:
                if span["name"] == "evidence.core.chunk":
                    span["metadata"]["chunk_count"] = 6
                if span["name"] == "evidence.index":
                    span["metadata"]["missing_count"] = 6 if base == "ok" else 0
                if span["name"] == "evidence.search" and scenario != "search-fail":
                    span["metadata"]["embedding_cache_state"] = (
                        "hit" if version == "v2" or scenario == "hit" else "miss"
                    )
            return code, body

        monkeypatch.setattr(capture.trace, "post_question", post)
        monkeypatch.setattr(
            capture, "read_observations", lambda env, tid, spans=spans: spans
        )
        output = tmp_path / ("driver-partial" if partial else "driver-complete")
        args = {
            "core_url": "http://core.invalid",
            "environment": {"LANGFUSE_SECRET_KEY": "sk-local"},
            "core_logs": lambda logs=logs: "\n".join(logs),
            "read_wire": lambda wire=wire: "\n".join(json.dumps(row) for row in wire),
            "sql": None,
            "program": program,
            "output": output,
        }
        if partial:
            with pytest.raises(OSError, match="disconnect"):
                capture.verify_rag_capture(**args)
            saved = json.loads((output / "v1/capture.json").read_bytes())
            assert saved["cases"][0]["failure"] is None
            assert all(
                row["failure"]["stage"] == "not_started" for row in saved["cases"][1:]
            )
            assert (
                json.loads((output / "integration.json").read_bytes())["status"]
                == "failed"
            )
            assert (
                json.loads((output / "v1/wire.json").read_bytes())["status"] == "failed"
            )
            assert not (output / "v1/budget-plan.json").exists()
        else:
            capture.verify_rag_capture(**args)
            from core_rag_budget import load_plan

            for version, count in (("v1", 9), ("v2", 1)):
                plan = load_plan(output / version)
                assert len(plan["executionSpec"]["rag_cases"]) == count
                assert len(plan["executionSpec"]["model_operations"]) == count * 3
                assert not plan["reservationCreated"] and not plan["baselineEligible"]
            assert (
                load_plan(output / "v1")["executionSpec"]["rag_cases"][0]["chunks"]
                != load_plan(output / "v2")["executionSpec"]["rag_cases"][0]["chunks"]
            )
            aggregate = json.loads((output / "integration.json").read_bytes())
            assert aggregate["status"] == "passed" and len(aggregate["versions"]) == 2
            assert (
                json.loads((output / "v1/report.json").read_bytes())["coverage"][
                    "failedCaseCount"
                ]
                == 4
            )
            assert (
                json.loads((output / "v2/report.json").read_bytes())["cases"][0][
                    "retrievalRecallAtK"
                ]
                == 1
            )
    assert len(updates) == 3


@pytest.mark.parametrize(
    "mutate",
    [
        lambda row: row.update(schemaVersion="support-program-rag-capture-v1"),
        lambda row: row["execution"].update(kind="recorded"),
        lambda row: row["execution"].update(paidModelApiCalls=1),
        lambda row: row["execution"].update(paidModelApiCalls=False),
    ],
)
def test_integration_provenance_cannot_be_silently_changed(tmp_path, mutate):
    fixture_path = capture.EVIDENCE / "rag-fixture.json"
    value = json.loads((capture.EVIDENCE / "rag-synthetic-capture.json").read_bytes())
    value.update(schemaVersion="support-program-rag-capture-v2", execution=metadata())
    mutate(value)
    path = tmp_path / "capture.json"
    capture.write(path, value)
    with pytest.raises(ValueError):
        capture.rag.evaluate(fixture_path, path)
