"""오프라인 캡처 재검증: 저장된 실제 기록을 읽고 변조는 메모리/임시 디렉터리에서만 만든다."""

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import socket

import pytest


HERE = Path(__file__).resolve().parent
RUN = HERE / "runs/official-flow-20260907-v1"
spec = importlib.util.spec_from_file_location("verify_evidence_flow", HERE / "verify_flow.py")
verify_flow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_flow)


@pytest.fixture
def records():
    return (json.loads((RUN / "core/capture.json").read_text(encoding="utf-8")),
            json.loads((RUN / "api/api-capture.json").read_text(encoding="utf-8")))


def test_recalculates_the_saved_official_flow_without_semantic_quality_claims(records):
    result = verify_flow.verify(*records)
    assert result["integrityVerified"] and result["completed"]
    assert result["caseCount"] == 6 and result["documentCount"] == 2
    assert result["officialApiCalls"] == {"total": 14, "documentEmbeddings": 2, "questionEmbeddings": 6, "answers": 6}
    assert result["tokens"] == {
        "answers": {"input_tokens": 6252, "output_tokens": 407, "total_tokens": 6659},
        "embeddings": {"prompt_tokens": 1418, "total_tokens": 1418}, "combinedTotal": 8077,
    }
    assert result["statusAccuracy"] == result["referenceEvidenceCoverage"] == 1.0
    assert result["semanticFaithfulness"] is None and result["semanticReviewRequired"]
    assert result["singleChunkDocumentsOnly"] and not result["apiRequestBodiesRecorded"]


@pytest.mark.parametrize("capture_path", sorted((HERE / "runs").glob("official-flow-*/core/capture.json")))
def test_all_shared_official_runs_recalculate_without_api(capture_path):
    core = json.loads(capture_path.read_text(encoding="utf-8"))
    api = json.loads((capture_path.parent.parent / "api/api-capture.json").read_text(encoding="utf-8"))
    result = verify_flow.verify(core, api)
    assert result["integrityVerified"] and result["completed"]
    assert result["caseCount"] == 6
    assert result["semanticFaithfulness"] is None


@pytest.mark.parametrize("mutate", [
    lambda c: c.update(fixtureSha256="0" * 64),
    lambda c: c["fixture"]["documents"][0]["cases"][0].update(question="임의 질문"),
    lambda c: c.update(aiTransport="http-fixture"),
    lambda c: c.update(completed=False),
    lambda c: c["cases"].pop(),
    lambda c: c["cases"].reverse(),
    lambda c: c["cases"][0].update(publicStatus=503),
    lambda c: c["cases"][0]["publicRequest"].update(question="다른 질문"),
    lambda c: c["cases"][0]["sourceDocument"].update(sourceProgramId="ANOTHER"),
    lambda c: c["cases"][0]["sourceDocument"].update(content="위조 본문", contentHash=verify_flow.digest("위조 본문")),
    lambda c: c["cases"][1]["sourceDocument"].update(fetchedAt="2026-09-07T01:00:00"),
    lambda c: c["cases"][0]["aiCalls"][0]["request"]["chunks"][0].update(text="위조 청크", contentHash=verify_flow.digest("위조 청크")),
    lambda c: c["cases"][0]["aiCalls"][0]["request"]["chunks"][0].update(id="a" * 64),
    lambda c: c["cases"][0]["aiCalls"][0]["request"]["chunks"][0].update(order=False),
    lambda c: c["cases"][0]["aiCalls"][1]["response"]["matches"][0].update(documentId="OTHER:PBLN_000000000116004"),
    lambda c: c["cases"][0]["aiCalls"][1]["response"]["matches"][0].update(score=float("nan")),
    lambda c: c["cases"][0]["aiCalls"][1]["request"]["eligibleChunks"][0].update(contentHash="0" * 64),
    lambda c: c["cases"][0]["aiCalls"][2]["request"]["chunks"][0].update(text="검색하지 않은 텍스트"),
    lambda c: c["cases"][0]["aiCalls"][2]["response"].update(citationChunkIds=["0" * 64]),
    lambda c: c["cases"][0]["aiCalls"][2]["response"].update(answerStatus="INSUFFICIENT_EVIDENCE"),
    lambda c: c["cases"][0]["publicResponse"]["citations"][0].update(excerpt="위조 인용문"),
    lambda c: c["cases"][0]["aiCalls"][1].update(operation="answers"),
])
def test_rejects_core_source_chunk_request_and_citation_tampering(records, mutate):
    core, api = records
    mutate(core)
    with pytest.raises(ValueError):
        verify_flow.verify(core, api)


