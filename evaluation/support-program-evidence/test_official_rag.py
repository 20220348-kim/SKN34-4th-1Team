"""공식 원문 보존과 검색 누락·미실행 표시를 무료로 검증한다."""

import json
import sys

import pytest

import official_rag
import rag_evaluate as rag

sys.path.insert(0, str(official_rag.HERE.parents[1] / "backend/ops-service"))

from apps.evaluations.rag_material import material_from_sources
from apps.evaluations.catalog import live_config, public_datasets
from apps.evaluations.execution_spec import read_release


def test_preparation_preserves_official_sources_questions_and_existing_seed():
    fixture, pending = official_rag.build()
    assert (official_rag.OUTPUT / "fixture.json").read_bytes() == official_rag.encoded(fixture)
    assert (official_rag.OUTPUT / "not-started.json").read_bytes() == official_rag.encoded(pending)
    original = json.loads(official_rag.SOURCE.read_bytes())
    assert fixture["dataType"] == "official-html-snapshot"
    assert fixture["referenceSource"] == "ai-authored-not-human-reviewed"
    for doc, source in zip(fixture["documents"], original["documents"], strict=True):
        assert doc["content"] == source["source"]["content"]
        assert doc["contentHash"] == source["source"]["contentSha256"]
        assert len(doc["chunks"]) > 5
        assert "not-core-chunker" in doc["chunkVersion"]
        assert doc["source"]["collectedAt"] == source["source"]["collectedAt"]
    for case, original_case in zip(fixture["cases"], original["cases"], strict=True):
        assert all(case[key] == original_case[key] for key in ("id", "question", "expectedStatus"))
    seed = json.loads((official_rag.HERE.parents[1] / "backend/ops-service/apps/evaluations/seed/official-v3/seed.json").read_bytes())
    assert seed["source_run_id"] == "628ae52a-f417-4b53-b400-d90405e6a7d8"
    assert official_rag.DATASET not in json.dumps(seed)


def test_first_reference_is_unmeasured_and_not_a_quality_baseline():
    fixture, pending = official_rag.build()
    result = rag.evaluate(official_rag.OUTPUT / "fixture.json", official_rag.OUTPUT / "not-started.json")
    assert result["captureValidated"] and not result["completed"]
    assert not result["baselineEligible"] and not result["liveExecutionPerformed"]
    assert all(m["value"] is None and m["measuredCaseCount"] == 0 for m in result["metrics"].values())
    assert result["metrics"]["retrievalRecallAtK"]["eligibleCaseCount"] == 2
    assert all(c["failure"]["stage"] == "not_started" for c in result["cases"])
    material = material_from_sources(fixture, pending, pending, {
        "scope": rag.SCOPE, "case_ids": [c["id"] for c in fixture["cases"]],
        "current": result, "reference": result,
    })
    assert material["data_type"] == "official-html-snapshot"
    assert all(c["candidate"]["answer"] is None for c in material["cases"])
    assert material["cases"][0]["source_collected_at"] == fixture["documents"][0]["source"]["collectedAt"]


@pytest.mark.parametrize("mutation", ["version", "human-review", "host", "hash", "time", "scope", "source-id"])
def test_invalid_provenance_or_inherited_approval_is_rejected(mutation):
    fixture, _ = official_rag.build()
    doc = fixture["documents"][0]
    if mutation == "version":
        fixture["schemaVersion"] = "support-program-rag-fixture-v1"
    elif mutation == "human-review":
        fixture["referenceSource"] = "human-reviewed"
    elif mutation == "host":
        doc["sourceUrl"] = "https://example.com/forged"
    elif mutation == "hash":
        doc["source"]["htmlSha256"] = "invalid"
    elif mutation == "time":
        doc["source"]["collectedAt"] = "2026-10-06"
    elif mutation == "scope":
        doc["source"]["scope"] = "attachments-included"
    else:
        doc["source"]["sourceProgramId"] = "PBLN_1"
    with pytest.raises(ValueError):
        rag.validate_fixture(fixture)


def test_recorded_search_with_missing_evidence_is_not_full_recall(tmp_path):
    fixture, capture = official_rag.build()
    doc, case = fixture["documents"][0], fixture["cases"][0]
    # 정상 검색 응답이 있어도 정답 근거가 빠진 경우를 측정한다. 답변은 미실행이다.
    expected = {e["chunkId"] for e in case["expectedEvidence"]}
    found = [c for c in doc["chunks"] if c["id"] not in expected][:5]
    capture["cases"][0].update(
        sourceContentHash=doc["contentHash"], chunksSha256=rag.json_digest(doc["chunks"]),
        indexedCount=len(doc["chunks"]),
        search={"request": rag.search_request(case, doc), "response": {
            "question": case["question"], "matches": [{
                **{k: chunk[k] for k in ("id", "documentId", "order", "contentHash")}, "score": 1.0 - rank / 10,
            } for rank, chunk in enumerate(found)],
        }},
        answer={"request": {"question": case["question"], "chunks": [
            {k: chunk[k] for k in ("id", "documentId", "order", "text")} for chunk in found
        ]}, "response": None}, failure={"stage": "answer", "code": "NOT_EXECUTED"},
    )
    path = tmp_path / "capture.json"
    path.write_bytes(official_rag.encoded(capture))
    report = rag.evaluate(official_rag.OUTPUT / "fixture.json", path)
    assert report["cases"][0]["retrievalRecallAtK"] == 0
    assert report["cases"][0]["answerCitationRecall"] is None
    assert not report["completed"]


def test_catalog_prepares_separate_embedding_and_answer_budget():
    config = live_config(official_rag.DATASET)
    plan = read_release()["datasets"][official_rag.DATASET]["live_plan"]
    assert config["max_model_calls"] == 18
    assert config["max_total_output_tokens"] == 12000
    assert [op["kind"] for op in plan["model_operations"]] == [
        "document_embedding", "query_embedding", "answer"
    ] * 6
    selected = next(d for d in public_datasets() if d["id"] == official_rag.DATASET)
    assert selected["evaluation_scope"] == rag.SCOPE
    assert selected["captures"][0]["id"] == "official-rag-not-started-v1"
