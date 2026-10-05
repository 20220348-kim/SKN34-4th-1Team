"""판정 경계 회귀 자료의 출처·계약 검사. 실제 모델 품질 검사가 아니다."""

import json
from pathlib import Path
import re

import pytest

import evaluate


FIXTURE_PATH = Path(__file__).with_name("answerability-fixture.json")


@pytest.fixture
def loaded():
    return evaluate.load_fixture(FIXTURE_PATH)


def test_same_evidence_requires_different_status_for_different_questions(loaded):
    fixture, prepared, _ = loaded
    assert fixture["dataType"] == "synthetic"
    assert fixture["referenceSource"] == "ai-authored"
    assert [case["id"] for case, _ in prepared] == [f"AB{index:02d}" for index in range(1, 6)]
    assert prepared[0][1].chunks == prepared[1][1].chunks == prepared[2][1].chunks
    assert prepared[3][1].chunks == prepared[4][1].chunks
    assert [case["expectedStatus"] for case, _ in prepared] == [
        "ANSWERED", "INSUFFICIENT_EVIDENCE", "INSUFFICIENT_EVIDENCE",
        "ANSWERED", "INSUFFICIENT_EVIDENCE",
    ]
    assert all("실제 기업마당 공고가 아닙니다" in request.chunks[0].text
               for _, request in prepared)


@pytest.mark.parametrize("index", range(5))
def test_reference_quotes_exist_in_provided_chunks(loaded, index):
    case, request = loaded[1][index]
    for statement in case["referenceFacts"] + case["forbiddenClaims"]:
        match = re.fullmatch(r"\[청크 (\d+)\] 「([^」]+)」 → (.+)", statement)
        assert match is not None, statement
        assert match[2] in request.chunks[int(match[1])].text
    if case["id"] == "AB03":
        assert "12페이지 4번" in " ".join(case["referenceFacts"])


def test_cli_inspection_never_generates_answers_or_claims_measured_quality(monkeypatch, capsys, tmp_path):
    def forbidden(*args, **kwargs):
        pytest.fail("fixture inspection must not invoke the model")

    monkeypatch.setattr(evaluate, "execute", forbidden)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(evaluate.sys, "argv", ["evaluate.py", "--fixture", str(FIXTURE_PATH)])
    assert evaluate.main() == 0
    result = json.loads(capsys.readouterr().out)
    assert result["caseCount"] == result["maxApiCallsOnExecute"] == 5
    assert result["measured"] is result["completed"] is False
    assert result["statusAccuracy"] is result["semanticFaithfulness"] is None
    assert result["semanticReviewRequired"] is True
    assert list(tmp_path.iterdir()) == []


def test_valid_citation_does_not_make_partial_answer_status_correct(loaded):
    # Reproduce H03's failure pattern as an explicit test double, not a recorded model run.
    case, request = loaded[1][1]
    capture = {
        "schemaVersion": "support-program-evidence-capture-v1",
        "fixtureSha256": loaded[2],
        "caseIds": [case["id"]],
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
                "answer": "전액 지원하지만 정확한 금액은 명시되지 않았습니다.",
                "answerStatus": "ANSWERED",
                "citationChunkIds": [request.chunks[0].id],
            },
        }],
    }
    result = evaluate.report(*loaded, capture)
    assert result["statusAccuracy"] == 0
    assert result["cases"][0]["statusMatches"] is False
    assert result["semanticFaithfulness"] is None
    assert result["semanticReviewRequired"] is True
