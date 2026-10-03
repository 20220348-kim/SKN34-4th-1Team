"""Where one confirmed answer goes inside a printed form paragraph, decided by fixed rules instead of the model.

A bound paragraph is rarely empty: it carries units ("(   명)"), printed choices ("□ 자가 □ 임차"), date lines
("2026년    월    일"), bullets or a label. Each rule keeps that printed text and writes only into its blank part.
When the paragraph has several blanks and the answer's label does not single one out, or the printed slot cannot
hold this answer (a choice that is not printed, another year), the answer is skipped with a reason instead of
overwriting the paragraph.
"""
import re
import unicodedata
from dataclasses import dataclass

AMBIGUOUS_SLOT = "AMBIGUOUS_SLOT"
SLOT_MISMATCH = "SLOT_MISMATCH"

SPACES = " \t 　"
SPACE = "[ \t 　]"
GAP = re.compile(SPACE + "{2,}")
# Printed choice marks. Official forms mix half- and full-width brackets ("［  ]아니오").
CHOICE_MARK = re.compile(r"[□☐❏]|[\[［]" + SPACE + r"*[\]］]")
FILL_BLANK = re.compile(r"_{2,}|＿{2,}|[(（]" + SPACE + r"*[)）]")
# A bullet keeps its place in front of the answer. "※"/"*" start a guidance note, which is replaced as a whole.
BULLET = re.compile("^" + SPACE + r"*(?:[○❍◦•·∙ㅇ▪◆◇◎●☞▶►▷■\-–—]|(?P<number>(?:\d{1,2}|[가나다라마바사아자차카타파하])[.)]|\(\d{1,2}\)|[①-⑳]))(?=" + SPACE + "|$)" + SPACE + "*")
EXAMPLE = re.compile(r"^(?:[(（]?예시?[)）:：]|예시|ex\)|e\.g\.)", re.IGNORECASE)
# "000", "○○○", "0000.00.00." but not "18:00" or "7,025.00".
PLACEHOLDER = re.compile(r"(?<![0-9A-Za-z])(?<![0-9A-Za-z][,.\-:/])[0○◯OoＯ〇xX×ㅇ](?:[,.\-:/ ]*[0○◯OoＯ〇xX×ㅇ])+(?![0-9A-Za-z])")
UNIT = re.compile(r"(?:백만원|천만원|천원|만원|억원|백만달러|천달러|달러|USD|개소|개사|개월|시간|가구|명|개|건|곳|원|세|회|차|년|월|일|분|평|㎡|호|기|대|종|주|박|점|톤|kg|㎏|ha|인|%|％|won|hours?)(?![가-힣A-Za-z])")
SIGN = re.compile(r"[(（]" + SPACE + "*(?:인|印|서명|날인|직인|서명" + SPACE + "*또는" + SPACE + "*(?:날인|인))" + SPACE + r"*[)）]")
# A unit printed in parentheses after the blank: "      (백만원)".
PAREN_UNIT = re.compile(r"[(（]" + SPACE + "*(?:" + UNIT.pattern + ")" + SPACE + r"*[)）]")
# One box per digit: "(우 □□□□□)", "□□□-□□-□□□□□".
DIGIT_BOXES = re.compile(r"[□☐](?:[ \-]?[□☐]){2,}")
QUANTITY_PREFIX = set("총약만제월연주일각")
SEPARATORS = SPACES + "/,|·・、;\n"
DATE_VALUE = re.compile(r"((?:19|20)\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})")
_YEAR = "(?P<y>(?:(?:19|20)\\d{0,2})?" + SPACE + "*)"
_PART = SPACE + r"*\d{0,2}" + SPACE + "*"
KOREAN_DATE = re.compile(r"(?<![가-힣A-Za-z0-9])" + _YEAR + "[년연](?P<m>" + _PART + ")월(?P<d>" + _PART + ")일")
DOTTED_DATE = re.compile(r"(?<![가-힣A-Za-z0-9.])" + _YEAR + r"\.(?P<m>" + _PART + r")\.(?P<d>" + _PART + r")\.?")


@dataclass(frozen=True)
class Slot:
    start: int
    end: int
    text: str
    reason: str


def label_key(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum())


