"""예산 준비 입력 변조·부분 수집을 무료로 검증한다. 여기의 Core wire는 테스트 대역이다."""

import json
import subprocess
import sys
from copy import deepcopy

import core_rag_budget as planner
import core_rag_capture as collector
import pytest


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


@pytest.fixture
def completed_capture(tmp_path):
    directory = tmp_path / "v1"
    directory.mkdir()
    fixture, _ = planner.rag.read_json(collector.EVIDENCE / "rag-fixture.json")
    capture, _ = planner.rag.read_json(collector.EVIDENCE / "rag-synthetic-capture.json")
    for document in fixture["documents"]:
        document["chunkVersion"] = "core-sha256:" + planner.rag.digest(
            collector.CHUNKER.read_bytes()
        )
    save(directory / "fixture.json", fixture)
    capture.update(
        schemaVersion="support-program-rag-capture-v2",
        fixtureSha256=planner.rag.digest((directory / "fixture.json").read_bytes()),
        execution={
            "kind": "integration-stub",
            "model": "test-model",
            "embeddingModel": "text-embedding-3-small",
            "promptSha256": "a" * 64,
            "recorderSha256": "b" * 64,
            "paidModelApiCalls": 0,
        },
    )
    documents = {d["documentId"]: d for d in fixture["documents"]}
    wire = {"version": "v1", "status": "passed", "cases": []}
    for index, (case, observed) in enumerate(zip(fixture["cases"], capture["cases"], strict=True)):
        observed["traceId"] = f"{index + 1:032x}"
        doc = documents[case["documentId"]]
        chunks = {c["id"]: c for c in doc["chunks"]}
        answer = observed["answer"]["response"]
        calls = [
            {
                "operation": "chunks",
                "request": {"chunks": doc["chunks"]},
                "response": {"indexedCount": len(chunks)},
            }
        ]
        calls.extend(
            {"operation": operation, **observed[name]}
            for operation, name in (("search", "search"), ("answers", "answer"))
        )
        for call in calls:
            call.update(status=200, traceId=observed["traceId"])
        wire["cases"].append(
            {
                "id": case["id"],
                "traceId": observed["traceId"],
                "publicStatus": 200,
                "publicResponse": {
                    "answer": answer["answer"],
                    "answerStatus": answer["answerStatus"],
                    "citations": [
                        {
                            "excerpt": chunks[c]["text"],
                            "chunkOrder": chunks[c]["order"],
                            "sourceUrl": doc["sourceUrl"],
                            "sourceLabel": "기업마당 상세 본문",
                        }
                        for c in answer["citationChunkIds"]
                    ],
                },
                "aiCalls": calls,
            }
        )
    save(directory / "capture.json", capture)
    save(directory / "wire.json", wire)
    save(
        tmp_path / "integration.json",
        {
            "status": "passed",
            "paid_model_api_calls": 0,
            "versions": [wire],
        },
    )
    return directory


def test_plan_preserves_input_order_and_is_accepted_by_existing_guard(
    completed_capture, monkeypatch
):
    from uuid import uuid4

    from budget_client import BudgetClient
    from rag_budget import RagBudget

    plan = planner.prepare(completed_capture)
    fixture, _ = planner.rag.read_json(completed_capture / "fixture.json")
    spec = plan["executionSpec"]
    assert [c["case_id"] for c in spec["rag_cases"]] == [c["id"] for c in fixture["cases"]]
    assert [c["question"] for c in spec["rag_cases"]] == [c["question"] for c in fixture["cases"]]
    assert spec["rag_cases"][0]["chunks"] == fixture["documents"][0]["chunks"]
    assert spec["rag_cases"][0]["limit"] == 5
    assert len(spec["model_operations"]) == 9
    assert plan["baselineEligible"] is plan["reservationCreated"] is False
    assert plan["paidModelApiCalls"] == 0
    monkeypatch.setenv("LLMOPS_BUDGET_TOKEN", "test-only-" + "a" * 40)
    client = BudgetClient(str(uuid4()), str(uuid4()), plan["executionSpecSha256"])
    assert RagBudget(client, spec, receipt_directory=completed_capture).spec == spec
    assert planner.load_plan(completed_capture) == plan
    worker = subprocess.run(
        [
            sys.executable,
            str(planner.ROOT / "infrastructure/llmops/rag_budget_http_worker.py"),
            "core-spec",
        ],
        input=json.dumps({"directory": str(completed_capture)}),
        text=True,
        capture_output=True,
        check=True,
        timeout=30,
    )
    assert json.loads(worker.stdout) == spec
    with pytest.raises(FileExistsError):
        planner.prepare(completed_capture)


