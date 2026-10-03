import asyncio

import pytest

from app.application_preparation.pdf_form_detection import checked_regions


def box(x, y, width, height):
    return dict(x=x, y=y, width=width, height=height)


def test_detector_and_ruled_sublabels_jointly_resolve_native_contact_boundaries():
    detection = {"kind": 0, "confidence": .8, "box": box(.5, .2, .4, .2)}
    regions = [{"box": box(.49, .2, .42, .09), "labels": ["사무실"]},
               {"box": box(.49, .31, .42, .09), "labels": ["휴대폰"]}]
    words = [{"text": "사무실", "box": box(.35, .21, .1, .02)},
             {"text": "휴대폰", "box": box(.35, .32, .1, .02)}]
    result = checked_regions([detection], words, regions)
    assert [r["labels"] for r in result] == [["사무실"], ["휴대폰"]]
    for actual, expected in zip(result, regions):
        assert actual["box"] == pytest.approx(expected["box"])
    assert checked_regions([], words, regions) == []  # no rule-only substitute


def test_short_phone_row_keeps_source_height_needed_for_readable_pdf_text():
    detection = {"kind": 0, "confidence": .8, "box": box(.765, .208, .15, .033)}
    regions = [{"box": box(.7645, .2054, .1511, .0180), "labels": ["(사무실)"]},
               {"box": box(.7645, .2246, .1511, .0178), "labels": ["(핸드폰)"]}]
    result = checked_regions([detection], [], regions)
    assert len(result) == 2
    assert all(r["box"]["height"] * 841 - 4 >= 8 * 1.25 for r in result)


def test_printed_words_and_consent_controls_are_not_accepted_as_blank_inputs():
    region = box(.2, .2, .3, .1)
    words = [{"text": "동의함", "box": box(.25, .22, .1, .02)}]
    assert checked_regions([{"kind": 0, "confidence": .9, "box": region}], words, []) == []
    assert checked_regions([{"kind": kind, "confidence": .9, "box": region} for kind in (1, 2)], [], []) == []
    assert checked_regions([{"kind": 0, "confidence": .39, "box": region}], [], []) == []


def test_nearby_original_label_is_kept_and_a_labeled_overlap_keeps_only_the_first_input(caplog):
    detection = {"kind": 0, "confidence": .8, "box": box(.5, .2, .3, .1)}
    words = [{"text": "업체명", "box": box(.3, .23, .15, .03)}]
    assert checked_regions([detection], words, [])[0]["labels"] == ["업체명"]
    caplog.set_level("WARNING", logger="app.application_preparation.pdf_form_detection")
    result = checked_regions([detection, {**detection, "confidence": .9}], words, [], page=6)
    assert [region["id"] for region in result] == ["ffdetr-0"]
    assert result[0]["confidence"] == .8
    assert "pdf_detection_overlap_dropped page=6 kept=[['업체명']] dropped=['업체명'] confidence=0.90" in caplog.text


def test_unlabeled_overlap_is_discarded_without_changing_labeled_input():
    labeled = {"kind": 0, "confidence": .8, "box": box(.5, .2, .3, .02)}
    unlabeled = {"kind": 0, "confidence": .7, "box": box(.5, .219, .3, .02)}
    words = [{"text": "기업명", "box": box(.3, .2, .15, .02)}]
    result = checked_regions([labeled, unlabeled], words, [])
    assert len(result) == 1
    assert result[0]["box"] == pytest.approx(labeled["box"])
    assert result[0]["labels"] == ["기업명"]


@pytest.mark.parametrize("invalid", [box(-.1, .2, .3, .1), box(.9, .2, .3, .1), box(float('nan'), .2, .3, .1)])
def test_invalid_detector_geometry_is_an_error(invalid):
    with pytest.raises(ValueError, match="PDF_DETECTION_BOX"):
        checked_regions([{"kind": 0, "confidence": .8, "box": invalid}], [], [])


def test_pdf_inspection_does_not_load_multiple_models_concurrently(monkeypatch):
    from app.application_preparation import document_adapters
    async def run():
        monkeypatch.setattr(document_adapters, "_pdf_inspection_lock", asyncio.Semaphore(1))
        active = 0
        peak = 0
        async def inspect(self, path, request):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(.01)
            active -= 1
            return path
        monkeypatch.setattr(document_adapters.PdfDocumentAdapter, "_inspect", inspect)
        adapter = document_adapters.PdfDocumentAdapter()
        assert await asyncio.gather(*(adapter.inspect(i, None) for i in range(3))) == [0, 1, 2]
        assert peak == 1
    asyncio.run(run())


def test_labels_follow_printed_order_whatever_order_the_words_arrive_in():
    detection = {"kind": 0, "confidence": .8, "box": box(.5, .2, .3, .03)}
    words = [{"text": "명", "box": box(.44, .205, .02, .02)},
             {"text": "기", "box": box(.36, .205, .02, .02)},
             {"text": "업", "box": box(.40, .206, .02, .02)}]
    for ordering in (words, list(reversed(words)), words[1:] + words[:1]):
        assert checked_regions([detection], ordering, [])[0]["labels"] == ["기 업 명"]


def test_letter_gap_inside_a_spaced_label_is_not_an_input_but_a_wide_blank_is():
    words = [{"text": "상", "box": box(.10, .30, .02, .02)}, {"text": "호", "box": box(.16, .30, .02, .02)},
             {"text": "성", "box": box(.10, .40, .02, .02)}, {"text": "명", "box": box(.40, .40, .02, .02)}]
    gap = {"kind": 0, "confidence": .8, "box": box(.122, .298, .036, .024)}
    wide = {"kind": 0, "confidence": .8, "box": box(.13, .398, .25, .024)}
    result = checked_regions([gap, wide], words, [])
    assert [region["box"]["y"] for region in result] == [pytest.approx(.398)]


def test_ruled_words_and_regions_come_back_in_reading_order():
    from app.application_preparation.pdf_mcp_extension import reading_order
    words = [{"text": t, "box": box(x, y, .02, .02)} for t, x, y in
             [("금", .3, .101), ("자", .1, .1), ("본", .2, .099), ("둘째", .1, .2)]]
    assert [w["text"] for w in reading_order(words)] == ["자", "본", "금", "둘째"]
    assert [w["text"] for w in reading_order(list(reversed(words)))] == ["자", "본", "금", "둘째"]