def answer_slots(text: str, value: str, label: str) -> list[Slot] | str:
    """Edits that put [value] into the non-blank paragraph [text], or AMBIGUOUS_SLOT / SLOT_MISMATCH."""
    value = value.strip()
    field = label_key(label.partition(" / ")[2] or label)
    bullet = BULLET.match(text)
    body = bullet.end() if bullet else 0
    if bullet and text[body:].strip() and (bullet.group("number") or not any(c.isalnum() for c in text[body:])):
        # "-    -" is a phone-number blank, and "1) 자동차, 2) 배터리" an example list: neither keeps a bullet.
        bullet, body = None, 0
    rest = text[body:]
    if (dates := _date_slots(text, value)) is not None:
        return dates
    if (digits := _digit_box_slots(text, body, value)) is not None:
        return digits
    if CHOICE_MARK.search(rest):
        return _choice_slots(text, body, value, field)
    if EXAMPLE.match(rest.strip()):
        return [Slot(body, len(text), value, "예시 문구를 저장된 답변으로 교체")]
    blanks = list(FILL_BLANK.finditer(text, body))
    if blanks:
        if (marked := _paren_choice(text, body, blanks, value)) is not None:
            return marked
        return _pick(text, body, [_blank_slot(text, blank, value) for blank in blanks], field)
    if bullet and not rest.strip():
        mark_end = len(bullet.group().rstrip(SPACES))
        return [Slot(mark_end, len(text), " " + value, "글머리표 뒤에 저장된 답변을 삽입")]
    core = rest.strip()
    if UNIT.fullmatch(core) or SIGN.fullmatch(core) or PAREN_UNIT.fullmatch(core):
        start = body + len(rest) - len(rest.lstrip())
        return [_aligned(start, start, value + ("" if core in {"%", "％"} else " "), "단위·서명 표시 앞에 저장된 답변을 삽입", body, right=True)]
    if not any(c.isalnum() for c in rest):
        return [Slot(body, len(text), value, "구분 기호만 있는 빈칸을 저장된 답변으로 교체")]
    placeholders = list(PLACEHOLDER.finditer(text, body))
    if placeholders:
        return _placeholder_slots(text, body, placeholders, value)
    gaps = [slot for gap in GAP.finditer(text, body) if (slot := _gap_slot(text, body, gap, value)) is not None]
    if gaps:
        return _pick(text, body, gaps, field)
    stripped = text.rstrip()
    if stripped.endswith((":", "：")):
        return [Slot(len(stripped), len(text), " " + value, "라벨 뒤에 저장된 답변을 삽입")]
    return [Slot(body, len(text), value, "예시 문구를 저장된 답변으로 교체")]


def _digit_box_slots(text: str, body: int, value: str) -> list[Slot] | str | None:
    """"(우 □□□□□)": a number answer goes one digit per printed box. None when the paragraph has no digit boxes."""
    boxes = [i for match in DIGIT_BOXES.finditer(text, body) for i in range(match.start(), match.end()) if text[i] in "□☐"]
    if not boxes:
        return None
    if not re.fullmatch(r"[\d\s\-().]+", value):
        return None  # not a number: the boxes may be printed choices
    digits = re.sub(r"\D", "", value)
    if len(digits) != len(boxes):
        return SLOT_MISMATCH
    return [Slot(box, box + 1, digit, "숫자 칸에 한 자리씩 입력") for box, digit in zip(boxes, digits)]


def _placeholder_slots(text: str, body: int, placeholders: list[re.Match], value: str) -> list[Slot]:
    """"기업명 ㅇㅇㅇ" keeps its label and writes over the placeholder; "홍○○", "OO 어린이집" or a placeholder inside
    example prose is an example as a whole and is replaced as a whole."""
    if len(placeholders) == 1:
        match = placeholders[0]
        label = text[body:match.start()]
        after = text[match.end():].strip()
        if (label.strip() and label[-1] in SPACES + ":：" and len(label_key(label)) <= 15
                and (not after or UNIT.fullmatch(after) or PAREN_UNIT.fullmatch(after))):
            left = "" if label[-1] in SPACES else " "
            right = " " if after and text[match.end():match.end() + 1] not in SPACES else ""
            return [Slot(match.start(), match.end(), left + value + right, "라벨 뒤 자리표시자를 저장된 답변으로 교체")]
    return [Slot(body, len(text), value, "자리표시자 예시를 저장된 답변으로 교체")]


def _aligned(start: int, end: int, written: str, reason: str, gap_start: int, right: bool) -> Slot:
    """Write into a run of spaces without moving the printed text after it: the answer takes as many spaces as it
    needs, next to the unit it belongs to (right) or after its label (left); a shorter run grows."""
    width = end - gap_start if right else end - start
    if right:
        return Slot(max(gap_start, end - len(written)) if width > len(written) else gap_start, end, written, reason)
    return Slot(start, start + len(written) if width > len(written) else end, written, reason)