@pytest.mark.parametrize("mutate", [
    lambda a: a["calls"].pop(),
    lambda a: a["calls"].append(deepcopy(a["calls"][-1])),
    lambda a: a.update(maxApiCalls=13),
    lambda a: a["calls"][0].update(index=True),
    lambda a: a["calls"][0].update(path="/v1/responses"),
    lambda a: a["calls"][0].update(requestSha256="invalid"),
    lambda a: a["calls"][0].update(elapsedMs=float("inf")),
    lambda a: a["calls"][0]["response"].update(httpStatus=429),
    lambda a: a["calls"][2]["response"].update(responseStatus="incomplete"),
    lambda a: a["calls"][2]["response"].update(hasRefusal=True),
    lambda a: a["calls"][2]["response"].update(outputTextTruncated=True),
    lambda a: a["calls"][2]["response"].update(outputTexts=['{"answer":"위조","answerStatus":"ANSWERED","citationChunkIndexes":[0]}']),
    lambda a: a["calls"][2]["response"].update(outputTexts=['{"answer":"원문","answerStatus":"ANSWERED","citationChunkIndexes":[true]}']),
    lambda a: a["calls"][2]["response"]["usage"].update(input_tokens=True),
    lambda a: a["calls"][2]["response"]["usage"].update(total_tokens=0),
    lambda a: a["calls"][0]["response"]["embeddingUsage"].update(total_tokens=0),
])
def test_rejects_official_api_operation_output_and_usage_tampering(records, mutate):
    core, api = records
    mutate(api)
    with pytest.raises(ValueError):
        verify_flow.verify(core, api)


def test_missing_token_usage_is_unknown_not_zero(records):
    core, api = records
    api["calls"][2]["response"]["usage"] = None
    result = verify_flow.verify(core, api)
    assert all(value is None for value in result["tokens"]["answers"].values())
    assert result["tokens"]["combinedTotal"] is None
    assert result["tokens"]["embeddings"]["total_tokens"] == 1418


def test_consistently_recorded_false_answer_is_not_mistaken_for_semantic_success(records):
    core, api = records
    fabricated = "강원 글로벌 IP 스타기업 자격이 스마트공장 지원의 필수 조건입니다."
    core["cases"][0]["publicResponse"]["answer"] = fabricated
    core["cases"][0]["aiCalls"][2]["response"]["answer"] = fabricated
    selection = json.loads(api["calls"][2]["response"]["outputTexts"][0])
    selection["answer"] = fabricated
    api["calls"][2]["response"]["outputTexts"] = [json.dumps(selection, ensure_ascii=False)]

    result = verify_flow.verify(core, api)

    assert result["integrityVerified"] and result["statusAccuracy"] == 1
    assert result["semanticFaithfulness"] is None and result["semanticReviewRequired"]


def test_detects_html_changes_even_when_the_capture_has_valid_document_hashes(records, tmp_path):
    core, api = records
    fixture = verify_flow.DEFAULT_FIXTURE
    (tmp_path / fixture.name).write_bytes(fixture.read_bytes())
    for source in fixture.parent.glob("*.html"):
        (tmp_path / source.name).write_bytes(source.read_bytes())
    (tmp_path / "smart-factory.html").write_text("<div>변조한 공식 문서</div>", encoding="utf-8")
    with pytest.raises(ValueError, match="HTML fixture hash"):
        verify_flow.verify(core, api, tmp_path / fixture.name)


def test_historical_recorder_fingerprint_is_reported_not_silently_replaced(records):
    core, api = records
    api["recorderSha256"] = "a" * 64
    assert not verify_flow.verify(core, api)["recorderMatchesCurrentCheckout"]


def test_cli_reads_only_and_does_not_connect_to_network(monkeypatch, capsys):
    def forbidden(*args, **kwargs):
        pytest.fail("offline verifier must not write files or connect to a network")
    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(Path, "write_bytes", forbidden)
    monkeypatch.setattr(Path, "write_text", forbidden)
    assert verify_flow.main(["--run-dir", str(RUN)]) == 0
    assert json.loads(capsys.readouterr().out)["completed"]


def test_cli_refuses_incomplete_capture_without_publishing_accuracy(records, tmp_path, capsys):
    core, api = records
    core["completed"] = False
    for directory, filename, value in [("core", "capture.json", core), ("api", "api-capture.json", api)]:
        (tmp_path / directory).mkdir()
        (tmp_path / directory / filename).write_text(json.dumps(value), encoding="utf-8")
    assert verify_flow.main(["--run-dir", str(tmp_path)]) == 1
    output = capsys.readouterr()
    assert output.out == "" and "incomplete" in output.err


@pytest.mark.parametrize("value", ['{"x":1,"x":2}', '{"x":NaN}'])
def test_json_reader_rejects_ambiguous_or_nonfinite_records(value):
    with pytest.raises(ValueError):
        verify_flow._json(value)
