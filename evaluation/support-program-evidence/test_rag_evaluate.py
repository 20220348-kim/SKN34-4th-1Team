"""다중 청크 RAG 계약·측정 분리·실패 보존을 모델 호출 없이 검증한다."""

import importlib.util
import json
import socket
from copy import deepcopy
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("rag_evaluate", HERE / "rag_evaluate.py")
rag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rag)
FIXTURE = HERE / "rag-fixture.json"
CAPTURE = HERE / "rag-synthetic-capture.json"


@pytest.fixture
def records():
    return rag.read_json(FIXTURE)[0], rag.read_json(CAPTURE)[0]


def evaluate_copy(tmp_path, fixture, capture):
    fixture_path, capture_path = tmp_path / "fixture.json", tmp_path / "capture.json"
    fixture_path.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")
    capture["fixtureSha256"] = rag.digest(fixture_path.read_bytes())
    capture_path.write_text(json.dumps(capture, ensure_ascii=False), encoding="utf-8")
    return rag.evaluate(fixture_path, capture_path)


def fail_at(observation, stage):
    observation["failure"] = {"stage": stage, "code": "test_recorded_failure"}
    index = rag.STAGES.index(stage)
    if index <= 1:
        observation["sourceContentHash"] = None
    if index <= 2:
        observation["chunksSha256"] = None
    if index <= 3:
        observation["indexedCount"] = None
    if index < 4:
        observation["search"] = None
    elif index == 4:
        observation["search"]["response"] = None
    if index < 5:
        observation["answer"] = None
    else:
        observation["answer"]["response"] = None


def test_fixture_only_publishes_no_measurement():
    report = rag.evaluate(FIXTURE)
    assert not report["captureValidated"] and not report["completed"]
    assert report["measurementKind"] == "fixture-validation-only"
    assert all(
        metric["value"] is None and metric["measuredCaseCount"] == 0
        for metric in report["metrics"].values()
    )
    assert report["metrics"]["retrievalRecallAtK"]["eligibleCaseCount"] == 2


def test_retrieval_and_citation_omissions_are_scored_separately():
    report = rag.evaluate(FIXTURE, CAPTURE)
    complete_search, missed_search, unanswerable = report["cases"]
    assert complete_search["retrievalRecallAtK"] == 1
    assert complete_search["answerCitationRecall"] == 0.5
    assert (
        missed_search["retrievalRecallAtK"]
        == missed_search["answerCitationRecall"]
        == 0
    )
    assert (
        unanswerable["retrievalRecallAtK"]
        is unanswerable["answerCitationRecall"]
        is None
    )
    assert report["metrics"]["retrievalRecallAtK"] == {
        "value": 0.5,
        "measuredCaseCount": 2,
        "eligibleCaseCount": 2,
    }
    assert report["metrics"]["answerCitationRecall"]["value"] == 0.25
    assert report["metrics"]["answerStatusAccuracy"]["value"] == 1
    assert report["completed"] and report["captureValidated"]
    assert report["measurementKind"] == "synthetic-contract-check"
    assert report["semanticFaithfulness"] is None and report["semanticReviewRequired"]
    assert not report["baselineEligible"] and not report["liveExecutionPerformed"]
    assert report["coverage"]["traceCaseCount"] == 0


@pytest.mark.parametrize("stage", rag.STAGES)
def test_partial_failure_preserves_stage_and_metric_denominators(
    records, tmp_path, stage
):
    fixture, capture = records
    fail_at(capture["cases"][0], stage)
    report = evaluate_copy(tmp_path, fixture, capture)
    row = report["cases"][0]
    assert row["failure"] == {"stage": stage, "code": "test_recorded_failure"}
    assert row["retrievalRecallAtK"] == (1 if stage == "answer" else None)
    assert row["answerCitationRecall"] is row["answerStatusMatches"] is None
    assert report["metrics"]["answerCitationRecall"] == {
        "value": 0,
        "measuredCaseCount": 1,
        "eligibleCaseCount": 2,
    }
    assert report["coverage"]["failedCaseCount"] == 1
    assert report["coverage"]["answerCaseCount"] == 2
    assert not report["completed"]


def test_every_case_failed_is_unmeasured_not_zero_quality(records, tmp_path):
    fixture, capture = records
    for observation in capture["cases"]:
        fail_at(observation, "source")
    report = evaluate_copy(tmp_path, fixture, capture)
    assert report["captureValidated"] and not report["completed"]
    assert all(metric["value"] is None for metric in report["metrics"].values())
    assert report["coverage"] == {
        "retrievalCaseCount": 0,
        "answerCaseCount": 0,
        "failedCaseCount": 3,
        "traceCaseCount": 0,
    }