def _pick(text: str, body: int, slots: list[Slot], field: str) -> list[Slot] | str:
    if len(slots) == 1:
        return slots
    # Several blanks in one paragraph ("담당자명 :      직  위 :      "): take the one printed after this answer's label.
    matches = []
    previous = body
    for slot in slots:
        piece = re.split(r"[/,|·]", text[previous:slot.start])[-1]
        # "( )명 / 연구개발 ( )명": the unit closing the previous blank is not part of this blank's label.
        key = label_key(re.sub(r"^[\s)）]*(?:" + UNIT.pattern + ")", "", piece))
        if key and field and (key == field or len(key) >= 2 and (key in field or field in key)):
            matches.append(slot)
        previous = slot.end
    return matches if len(matches) == 1 else AMBIGUOUS_SLOT


def _blank_slot(text: str, blank: re.Match, value: str) -> Slot:
    if blank.group()[0] in "(（":
        return Slot(blank.start() + 1, blank.end() - 1, value, "괄호 빈칸에 저장된 답변을 입력")
    left = " " if blank.start() > 0 and text[blank.start() - 1] not in SPACES + "(（[［" else ""
    right = " " if blank.end() < len(text) and text[blank.end()] not in SPACES + ")）]］,.:;" else ""
    return Slot(blank.start(), blank.end(), left + value + right, "밑줄 빈칸을 저장된 답변으로 교체")


def _gap_slot(text: str, body: int, gap: re.Match, value: str) -> Slot | None:
    start, end = gap.span()
    before, after = text[body:start], text[end:]
    if after.startswith("\n"):
        return None
    following = after.split("\n", 1)[0]
    unit = UNIT.match(following)
    # "주 생 산 품" starts with a unit-like syllable but is a letter-spaced label.
    unit_after = bool(unit and not re.match(SPACE + "+[가-힣](?:" + SPACE + "|$)", following[unit.end():])
                      or SIGN.match(following) or PAREN_UNIT.match(following))
    if not before.strip() or before.endswith("\n"):
        # Leading indentation is a slot only in front of a printed unit or signature mark ("      명", "     (인)").
        if not unit_after:
            return None
        return _aligned(start, end, value + ("" if following[:1] in "%％" else " "), "단위 앞 빈칸에 저장된 답변을 입력", start, right=True)
    # A blank follows a short label ("대표자     ", "전화번호 :      "). After a sentence the spaces are layout,
    # and guidance prose in an answer cell is replaced as a whole by the last rule.
    label = before.split("\n")[-1].strip()
    short_label = len(label_key(label)) <= 15 and label[-1] not in ".。!?…"
    if not following.strip():
        return Slot(start, end, " " + value, "라벨 뒤 빈칸에 저장된 답변을 입력") if short_label or label[-1] in ":：" else None
    if _hangul(before[-1]) and _hangul(following[0]) and (
            _hangul_run(before[::-1]) == 1 or _hangul_run(following) == 1) and not (
            before[-1] in QUANTITY_PREFIX and _hangul_run(before[::-1]) == 1 and unit_after):
        return None  # Letter-spaced label such as "업  체  명" or "사 업 장주    소".
    if before[-1] not in ":：(（" and not unit_after and (end - start == 2 or not short_label):
        return None  # Spaces inside prose, not an input blank.
    left = "" if before[-1] in "(（[［" else " "
    if unit_after:
        right = "" if following[:1] in "%％" else " "
        return _aligned(start, end, (left if end - start <= len(value) + 2 else "") + value + right,
                        "단위 앞 빈칸에 저장된 답변을 입력", start, right=True)
    right = "" if following[:1] in ")）]］,.:;" else " "
    if end - start > len(left + value) + 1:
        right = ""  # the spaces left over keep the next printed label in place
    return _aligned(start, end, left + value + right, "빈칸에 저장된 답변을 입력", start, right=False)


def _hangul(char: str) -> bool:
    return "가" <= char <= "힣"


def _hangul_run(text: str) -> int:
    count = 0
    while count < len(text) and _hangul(text[count]):
        count += 1
    return count


def _options(text: str, body: int, marks: list[tuple[int, int]]) -> list[tuple[str, str]] | None:
    """Printed caption for each mark: the text after it ("□ 자가"), or before it when marks close the line ("예 □").
    Each caption has two keys: the whole caption and its head before a printed blank ("□ 유 (채널명:   )" → 유)."""
    # Marks close the line when only separators or closing brackets follow: "(동의함 □ 동의하지 않음 □)".
    if not text[marks[-1][1]:].strip(SEPARATORS + ")）]］】"):
        bounds = [body] + [end for _, end in marks[:-1]]
        captions = [re.split(r"[:：]", text[a:start])[-1] for a, (start, _) in zip(bounds, marks)]
    else:
        bounds = [start for start, _ in marks[1:]] + [len(text)]
        captions = [text[end:b] for (_, end), b in zip(marks, bounds)]
    keys = [(label_key(caption), label_key(re.split(r"[(（:：_＿]", caption)[0])) for caption in captions]
    return keys if all(whole for whole, _ in keys) else None


