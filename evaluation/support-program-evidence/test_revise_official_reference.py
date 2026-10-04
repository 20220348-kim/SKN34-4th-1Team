"""참조 보완은 새 자료이며 기존 모델 응답·사람 승인으로 위장하지 않는다."""

from copy import deepcopy
import json
from pathlib import Path

import pytest

import evaluate
import revise_official_reference as revision
from official_snapshot import digest, encoded


def test_revision_preserves_history_and_only_changes_h01_reference_conditions():
    fixture, capture = revision.build()
    old_fixture = json.loads((revision.SOURCE / "fixture.json").read_bytes())
    old_capture = json.loads((revision.SOURCE / "capture.json").read_bytes())
    assert fixture["referenceSource"] == "ai-authored"
    assert fixture["documents"] == old_fixture["documents"]
    assert fixture["cases"][1:] == old_fixture["cases"][1:]
    before, after = old_fixture["cases"][0], fixture["cases"][0]
    assert after["referenceFacts"][1:] == before["referenceFacts"]
    assert after["referenceFacts"][0] == "지원 대상의 기업 규모·업종 범위는 중소·중견 제조기업"
    assert after["forbiddenClaims"][:-1] == before["forbiddenClaims"]
    def unchanged(case):
        return {k: v for k, v in case.items() if k not in {"referenceFacts", "forbiddenClaims"}}
    assert unchanged(before) == unchanged(after)
    assert capture["cases"] == old_capture["cases"]
    assert capture["apiResponses"] == old_capture["apiResponses"]
    expected = deepcopy(old_capture)
    expected.update(fixtureSha256=digest(encoded(fixture)), runnerSha256=digest(Path(revision.__file__).read_bytes()))
    expected["provenance"]["previousProjectionSha256"] = digest((revision.SOURCE / "capture.json").read_bytes())
    assert capture == expected
    assert capture["modelApiCalls"] == 0 and capture["model"] == "gpt-5.6-luna"
    assert fixture["referenceRevision"]["changedCaseIds"] == ["H01"]
    assert fixture["referenceRevision"]["sourceQuote"] in fixture["documents"][0]["source"]["content"]


def test_registered_revision_reproduces_report_without_changing_model_input():
    fixture, capture = revision.build()
    assert (revision.OUTPUT / "fixture.json").read_bytes() == encoded(fixture)
    assert (revision.OUTPUT / "capture.json").read_bytes() == encoded(capture)
    previous = evaluate.load_fixture(revision.SOURCE / "fixture.json")
    current = evaluate.load_fixture(revision.OUTPUT / "fixture.json")
    assert [request.model_dump() for _, request in previous[1]] == [request.model_dump() for _, request in current[1]]
    report = evaluate.report(*current, capture)
    assert (revision.OUTPUT / "report.json").read_bytes() == encoded(report)
    assert report["semanticFaithfulness"] is None and report["semanticReviewRequired"]
    assert report["measurementKind"] == "historical-answer-projection"
    assert previous[2] != current[2]


@pytest.mark.parametrize("filename", ["fixture.json", "capture.json"])
def test_changed_parent_bytes_are_rejected_before_a_new_version_is_built(tmp_path, monkeypatch, filename):
    for name in ("fixture.json", "capture.json"):
        raw = (revision.SOURCE / name).read_bytes()
        (tmp_path / name).write_bytes(raw + b" " if name == filename else raw)
    monkeypatch.setattr(revision, "SOURCE", tmp_path)
    with pytest.raises(ValueError, match="previous .* differs"):
        revision.build()
