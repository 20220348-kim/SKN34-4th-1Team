"""신규 회귀 자료의 정합성만 검증한다. 실제 모델의 의미 품질은 평가하지 않는다."""

import importlib.util
import json
from pathlib import Path
import re

import pytest


HERE = Path(__file__).resolve().parent
FIXTURE_PATH = HERE / "target-coverage-fixture.json"
spec = importlib.util.spec_from_file_location("target_coverage_evaluate", HERE / "evaluate.py")
evaluate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluate)


@pytest.fixture
def loaded():
    return evaluate.load_fixture(FIXTURE_PATH)


def test_fixture_reuses_existing_schema_and_discloses_synthetic_references(loaded):
    fixture, prepared, fixture_hash = loaded
    assert fixture["dataType"] == "synthetic"
    assert fixture["referenceSource"] == "ai-authored"
    assert len(fixture["documents"]) == 3
    assert len(prepared) == 6
    assert [case["id"] for case, _ in prepared] == [f"TC{index:02d}" for index in range(1, 7)]
    assert len({case["category"] for case, _ in prepared}) == 6
    assert all(2 <= len(document["chunks"]) <= 3 for document in fixture["documents"])
    assert all("가상 공고" in document["title"] for document in fixture["documents"])
    assert all("실제 기업마당 공고가 아닙니다" in document["chunks"][0]["text"]
               for document in fixture["documents"])
    assert fixture_hash == evaluate.digest(FIXTURE_PATH.read_bytes())


@pytest.mark.parametrize("case_index", range(6))
def test_reference_statements_quote_their_provided_source_chunks(loaded, case_index):
    case, request = loaded[1][case_index]
    reference_orders = set()
    for field in ("referenceFacts", "forbiddenClaims"):
        for statement in case[field]:
            # Only reference provenance is checked, never an answer's word overlap or truth.
            match = re.fullmatch(r"\[청크 (\d+)\] 「([^」]+)」 → (.+)", statement)
            assert match is not None, statement
            order = int(match[1])
            assert order in range(len(request.chunks))
            assert match[2] in request.chunks[order].text
            if field == "referenceFacts":
                reference_orders.add(order)
    if case["expectedStatus"] == "ANSWERED":
        assert set(case["expectedCitationOrders"]) == reference_orders
    else:
        # The source can explain why information is missing; insufficient answers cite no IDs.
        assert case["expectedCitationOrders"] == []
        assert reference_orders == {2}


def test_fixture_has_four_multi_chunk_answers_and_two_missing_information_cases(loaded):
    _, prepared, _ = loaded
    answered = [case for case, _ in prepared if case["expectedStatus"] == "ANSWERED"]
    missing = [case for case, _ in prepared if case["expectedStatus"] == "INSUFFICIENT_EVIDENCE"]
    assert [case["id"] for case in answered] == ["TC01", "TC03", "TC04", "TC05"]
    assert all(case["expectedCitationOrders"] == [0, 1] for case in answered)
    assert [case["id"] for case in missing] == ["TC02", "TC06"]
    assert all({chunk.document_id for chunk in request.chunks} == {case["documentId"]}
               for case, request in prepared)


def test_unexecuted_report_keeps_all_quality_metrics_unmeasured(loaded):
    result = evaluate.report(*loaded)
    assert result["scope"] == "fixed-answer-context-only"
    assert result["caseCount"] == result["maxApiCallsOnExecute"] == 6
    assert result["observedCaseCount"] == 0
    assert result["cases"] == []
    assert result["measured"] is result["completed"] is False
    for metric in ("statusAccuracy", "referenceCitationRecall", "semanticFaithfulness"):
        assert result[metric] is None
    assert result["semanticReviewRequired"] is True


def test_cli_accepts_new_fixture_without_model_calls_or_artifacts(monkeypatch, capsys, tmp_path):
    def forbidden(*args, **kwargs):
        pytest.fail("fixture inspection must not invoke the model")

    monkeypatch.setattr(evaluate, "execute", forbidden)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(evaluate.sys, "argv", ["evaluate.py", "--fixture", str(FIXTURE_PATH)])
    assert evaluate.main() == 0
    result = json.loads(capsys.readouterr().out)
    assert result["selectedCaseIds"] == [f"TC{index:02d}" for index in range(1, 7)]
    assert result["measured"] is False
    assert list(tmp_path.iterdir()) == []


def test_existing_case_selection_preserves_new_request_ids_and_hashes(loaded):
    _, prepared, _ = loaded
    selected = evaluate.select_cases(prepared, ["TC01", "TC06"])
    assert [case["id"] for case, _ in selected] == ["TC01", "TC06"]
    _, reloaded, _ = evaluate.load_fixture(FIXTURE_PATH)
    assert [evaluate.request_digest(request) for _, request in prepared] == [
        evaluate.request_digest(request) for _, request in reloaded
    ]


def test_correct_status_and_citations_do_not_score_target_meaning(loaded):
    _, prepared, fixture_hash = loaded
    # Deliberately false test doubles exercise report compatibility, not model performance.
    capture = {
        "schemaVersion": "support-program-evidence-capture-v1",
        "fixtureSha256": fixture_hash,
        "promptSha256": "a" * 64,
        "runnerSha256": "b" * 64,
        "model": "offline-test-double-not-a-model-run",
        "modelTimeoutSeconds": 25,
        "runTimeoutSeconds": 30,
        "completed": True,
        "cases": [{
            "caseId": case["id"],
            "requestSha256": evaluate.request_digest(request),
            "outcome": "success",
            "response": {
                "answer": "지역·업종·기업 규모와 관계없이 누구나 신청할 수 있습니다.",
                "answerStatus": case["expectedStatus"],
                "citationChunkIds": [request.chunks[order].id for order in case["expectedCitationOrders"]],
            },
        } for case, request in prepared],
    }
    result = evaluate.report(*loaded, capture)
    assert result["statusAccuracy"] == result["referenceCitationRecall"] == 1
    assert result["semanticFaithfulness"] is None
    assert result["semanticReviewRequired"] is True
    assert result["cases"][0]["referenceFacts"] == prepared[0][0]["referenceFacts"]
    assert result["cases"][0]["forbiddenClaims"] == prepared[0][0]["forbiddenClaims"]