def _choice_parts(value: str, keys: list[tuple[str, str]]) -> list[int] | None:
    def index(key: str) -> int | None:
        found = [i for i, (whole, head) in enumerate(keys) if key in (whole, head)]
        return found[0] if len(found) == 1 else None

    whole = index(label_key(value))
    if whole is not None:
        return [whole]
    parts = [index(label_key(part)) for part in re.split(r"[,/·、]", value) if part.strip()]
    if len(parts) > 1 and None not in parts and len(set(parts)) == len(parts):
        return sorted(parts)
    return None


def _mark(text: str, start: int, end: int) -> Slot:
    if text[start] in "□☐❏":
        return Slot(start, end, "■", "선택한 항목의 □를 ■로 표시")
    return Slot(start + 1, end - 1, "√", "선택한 항목의 [ ]에 √ 표시")


def _choice_slots(text: str, body: int, value: str, field: str) -> list[Slot] | str:
    marks = [match.span() for match in CHOICE_MARK.finditer(text, body)]
    keys = _options(text, body, marks)
    chosen = _choice_parts(value, keys) if keys else None
    if chosen is not None:
        return [_mark(text, *marks[index]) for index in chosen]
    # "□ 기타(          )", "□ 기본부스 ___개": an answer outside the printed options goes into the option's blank
    # (the one after this answer's label when there are several), and that option is marked.
    blanks = list(FILL_BLANK.finditer(text, body))
    picked = _pick(text, body, [_blank_slot(text, blank, value) for blank in blanks], field) if blanks else SLOT_MISMATCH
    if isinstance(picked, str):
        return SLOT_MISMATCH
    owner = max((i for i, (start, _) in enumerate(marks) if start < picked[0].start), default=None)
    return SLOT_MISMATCH if owner is None else [_mark(text, *marks[owner]), *picked]


def _paren_choice(text: str, body: int, blanks: list[re.Match], value: str) -> list[Slot] | None:
    """"유 (   ) 무 (   )": marks the parenthesis printed with the chosen caption. None when this is not a choice line."""
    parens = [blank.span() for blank in blanks if blank.group()[0] in "(（"]
    if len(parens) < 2 or len(parens) != len(blanks):
        return None
    keys = _options(text, body, parens)
    chosen = _choice_parts(value, keys) if keys else None
    if chosen is None:
        return None
    return [Slot(parens[i][0] + 1, parens[i][1] - 1, "○", "선택한 항목의 괄호에 ○ 표시") for i in chosen]


def _date_slots(text: str, value: str) -> list[Slot] | str | None:
    """Split a date answer over printed year/month/day blanks. None when the paragraph has no blank date line."""
    groups = [match for pattern in (KOREAN_DATE, DOTTED_DATE) for match in pattern.finditer(text)
              if any(_blank_part(match.group(part), part == "y") for part in "md")
              and all(_blank_part(match.group(part), part == "y") or match.group(part).strip().isdigit() for part in "ymd")]
    if not groups:
        return None
    dates = [(y, str(int(m)), str(int(d))) for y, m, d in DATE_VALUE.findall(value) if 1 <= int(m) <= 12 and 1 <= int(d) <= 31]
    if not dates:
        return None
    groups.sort(key=lambda match: match.start())
    if len(dates) != len(groups):
        return SLOT_MISMATCH
    slots = []
    for match, (year, month, day) in zip(groups, dates):
        for part, wanted in (("y", year), ("m", month), ("d", day)):
            start, end = match.span(part)
            printed = text[start:end].strip()
            if not _blank_part(text[start:end], part == "y"):
                if printed != wanted if part == "y" else str(int(printed)) != wanted:
                    return SLOT_MISMATCH
                continue
            if part == "y":
                if printed and not wanted.startswith(printed):
                    return SLOT_MISMATCH
                if not printed:
                    # Keep a right-aligned date line in place: write into the end of its leading spaces.
                    start = max(start, end - len(wanted) - 1)
                lead = " " if not printed and start > 0 and text[start - 1] not in SPACES + "(（" else ""
                slots.append(Slot(start, end, lead + wanted, "날짜의 연도 빈칸에 입력"))
            else:
                lead = "" if start > 0 and text[start - 1] in SPACES else " "
                slots.append(Slot(start, end, lead + wanted, "날짜의 월·일 빈칸에 입력"))
    return slots


def _blank_part(part: str, year: bool) -> bool:
    """A date part that still needs writing. Month/day: two or more spaces, so "생 년 월 일" is not a blank.
    Year: spaces (or nothing, for a line that starts with 년) or a partial year such as "202  "."""
    digits = part.strip()
    if not digits:
        return year or len(part) >= 2
    return year and len(digits) < 4 and digits[:2] in {"19", "20"} and part != digits
