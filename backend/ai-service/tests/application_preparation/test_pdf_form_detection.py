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


def test_nearby_original_label_is_kept_and_ambiguous_overlapping_inputs_fail():
    detection = {"kind": 0, "confidence": .8, "box": box(.5, .2, .3, .1)}
    words = [{"text": "업체명", "box": box(.3, .23, .15, .03)}]
    assert checked_regions([detection], words, [])[0]["labels"] == ["업체명"]
    with pytest.raises(ValueError, match="PDF_DETECTION_OVERLAP"):
        checked_regions([detection, detection], words, [])


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
