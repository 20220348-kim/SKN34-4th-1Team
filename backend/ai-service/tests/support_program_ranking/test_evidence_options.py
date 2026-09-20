from unicodedata import category

import pytest
from pydantic import ValidationError

from app.support_program_ranking.agent import build_evidence_options
from app.support_program_ranking.models import SupportProgramCandidate


def candidate(**changes):
    return SupportProgramCandidate.model_validate({
        "id": "BIZINFO:evidence-options",
        "title": "본문과 다른 제목",
        "organization": "본문과 다른 기관",
        "summary": "서울 소재 기업의 사업화를 지원합니다.",
        "categories": ["사업화"],
        "regions": ["서울"],
        "targetDescription": "중소기업",
        "applicationPeriod": "상시 접수",
        "status": "OPEN",
        **changes,
    })


def assert_unique_source_is_fully_covered(source, quotes):
    """Position-unique fixture text makes missing spans observable, not just missing words."""
    covered = set()
    previous_start = None
    previous_end = None
    for quote in quotes:
        assert 1 <= len(quote) <= 240
        assert quote.strip()
        assert all(not category(character).startswith("C") for character in quote)
        start = source.find(quote)
        assert start >= 0, "each quote must be an exact, contiguous source slice"
        end = start + len(quote)
        if previous_start is not None:
            assert start > previous_start
            assert previous_end - start >= 60
        covered.update(range(start, end))
        previous_start, previous_end = start, end
    assert covered == set(range(len(source)))
    assert quotes[-1].endswith(source[-1])


def test_options_are_deterministic_field_ordered_and_do_not_deduplicate_repeated_text():
    value = candidate(summary="공통 근거\n공통 근거", targetDescription="공통 근거")
    original = value.model_dump()

    first = build_evidence_options(value)
    second = build_evidence_options(value)

    assert first == second
    assert [(option.field, option.quote) for option in first] == [
        ("SUMMARY", "공통 근거"),
        ("SUMMARY", "공통 근거"),
        ("TARGET_DESCRIPTION", "공통 근거"),
    ]
    assert value.model_dump() == original


def test_preserves_validated_whitespace_combining_characters_nbsp_and_emoji_exactly():
    value = candidate(
        summary="  서울  소재\u00a0기업 e\u0301 / \u1100\u1161 / 😀  지원  ",
        targetDescription="  대상  기업\u00a0및 😀 스타트업  ",
    )

    options = build_evidence_options(value)

    assert [(option.field, option.quote) for option in options] == [
        ("SUMMARY", value.summary),
        ("TARGET_DESCRIPTION", value.target_description),
    ]
    assert "e\u0301" in options[0].quote
    assert "\u1100\u1161" in options[0].quote
    assert "  " in options[0].quote
    assert "\u00a0" in options[0].quote
    assert "😀" in options[0].quote


@pytest.mark.parametrize("separator", [
    pytest.param("\t", id="tab"),
    pytest.param("\r\n", id="crlf"),
    pytest.param("\x00", id="nul"),
    pytest.param("\u200d", id="zero-width-joiner"),
    pytest.param("\ue000", id="private-use"),
    pytest.param("\u0378", id="unassigned"),
])
def test_every_unicode_c_category_splits_source_without_joining_or_crossing_fields(separator):
    assert all(category(character).startswith("C") for character in separator)
    value = candidate(
        summary=f"요약 앞부분{separator}요약 뒷부분",
        targetDescription=f"대상 앞부분{separator}대상 뒷부분",
    )

    options = build_evidence_options(value)

    assert [(option.field, option.quote) for option in options] == [
        ("SUMMARY", "요약 앞부분"),
        ("SUMMARY", "요약 뒷부분"),
        ("TARGET_DESCRIPTION", "대상 앞부분"),
        ("TARGET_DESCRIPTION", "대상 뒷부분"),
    ]
    for option in options:
        source = value.summary if option.field == "SUMMARY" else value.target_description
        assert option.quote in source
        assert not any(category(character).startswith("C") for character in option.quote)