@pytest.mark.parametrize(
    "mutate",
    [
        lambda f: f.update(scope="fixed-answer-context-only"),
        lambda f: f.update(referenceSource="human-reviewed"),
        lambda f: f.update(dataType="real"),
        lambda f: f["documents"].append(deepcopy(f["documents"][0])),
        lambda f: f["documents"][0].update(content="원문 변경"),
        lambda f: f["documents"][0]["chunks"][0].update(text="청크 변조"),
        lambda f: f["documents"][0]["chunks"][0].update(id="a" * 64),
        lambda f: f["documents"][0]["chunks"][0].update(order=False),
        lambda f: f["documents"][0]["chunks"].reverse(),
        lambda f: f["cases"].append(deepcopy(f["cases"][0])),
        lambda f: f["cases"][0].update(question=" "),
        lambda f: f["cases"][0].update(question=" 양 끝 공백 "),
        lambda f: f["cases"][0]["expectedEvidence"][0].update(quote="원문에 없는 참조"),
        lambda f: f["cases"][0]["expectedEvidence"].append(
            deepcopy(f["cases"][0]["expectedEvidence"][0])
        ),
        lambda f: f["cases"][0]["expectedEvidence"][0].update(
            chunkId=f["documents"][1]["chunks"][0]["id"]
        ),
        lambda f: f["cases"][0].update(expectedEvidence=[]),
        lambda f: f["cases"][2].update(expectedStatus="ANSWERED"),
    ],
)
def test_rejects_ambiguous_source_chunk_and_reference_contract(records, mutate):
    fixture, _ = records
    mutate(fixture)
    with pytest.raises(ValueError):
        rag.validate_fixture(fixture)


def test_valid_hashes_cannot_hide_non_source_text(records):
    fixture, _ = records
    chunk = fixture["documents"][0]["chunks"][0]
    chunk.update(text="위조한 문장", contentHash=rag.digest("위조한 문장"))
    with pytest.raises(ValueError, match="preserve the source"):
        rag.validate_fixture(fixture)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda c: c.update(scope="fixed-answer-context-only"),
        lambda c: c["cases"].pop(),
        lambda c: c["cases"].append(deepcopy(c["cases"][0])),
        lambda c: c["cases"][1].update(caseId="R01"),
        lambda c: c["cases"][0].update(caseId="UNKNOWN"),
        lambda c: c["cases"][0].update(sourceContentHash="a" * 64),
        lambda c: c["cases"][0].update(chunksSha256="a" * 64),
        lambda c: c["cases"][0].update(indexedCount=5),
        lambda c: c["cases"][0]["search"]["request"].update(question="다른 질문"),
        lambda c: c["cases"][0]["search"]["request"].update(limit=1),
        lambda c: c["cases"][0]["search"]["request"]["eligibleChunks"].pop(),
        lambda c: c["cases"][0]["search"]["response"].update(question="다른 질문"),
        lambda c: c["cases"][0]["search"]["response"]["matches"].pop(),
        lambda c: c["cases"][0]["search"]["response"]["matches"].reverse(),
        lambda c: c["cases"][0]["search"]["response"]["matches"][1].update(
            c["cases"][0]["search"]["response"]["matches"][0]
        ),
        lambda c: c["cases"][0]["search"]["response"]["matches"][0].update(
            c["cases"][2]["search"]["response"]["matches"][0]
        ),
        lambda c: c["cases"][0]["search"]["response"]["matches"][0].update(
            contentHash="a" * 64
        ),
        lambda c: c["cases"][0]["search"]["response"]["matches"][0].update(score=True),
        lambda c: c["cases"][0]["search"]["response"]["matches"][0].update(
            score=float("nan")
        ),
        lambda c: c["cases"][0]["answer"]["request"]["chunks"][0].update(
            text="검색 원문과 다른 문장"
        ),
        lambda c: c["cases"][0]["answer"]["request"]["chunks"].reverse(),
        lambda c: c["cases"][0]["answer"]["request"]["chunks"].pop(),
        lambda c: c["cases"][0]["answer"]["response"].update(
            citationChunkIds=["a" * 64]
        ),
        lambda c: c["cases"][0]["answer"]["response"].update(
            answerStatus="INSUFFICIENT_EVIDENCE"
        ),
        lambda c: c["cases"][0]["answer"]["response"].update(answer=" "),
        lambda c: c["cases"][0].update(failure={"stage": "search", "code": "timeout"}),
        lambda c: c["cases"][0].update(failure={"stage": "other", "code": "unknown"}),
        lambda c: c["cases"][0].update(traceId="a" * 32),
        lambda c: c["execution"].update(model="claimed-model"),
        lambda c: c["execution"].update(kind="recorded"),
    ],
)
def test_rejects_inconsistent_or_tampered_capture(records, tmp_path, mutate):
    fixture, capture = records
    mutate(capture)
    with pytest.raises(ValueError):
        evaluate_copy(tmp_path, fixture, capture)