@pytest.mark.parametrize(
    "change", ["question", "source", "order", "chunker", "wire", "source-url", "partial", "paid"]
)
def test_invalid_inputs_never_produce_a_plan(completed_capture, change):
    fixture, _ = planner.rag.read_json(completed_capture / "fixture.json")
    wire, _ = planner.rag.read_json(completed_capture / "wire.json")
    integration, _ = planner.rag.read_json(completed_capture.parent / "integration.json")
    if change == "question":
        fixture["cases"][0]["question"] = "변경한 질문"
    elif change == "source":
        fixture["documents"][0]["chunks"][0]["text"] = "다른 원문"
    elif change == "order":
        fixture["cases"].reverse()
    elif change == "chunker":
        fixture["documents"][0]["chunkVersion"] = "core-sha256:" + "0" * 64
    elif change == "wire":
        wire["cases"][0]["aiCalls"][0]["request"]["chunks"][0]["text"] = "바뀐 wire"
        integration["versions"] = [wire]
    elif change == "source-url":
        wire["cases"][0]["publicResponse"]["citations"][0]["sourceUrl"] = "https://wrong.invalid"
        integration["versions"] = [wire]
    elif change == "partial":
        integration["status"] = "failed"
    elif change == "paid":
        integration["paid_model_api_calls"] = 1
    save(completed_capture / "fixture.json", fixture)
    # Updating the byte hash alone must not evade contract/source/wire validation.
    capture, _ = planner.rag.read_json(completed_capture / "capture.json")
    capture["fixtureSha256"] = planner.rag.digest((completed_capture / "fixture.json").read_bytes())
    save(completed_capture / "capture.json", capture)
    save(completed_capture / "wire.json", wire)
    save(completed_capture.parent / "integration.json", integration)
    with pytest.raises((ValueError, AssertionError)):
        planner.prepare(completed_capture)
    assert not (completed_capture / planner.PLAN_NAME).exists()


@pytest.mark.parametrize(
    "change", ["plan", "plan-type", "capture-bytes", "runtime", "duplicate-key"]
)
def test_consumer_rechecks_source_and_runtime_before_using_plan(
    completed_capture, monkeypatch, change
):
    plan = planner.prepare(completed_capture)
    path = completed_capture / planner.PLAN_NAME
    if change == "plan":
        plan["executionSpec"]["model_operations"][0]["max_input_tokens"] += 1
        plan["executionSpecSha256"] = planner.digest(plan["executionSpec"])
        save(path, plan)
    elif change == "plan-type":
        plan["baselineEligible"] = 0
        save(path, plan)
    elif change == "capture-bytes":
        with (completed_capture / "capture.json").open("a") as target:
            target.write("\n")
    elif change == "runtime":
        make = planner.make_rag_spec

        def changed(cases):
            spec = deepcopy(make(cases))
            spec["runtime_sha256"]["evaluation/support-program-evidence/rag_budget.py"] = "0" * 64
            return spec

        monkeypatch.setattr(planner, "make_rag_spec", changed)
    else:
        path.write_text('{"schemaVersion":"a","schemaVersion":"b"}')
    with pytest.raises(ValueError):
        planner.load_plan(completed_capture)


@pytest.mark.parametrize("change", ["spec", "hash", "spec-type"])
def test_worker_rejects_plan_mismatch_before_ops_or_model_call(completed_capture, change):
    plan = planner.prepare(completed_capture)
    config = {
        "core_capture_directory": str(completed_capture),
        "spec": plan["executionSpec"],
        "spec_hash": plan["executionSpecSha256"],
        # Deliberately no Ops URL/credentials: rejection must precede connection setup.
    }
    if change == "hash":
        config["spec_hash"] = "0" * 64
    elif change == "spec-type":
        config["spec"]["live_config"]["max_output_tokens"] = 2000.0
    else:
        config["spec"]["rag_cases"][0]["question"] = "다른 질문"
    result = subprocess.run(
        [
            sys.executable,
            str(planner.ROOT / "infrastructure/llmops/rag_budget_http_worker.py"),
            "run",
        ],
        input=json.dumps(config),
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    assert result.returncode != 0
    assert "Core budget plan differs from the reserved execution" in result.stderr