def test_candidate_boundary_rejects_invalid_surrogates_before_building_options():
    with pytest.raises(ValidationError) as captured:
        candidate(summary="앞부분\ud800뒷부분")

    assert any(error["type"] == "string_unicode" for error in captured.value.errors())


@pytest.mark.parametrize("field,source_field,maximum", [
    ("summary", "SUMMARY", 6_000),
    ("targetDescription", "TARGET_DESCRIPTION", 2_000),
])
def test_maximum_length_body_covers_every_character_and_tail_with_overlapping_windows(
    field, source_field, maximum,
):
    # Each CJK code point is unique, nonblank, and outside Unicode category C.
    source = "".join(chr(0x4E00 + index) for index in range(maximum))
    value = candidate(**{field: source})

    options = build_evidence_options(value)
    quotes = [option.quote for option in options if option.field == source_field]

    assert_unique_source_is_fully_covered(source, quotes)
    other_field = "TARGET_DESCRIPTION" if source_field == "SUMMARY" else "SUMMARY"
    expected_other = value.target_description if other_field == "TARGET_DESCRIPTION" else value.summary
    assert [option.quote for option in options if option.field == other_field] == [expected_other]


@pytest.mark.parametrize("length", [240, 241, 480])
def test_window_limit_counts_unicode_code_points_and_preserves_overflow(length):
    # Distinct supplementary-plane emoji prevent UTF-8/UTF-16 length from matching len().
    source = "".join(
        chr(code_point) for code_point in range(0x1F300, 0x1F700)
        if not category(chr(code_point)).startswith("C")
    )[:length]
    assert len(source) == length
    value = candidate(summary=source)

    quotes = [option.quote for option in build_evidence_options(value) if option.field == "SUMMARY"]

    assert_unique_source_is_fully_covered(value.summary, quotes)
    assert len(quotes[0]) == 240
    assert (len(quotes) == 1) is (length == 240)


@pytest.mark.parametrize("source", [
    pytest.param("", id="empty"),
    pytest.param(" \u00a0  ", id="whitespace-only"),
    pytest.param("\x00\u200d\ue000", id="control-only"),
])
def test_blank_or_control_only_fields_never_create_invalid_quote_options(source):
    # Empty/whitespace-only fields are rejected at the HTTP boundary. Bypass validation
    # deliberately to test the option builder's defensive no-evidence behavior as well.
    value = candidate().model_copy(update={"summary": source, "target_description": source})

    assert build_evidence_options(value) == []


def test_long_whitespace_spans_and_control_boundaries_do_not_hide_later_nonblank_text():
    source = "첫 근거" + " " * 500 + "중간 근거\x00" + "\u00a0" * 500 + "마지막 근거"
    value = candidate(summary=source)

    quotes = [option.quote for option in build_evidence_options(value) if option.field == "SUMMARY"]

    assert all(1 <= len(quote) <= 240 and quote.strip() and quote in value.summary for quote in quotes)
    assert all(not category(character).startswith("C") for quote in quotes for character in quote)
    for nonblank_span in ("첫 근거", "중간 근거", "마지막 근거"):
        assert any(nonblank_span in quote for quote in quotes)


@pytest.mark.parametrize("separator", [
    pytest.param(" ", id="word-boundary"),
    pytest.param(".", id="sentence-boundary"),
])
def test_prefers_available_word_or_sentence_boundary_in_latter_half_of_window(separator):
    prefix = "가" * 179
    source = prefix + separator + "나" * 200
    value = candidate(summary=source)

    quotes = [option.quote for option in build_evidence_options(value) if option.field == "SUMMARY"]

    assert 120 <= len(quotes[0]) <= 240
    assert quotes[0] == source[:len(quotes[0])]
    assert quotes[0].endswith(separator) or source[len(quotes[0])] == separator
    assert quotes[-1].endswith("나" * 60)
    assert all(1 <= len(quote) <= 240 and quote in value.summary for quote in quotes)
