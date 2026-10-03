"""인쇄된 단위·선택지·날짜·라벨을 지우지 않고 빈칸에만 답을 넣는 규칙입니다. 예시는 실제 공고 서식 문구입니다."""
import pytest

from app.application_preparation.answer_slots import AMBIGUOUS_SLOT, SLOT_MISMATCH, answer_slots


def written(text: str, value: str, label: str = "문항") -> str:
    slots = answer_slots(text, value, label)
    if isinstance(slots, str):
        return slots
    for slot in sorted(slots, key=lambda item: item.start, reverse=True):
        text = text[:slot.start] + slot.text + text[slot.end:]
    return text


@pytest.mark.parametrize("text,value,expected", [
    # units and signature marks stay next to the answer
    ("상시종업원(   명)", "12", "상시종업원(12 명)"),
    ("     백만원", "150", " 150 백만원"),
    ("(인)", "홍길동", "홍길동 (인)"),
    ("%", "12", "12%"),
    ("대표자 :         (서명 또는 날인)", "홍길동", "대표자 :     홍길동 (서명 또는 날인)"),
    ("총      명", "12", "총   12 명"),
    # labels and bullets stay in front of it
    ("대표자명:", "홍길동", "대표자명: 홍길동"),
    ("성명 :         ", "홍길동", "성명 : 홍길동"),
    ("❍", "답변", "❍ 답변"),
    ("   - ", "답변", "   - 답변"),
    ("❍ (예시 문구)", "답변", "❍ 답변"),
    # printed blanks
    ("기업명: ____ / 필수", "가상기업", "기업명: 가상기업 / 필수"),
    ("성명 (      )", "홍길동", "성명 (홍길동)"),
    ("-    -", "010-1234-5678", "010-1234-5678"),
    # examples and placeholders are replaced as a whole
    ("예) 홍길동", "김철수", "김철수"),
    ("홍○○", "김철수", "김철수"),
    ("0000.00.00.", "2026.10.01", "2026.10.01"),
])
def test_the_printed_text_around_a_blank_is_kept(text, value, expected):
    assert written(text, value) == expected


@pytest.mark.parametrize("text,value,expected", [
    ("□ 자가 □ 임차", "자가", "■ 자가 □ 임차"),
    ("동의함  □", "동의함", "동의함  ■"),
    ("［  ］예 ［  ］아니오", "아니오", "［  ］예 ［√］아니오"),
    ("[ ]일요일 [ ]공휴일([ ]유급 [ ]무급)", "공휴일, 유급", "[ ]일요일 [√]공휴일([√]유급 [ ]무급)"),
    ("유 (     ),   무 (     )", "유", "유 (○),   무 (     )"),
    ("(  )유 (  )무", "무", "(  )유 (○)무"),
    # an answer outside the printed options goes into the 기타 blank, and 기타 is marked
    ("□ 영업 수익       □ 기타(           )", "임대 수익", "□ 영업 수익       ■ 기타(임대 수익)"),
    # an option followed by its own blank still matches the plain answer
    ("□ 유 (채널명:              )   □ 무 ", "유", "■ 유 (채널명:              )   □ 무 "),
])
def test_a_printed_choice_is_marked_instead_of_overwritten(text, value, expected):
    assert written(text, value) == expected


def test_a_count_goes_into_the_blank_of_its_own_option():
    assert (written("□ 기본부스 ___개     □ 독립부스 ___개", "3", "참가 형태 / 기본부스 개수")
            == "■ 기본부스 3 개     □ 독립부스 ___개")


@pytest.mark.parametrize("text,value,expected", [
    # units printed in parentheses or not in the first unit list
    ("(백만원)", "150", "150 (백만원)"),
    ("          (천원)", "3,000", "    3,000 (천원)"),
    ("    인", "12", " 12 인"),
    ("달러", "5,000", "5,000 달러"),
    ("톤", "30", "30 톤"),
    # options inside one pair of parentheses
    ("(동의함 □ 동의하지 않음 □)", "동의하지 않음", "(동의함 □ 동의하지 않음 ■)"),
    ("(대상 □ 비대상 □)", "대상", "(대상 ■ 비대상 □)"),
    # one digit per printed box
    ("(우 □□□□□)", "04524", "(우 04524)"),
    ("□□□-□□-□□□□□", "123-45-67890", "123-45-67890"),
    # a placeholder after a label is replaced, the label stays
    ("기업명 ㅇㅇㅇ", "가상기업", "기업명 가상기업"),
    ("대표자: ○○○", "홍길동", "대표자: 홍길동"),
])
def test_units_bracketed_options_digit_boxes_and_label_placeholders(text, value, expected):
    assert written(text, value) == expected


def test_digit_boxes_refuse_a_number_of_another_length():
    assert answer_slots("(우 □□□□□)", "1234", "우편번호") == SLOT_MISMATCH


@pytest.mark.parametrize("text", ["11.1~11.8", "※ 5줄 이내 작성", "1) 자동차 브레이크,  2) 배터리 양극재 소재"])
def test_guidance_notes_dates_and_example_lists_are_replaced_as_a_whole(text):
    assert written(text, "답변") == "답변"


@pytest.mark.parametrize("text,value,expected", [
    ("2026년    월    일", "2026-10-01", "2026년 10월 1일"),
    ("년    월    일", "2026.10.01", "2026년 10월 1일"),
    (".  .  .", "2026년 10월 1일", "2026. 10. 1."),
    ("( 202  년   월   일 현재 )", "2026-09-30", "( 2026년 9월 30일 현재 )"),
    ("     년    월    일 부터              년    월    일 까지", "2026-01-01 ~ 2026-12-31",
     "2026년 1월 1일 부터         2026년 12월 31일 까지"),
])
def test_a_date_answer_is_split_over_the_printed_date_blanks(text, value, expected):
    assert written(text, value) == expected


@pytest.mark.parametrize("text,value,label,expected", [
    (" - 경영관리 ( )명 / 연구개발 ( )명 / 기타 ( )명", "3", "인력 / 연구개발", " - 경영관리 ( )명 / 연구개발 (3)명 / 기타 ( )명"),
    ("담당자명 :          직  위 :          ", "과장", "담당자 / 직위", "담당자명 :          직  위 : 과장"),
])
def test_the_answer_label_picks_one_of_several_blanks(text, value, label, expected):
    assert written(text, value, label) == expected


@pytest.mark.parametrize("text,value,label,reason", [
    ("□ 자가 □ 임차", "전세", "사업장", SLOT_MISMATCH),
    ("2026년    월    일", "2025-10-01", "신청일", SLOT_MISMATCH),
    ("     년    월    일 부터              년    월    일 까지", "2026-01-01", "기간", SLOT_MISMATCH),
    ("1.(              ), 2.(              ), 3.(              )", "가", "문항", AMBIGUOUS_SLOT),
    ("담당자명 :          직  위 :          ", "과장", "연락처", AMBIGUOUS_SLOT),
])
def test_an_undecidable_slot_is_skipped_rather_than_overwritten(text, value, label, reason):
    assert answer_slots(text, value, label) == reason


@pytest.mark.parametrize("text", ["업  체  명", "사 업 장주    소", "생 년 월 일", "18:00", "참가하면서  아래와 같이 신청합니다"])
def test_letter_spacing_times_and_prose_are_not_blanks(text):
    # No rule finds a blank here, so the last rule replaces the text as an example, as before.
    (slot,) = answer_slots(text, "값", "문항")
    assert (slot.start, slot.end, slot.text) == (0, len(text), "값")
