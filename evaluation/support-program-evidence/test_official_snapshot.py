"""공식 HTML 파생 자료의 출처·과거 실행·무료 재계산 계약."""

from copy import deepcopy
import json

import pytest

import evaluate
import llmops
import official_snapshot as official


def test_projection_is_reproducible_and_preserves_recorded_requests_and_answers():
    fixture, capture = official.build()
    assert (official.OUTPUT / "fixture.json").read_bytes() == official.encoded(fixture)
    assert (official.OUTPUT / "capture.json").read_bytes() == official.encoded(capture)
    loaded = evaluate.load_fixture(official.OUTPUT / "fixture.json")
    core = json.loads((official.SOURCE / "core/capture.json").read_bytes())
    for (_, request), source, record in zip(loaded[1], core["cases"], capture["cases"], strict=True):
        assert request.model_dump(by_alias=True) == source["aiCalls"][-1]["request"]
        assert record["response"] == source["aiCalls"][-1]["response"]
    report = evaluate.report(*loaded, capture)
    assert report["dataType"] == "official-html-snapshot"
    assert report["measurementKind"] == "historical-answer-projection"
    assert report["caseCount"] == 6 and report["documentCount"] == 2
    assert report["semanticFaithfulness"] is None and report["semanticReviewRequired"]
    assert report["execution"]["model"] == "gpt-5.6-luna"
    assert capture["modelApiCalls"] == 0
    assert capture["modelTimeoutSeconds"] is capture["runTimeoutSeconds"] is None


@pytest.mark.parametrize("change", [
    lambda f: f.update(dataType="synthetic"),
    lambda f: f.update(referenceSource="human-reviewed"),
    lambda f: f["documents"][0]["source"].update(sourceUrl="https://evil.example/"),
    lambda f: f["documents"][0]["source"].update(sourceProgramId="PBLN_999"),
    lambda f: f["documents"][0]["source"].update(collectedAt="2026-09-07"),
    lambda f: f["documents"][0]["source"].update(scope="including-attachments"),
    lambda f: f["documents"][0]["source"].update(html="<div>changed</div>"),
    lambda f: f["documents"][0]["source"].update(content="different content"),
    lambda f: f["documents"][0]["source"].update(contentSha256="0" * 64),
    lambda f: f["documents"][0]["chunks"][0].update(text="different evidence"),
    lambda f: f["documents"][0]["chunks"][0].update(id="0" * 64),
])
def test_tampered_or_mislabelled_fixture_is_rejected(tmp_path, change):
    fixture = json.loads((official.OUTPUT / "fixture.json").read_bytes())
    change(fixture)
    path = tmp_path / "fixture.json"
    path.write_bytes(official.encoded(fixture))
    with pytest.raises(ValueError):
        evaluate.load_fixture(path)


@pytest.mark.parametrize("change", [
    lambda c: c.update(measurementKind="live"),
    lambda c: c.update(modelApiCalls=6),
    lambda c: c.update(provenance={}),
    lambda c: c.update(modelTimeoutSeconds=25),
    lambda c: c["cases"][0].update(requestSha256="0" * 64),
])
def test_projection_cannot_claim_new_measurement_or_invent_missing_settings(change):
    loaded = evaluate.load_fixture(official.OUTPUT / "fixture.json")
    capture = json.loads((official.OUTPUT / "capture.json").read_bytes())
    change(capture)
    with pytest.raises(ValueError):
        evaluate.report(*loaded, capture)


def test_free_comparison_retains_history_and_unknown_latency(tmp_path):
    result = llmops.load_results(official.OUTPUT / "fixture.json", official.OUTPUT / "capture.json")
    comparison = llmops.create_report(result, result, tmp_path)
    assert comparison["comparison"] == "self-replay"
    assert comparison["data_type"] == "official-html-snapshot"
    assert comparison["retrieval_evaluated"] is False
    assert comparison["candidate_execution"]["measurement_kind"] == "historical-answer-projection"
    assert comparison["candidate_execution"]["provenance"] == result["capture"]["provenance"]
    metrics = {item["key"]: item["candidate"] for item in comparison["metrics"]}
    assert metrics["meanLatencyMs"] is metrics["semanticFaithfulness"] is None
    assert result["frame"]["input_tokens"].sum() == 7446
    assert result["frame"]["output_tokens"].sum() == 494


def test_new_answer_capture_uses_v1_and_keeps_official_source_identity():
    loaded = evaluate.load_fixture(official.OUTPUT / "fixture.json")
    # A new recorded capture is a distinct format, never an old projection relabelled current.
    capture = json.loads((official.OUTPUT / "capture.json").read_bytes())
    current = deepcopy(capture)
    current.update(schemaVersion="support-program-evidence-capture-v1", model="test-new-model",
                   modelTimeoutSeconds=25, runTimeoutSeconds=30)
    current.pop("measurementKind")
    current.pop("provenance")
    report = evaluate.report(*loaded, current)
    assert report["execution"]["model"] == "test-new-model"
    assert report["dataType"] == "official-html-snapshot"
    assert "measurementKind" not in report