def test_unretrieved_but_same_document_citation_is_rejected(records, tmp_path):
    fixture, capture = records
    capture["cases"][0]["answer"]["response"]["citationChunkIds"] = [
        fixture["documents"][0]["chunks"][3]["id"]
    ]
    with pytest.raises(ValueError, match="outside retrieved"):
        evaluate_copy(tmp_path, fixture, capture)


def test_tied_scores_require_id_order(records, tmp_path):
    fixture, capture = records
    matches = capture["cases"][0]["search"]["response"]["matches"]
    for match in matches:
        match["score"] = 0.5
    matches.sort(key=lambda match: match["id"], reverse=True)
    with pytest.raises(ValueError, match="ranking order"):
        evaluate_copy(tmp_path, fixture, capture)


def test_recorded_trace_must_be_a_nonzero_w3c_trace_id(records, tmp_path):
    fixture, capture = records
    capture["execution"].update(
        kind="recorded",
        model="historical-model",
        embeddingModel="historical-embedding",
        promptSha256="a" * 64,
        recorderSha256="b" * 64,
    )
    capture["cases"][0]["traceId"] = "0" * 32
    with pytest.raises(ValueError, match="trace ID"):
        evaluate_copy(tmp_path, fixture, capture)


def test_fixed_context_evaluator_does_not_accept_rag_fixture():
    fixed_spec = importlib.util.spec_from_file_location(
        "fixed_evaluate_for_rag_test", HERE / "evaluate.py"
    )
    fixed = importlib.util.module_from_spec(fixed_spec)
    fixed_spec.loader.exec_module(fixed)
    with pytest.raises(ValueError, match="fixture schema"):
        fixed.load_fixture(FIXTURE)


def test_stale_capture_cannot_follow_updated_dataset_even_when_source_unchanged(
    records, tmp_path
):
    fixture, _ = records
    fixture["datasetVersion"] = "next-version"
    path = tmp_path / "fixture.json"
    path.write_text(json.dumps(fixture), encoding="utf-8")
    with pytest.raises(ValueError, match="fixture hash"):
        rag.evaluate(path, CAPTURE)


def test_capture_versions_and_supplied_trace_are_preserved_not_inferred(
    records, tmp_path
):
    fixture, capture = records
    capture["execution"].update(
        kind="recorded",
        model="historical-model",
        embeddingModel="historical-embedding",
        promptSha256="a" * 64,
        recorderSha256="b" * 64,
    )
    capture["cases"][0]["traceId"] = "0123456789abcdef0123456789abcdef"
    fail_at(capture["cases"][0], "answer")
    report = evaluate_copy(tmp_path, fixture, capture)
    assert report["execution"] == capture["execution"]
    assert report["measurementKind"] == "recorded-capture-replay"
    assert report["cases"][0]["traceId"] == capture["cases"][0]["traceId"]
    assert report["cases"][1]["traceId"] is None
    assert report["coverage"]["traceCaseCount"] == 1
    assert report["cases"][0]["retrievalResultSha256"] == rag.json_digest(
        capture["cases"][0]["search"]["response"]
    )
    assert report["cases"][0]["answerResultSha256"] is None
    assert not report["liveExecutionPerformed"] and not report["baselineEligible"]


def test_status_and_citation_integrity_do_not_claim_semantic_correctness(
    records, tmp_path
):
    fixture, capture = records
    capture["cases"][0]["answer"]["response"]["answer"] = (
        "모든 개인사업자가 신청할 수 있습니다."
    )
    report = evaluate_copy(tmp_path, fixture, capture)
    assert report["cases"][0]["answerStatusMatches"]
    assert report["semanticFaithfulness"] is None and not report["baselineEligible"]


@pytest.mark.parametrize("raw", ['{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}'])
def test_rejects_duplicate_keys_and_nonfinite_json(tmp_path, raw):
    path = tmp_path / "bad.json"
    path.write_text(raw, encoding="utf-8")
    with pytest.raises(ValueError):
        rag.read_json(path)


def test_cli_is_read_only_and_never_opens_a_network(monkeypatch, capsys):
    def forbidden(*args, **kwargs):
        pytest.fail("offline evaluator attempted network or file mutation")

    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(Path, "write_text", forbidden)
    monkeypatch.setattr(Path, "write_bytes", forbidden)
    assert rag.main(["--fixture", str(FIXTURE), "--capture", str(CAPTURE)]) == 0
    assert (
        json.loads(capsys.readouterr().out)["measurementKind"]
        == "synthetic-contract-check"
    )


def test_cli_rejects_fixed_context_capture_without_publishing_metrics(capsys):
    assert (
        rag.main(["--fixture", str(FIXTURE), "--capture", str(HERE / "fixture.json")])
        == 1
    )
    result = capsys.readouterr()
    assert result.out == "" and "failed" in result.err
