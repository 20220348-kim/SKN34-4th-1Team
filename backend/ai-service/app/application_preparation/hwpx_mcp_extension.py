"""Pinned Hangeul file-mode server with empty-run and physical body addresses.

The upstream addressed engine cannot fill <hp:run .../> or <hp:t/>.
This extension changes only its in-memory text replacement primitive, keeping
the original source, addressing, preview/apply session and verification intact.
"""
import re
from html import unescape
from xml.etree import ElementTree
from xml.sax.saxutils import escape
from pathlib import Path

NAMESPACE = "http://www.hancom.co.kr/hwpml/2011/paragraph"
EMPTY_STRUCTURE = {"tc", "subList", "p", "run", "t", "linesegarray", "lineseg", "cellAddr", "cellSpan", "cellSz", "cellMargin"}
# Colored or decorated charPr id -> plain black clone, and the answers being written, set by prepare_answer_styles
# for this session's edits.
ANSWER_STYLES: dict[str, str] = {}
ANSWER_TEXTS: set[str] = set()


def is_example_color(color: str) -> bool:
    """Writing-example text colors: blue, or a gray lighter than body text (the same rule as Core's HWP check)."""
    match = re.fullmatch(r"#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})", color or "")
    if not match:
        return False
    red, green, blue = (int(part, 16) for part in match.groups())
    is_blue = blue >= 128 and blue > red + 40 and blue > green + 40
    return is_blue or max(red, green, blue) - min(red, green, blue) <= 24 and 110 <= (red + green + blue) // 3 <= 210


def example_char_prs(header: str) -> set[str]:
    return {attrs["id"] for match in re.finditer(r"<hh:charPr\b([^>]*)>", header)
            if "id" in (attrs := dict(re.findall(r'(\w+)="([^"]*)"', match.group(1))))
            and is_example_color(attrs.get("textColor", ""))}


def paragraph_example_text(block: str, example_ids: set[str]) -> str:
    """Text of the runs drawn in an example style, rendered like the engine's paragraph text (child tags dropped)."""
    parts = []
    for run in re.finditer(r"<hp:run\b([^>]*?)(?:/>|>(.*?)</hp:run>)", block, re.S):
        reference = re.search(r'charPrIDRef="([^"]*)"', run.group(1))
        if reference and reference.group(1) in example_ids and run.group(2):
            raw = "".join(re.findall(r"<hp:t>(.*?)</hp:t>", run.group(2), re.S))
            parts.append(re.sub(r"<[^>]*>", "", raw).replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
    return "".join(parts)


def is_plain_black(charpr: str) -> bool:
    return ('textColor="#000000"' in charpr and not re.search(r"<hh:(?:italic|bold)\s*/>", charpr)
            and not re.search(r'<hh:underline\b[^>]*?\btype="(?!NONE")', charpr)
            and not re.search(r'<hh:strikeout\b[^>]*?\bshape="(?!NONE")', charpr)
            and not re.search(r'<hh:outline\b[^>]*?\btype="(?!NONE")', charpr))


def prepare_answer_styles(path: str, out_path: str, answers: list[str] | None = None) -> dict:
    """Copy the package with a plain black clone of every colored or decorated charPr, so an answer written into a
    blue/gray/red example or a bold label's run does not keep that look (Core writes HWP answers the same way).
    The clones are only referenced by runs that hold one of [answers] alone."""
    import zipfile
    source, target = Path(path), Path(out_path)
    ANSWER_STYLES.clear()
    ANSWER_TEXTS.clear()
    if source.is_symlink() or source.resolve().parent != target.resolve().parent:
        return {"count": 0, "reason": "PATH"}
    ANSWER_TEXTS.update(answer.strip() for answer in answers or () if answer.strip())
    with zipfile.ZipFile(source) as archive:
        header = archive.read("Contents/header.xml").decode("utf-8")
        charprs = list(re.finditer(r"<hh:charPr\b[^>]*?(?:/>|>.*?</hh:charPr>)", header, re.S))
        if all(is_plain_black(match.group(0)) for match in charprs):
            return {"count": 0}
        next_id = max(int(value) for value in re.findall(r'<hh:charPr\b[^>]*\bid="(\d+)"', header)) + 1
        clones = []
        for match in charprs:
            charpr = match.group(0)
            old_id = re.search(r'\bid="(\d+)"', charpr).group(1)
            if is_plain_black(charpr):
                continue
            clone = re.sub(r'\bid="\d+"', f'id="{next_id}"', charpr, count=1)
            clone = re.sub(r'textColor="#[0-9A-Fa-f]{6}"', 'textColor="#000000"', clone, count=1)
            clone = re.sub(r"<hh:(?:italic|bold)\s*/>", "", clone)
            clone = re.sub(r'(<hh:underline\b[^>]*?\btype=")[^"]*"', r'\1NONE"', clone)
            clone = re.sub(r'(<hh:strikeout\b[^>]*?\bshape=")[^"]*"', r'\1NONE"', clone)
            clone = re.sub(r'(<hh:outline\b[^>]*?\btype=")[^"]*"', r'\1NONE"', clone)
            clones.append(clone)
            ANSWER_STYLES[old_id] = str(next_id)
            next_id += 1
        closing = header.rindex("</hh:charProperties>")
        header = header[:closing] + "".join(clones) + header[closing:]
        header = re.sub(r'(<hh:charProperties\b[^>]*\bitemCnt=")(\d+)(")',
                        lambda m: f"{m.group(1)}{int(m.group(2)) + len(clones)}{m.group(3)}", header, count=1)
        with zipfile.ZipFile(target, "w") as output:
            for info in archive.infolist():
                data = header.encode("utf-8") if info.filename == "Contents/header.xml" else archive.read(info)
                output.writestr(info, data, compress_type=info.compress_type)
    return {"count": len(clones)}


def _answer_run_style(xml: str, node: int) -> str:
    """Point the run holding text node [node] at the plain clone of its example style, if there is one."""
    matches = list(re.finditer(r"<hp:t>([^<]*)</hp:t>", xml))
    if not ANSWER_STYLES or node >= len(matches):
        return xml
    start = xml.rfind("<hp:run", 0, matches[node].start())
    end = xml.find(">", start)
    if start < 0 or end < 0:
        return xml
    tag = xml[start:end]
    reference = re.search(r'charPrIDRef="([^"]*)"', tag)
    if not reference or reference.group(1) not in ANSWER_STYLES:
        return xml
    return xml[:start] + tag.replace(reference.group(0), f'charPrIDRef="{ANSWER_STYLES[reference.group(1)]}"') + xml[end:]


def fill_empty_run(xml: str, value: str) -> str | None:
    if "<!" in xml:
        return None
    try:
        root = ElementTree.fromstring(f'<root xmlns:hp="{NAMESPACE}">{xml}</root>')
    except ElementTree.ParseError:
        return None
    for element in list(root.iter())[1:]:
        if element.tag not in {f"{{{NAMESPACE}}}{name}" for name in EMPTY_STRUCTURE}:
            return None
        if (element.text or "").strip() or (element.tail or "").strip():
            return None
    text = escape(value)
    empty_text = re.search(r"<hp:t\s*/>", xml)
    if empty_text:
        return _answer_run_style(xml[:empty_text.start()] + f"<hp:t>{text}</hp:t>" + xml[empty_text.end():], 0)
    run = re.search(r"<hp:run\b([^<>]*?)/>", xml)
    if run:
        return _answer_run_style(xml[:run.start()] + f"<hp:run{run.group(1)}><hp:t>{text}</hp:t></hp:run>" + xml[run.end():], 0)
    return None



def replace_plain_text_runs(xml: str, value: str) -> str | None:
    """Change one unambiguous text range while preserving surrounding run styles."""
    if re.search(r"<hp:(?:tbl|pic|ctrl|ole|container|equation|rect|ellipse|polygon|curve|video)\b", xml):
        return None
    matches = list(re.finditer(r"<hp:t>([^<]*)</hp:t>", xml))
    if not matches or len(matches) != len(re.findall(r"<hp:t(?:>|\s|/)", xml)):
        return None
    texts = [unescape(match.group(1)) for match in matches]
    old = "".join(texts)
    if old == value:
        return xml
    prefix = 0
    while prefix < min(len(old), len(value)) and old[prefix] == value[prefix]:
        prefix += 1
    suffix = 0
    while suffix < min(len(old), len(value)) and old[-suffix - 1] == value[-suffix - 1]:
        suffix += 1
    if prefix + suffix > min(len(old), len(value)):
        return None  # repeated text makes the style-bearing occurrence ambiguous
    end = len(old) - suffix
    inserted = value[prefix:len(value) - suffix if suffix else len(value)]
    spans, cursor = [], 0
    for text in texts:
        spans.append((cursor, cursor + len(text)))
        cursor += len(text)
    empty_at_point = [i for i, (start, stop) in enumerate(spans) if start == stop == prefix]
    insertion_node = (empty_at_point[-1] if empty_at_point else
                      next((i for i, (_, stop) in enumerate(spans) if stop > prefix), len(texts) - 1))
    # More than one semantic change may enclose an untouched styled label.
    # Refuse that ambiguous envelope instead of moving the label into another run.
    for i, (start, stop) in enumerate(spans):
        if prefix <= start < stop <= end and texts[i].strip() and texts[i] in inserted:
            return None
    revised = list(texts)
    for i, (start, stop) in enumerate(spans):
        left = max(0, min(len(texts[i]), prefix - start))
        right = max(0, min(len(texts[i]), end - start))
        if i == insertion_node:
            revised[i] = texts[i][:left] + inserted + texts[i][right:]
        elif max(prefix, start) < min(end, stop):
            revised[i] = texts[i][:left] + texts[i][right:]
    result = xml
    for match, old_text, new_text in reversed(list(zip(matches, texts, revised))):
        if old_text != new_text:
            result = result[:match.start(1)] + escape(new_text) + result[match.end(1):]
    written = revised[insertion_node].strip()
    if written and (written == inserted.strip() or written in ANSWER_TEXTS):
        # The run now holds only the answer ("단독/공동/각자대표" -> "단독" keeps two of its letters):
        # do not keep an example's or label's look on it.
        result = _answer_run_style(result, insertion_node)
    return result


def verify_edits(source_path: str, output_path: str, expected_targets: list[dict]) -> dict:
    """Re-resolve cleared body paragraphs against unchanged structural anchors."""
    import hangeul_core.addressed as addressed
    source, output = Path(source_path), Path(output_path)
    if source.is_symlink() or output.is_symlink() or source.resolve().parent != output.resolve().parent:
        return {"verified": False, "reason": "PATH"}
    index = addressed.body_field_index(source)
    original_package = addressed.HwpxPackage.open(source)
    output_package = addressed.HwpxPackage.open(output)
    remaining = []
    for expected in expected_targets:
        target = expected["target"]
        if not re.fullmatch(r"b\d+", target):
            remaining.append(expected)
            continue
        location = index.get(target)
        if location is None:
            return {"verified": False, "reason": "BODY_SOURCE_ADDRESS"}
        section, ordinal = location
        old_xml = original_package.read(section).decode("utf-8")
        new_xml = output_package.read(section).decode("utf-8")
        old_blocks = [old_xml[start:end] for start, end, table in addressed._body_para_spans(old_xml) if not table]
        new_blocks = [new_xml[start:end] for start, end, table in addressed._body_para_spans(new_xml) if not table]
        if len(old_blocks) != len(new_blocks):
            return {"verified": False, "reason": "BODY_STRUCTURE_CHANGED"}
        if [addressed._P_OPEN_TAG_RE.match(block).group() for block in old_blocks] != [addressed._P_OPEN_TAG_RE.match(block).group() for block in new_blocks]:
            return {"verified": False, "reason": "BODY_ANCHOR_CHANGED"}
        physical_index = ordinal - 1
        if not 0 <= physical_index < len(new_blocks):
            return {"verified": False, "reason": "BODY_SOURCE_ADDRESS"}
        if addressed._paragraph_text(new_blocks[physical_index]) != expected["expected_text"]:
            return {"verified": False, "reason": "BODY_TEXT_MISMATCH"}
    if remaining and addressed.verify_targets(output, remaining)["verified"] is not True:
        return {"verified": False, "reason": "CELL_TEXT_MISMATCH"}
    return {"verified": True, "counts": {"requested": len(expected_targets), "verified": len(expected_targets), "failed": 0}}

CELL_MARGIN_X = 280  # left+right inner cell margin, as hangeul_core.formfit assumes
CELL_MARGIN_Y = 282  # top+bottom inner cell margin (2 x 0.5 mm)


def fit_cells(path: str, values: dict[str, str]) -> dict:
    """Estimate the lines each filled cell needs once Hancom wraps it; flag only a gross row balloon.

    Hancom grows a row to fit wrapped text, so a long answer is not an error by itself. Following python-hwpx
    FormFit (calibrated on Hancom-saved forms), a cell overflows only when its text needs more than twice the
    lines its authored height holds at the tightest pitch. Merged rows and cells without a usable height wrap
    freely and never overflow here. capacity is the approximate number of full-width characters that fit.
    """
    from hangeul_core.analyze import analyze
    from hangeul_core.formfit import font_height
    from hangeul_core.owpml import HwpxPackage
    from hwpx.form_fit.measure import (DEFAULT_SAFETY, GROSS_ROW_GROWTH_FACTOR, MIN_LINE_SPACING_RATIO,
                                       MIN_LINE_WIDTH, MIN_ROW_GROWTH_LINES, TextStyle, estimate_lines)
    cells = {cell.field_id: cell for cell in analyze(path).all_cells()}
    header = HwpxPackage.open(path).read("Contents/header.xml").decode("utf-8")
    result = {}
    for target, text in values.items():
        cell = cells.get(target)
        if cell is None or not cell.width:
            continue
        em = font_height(header, cell.char_pr)
        width = max(cell.width - CELL_MARGIN_X, MIN_LINE_WIDTH) * DEFAULT_SAFETY
        lines = estimate_lines(text, width, em / 100, TextStyle(spacing=cell.char_spacing or 0))
        allowed = None
        inner = max((cell.height or 0) - CELL_MARGIN_Y, 0) * DEFAULT_SAFETY
        if cell.row_span <= 1 and inner >= em * MIN_LINE_SPACING_RATIO:
            budget = int(inner // (em * MIN_LINE_SPACING_RATIO))
            allowed = max(int(budget * GROSS_ROW_GROWTH_FACTOR), budget + MIN_ROW_GROWTH_LINES - 1)
        result[target] = {"lines": lines, "allowedLines": allowed, "overflow": allowed is not None and lines > allowed,
                          "capacity": None if allowed is None else allowed * max(int(width // em), 1)}
    return {"cells": result, "checked": len(result)}


TAG = re.compile(r"<(/?)([A-Za-z][\w:.\-]*)([^>]*?)(/?)>")  # identical to the pinned engine's fill._TAG
CELL_ADDRESS = re.compile(r'(\w+)="(-?\d+)"')
# Source hash of the pinned engine's fill._find_cell_span; the index below replays its exact semantics.
PINNED_FIND_CELL_SPAN_SHA256 = "e6c76c7a7f5b8c2a4ddb99521b543ba10cd0f2ee5f1e22091ce91074168465c3"


def cell_span_index(section: str) -> dict[tuple[int, int, int], tuple[int, int]]:
    """One pass over a section: (table ordinal, row, col) -> <hp:tc> span.

    The pinned engine rescans the whole section for every cell, which costs minutes on
    large forms. Table ordinals count every <hp:tbl> open in document order (nested included),
    a cell belongs to the innermost open table, and the first address wins, exactly as
    fill._find_cell_span resolves them.
    """
    index: dict[tuple[int, int, int], tuple[int, int]] = {}
    pending: dict[int, tuple[int, int, int]] = {}
    tables: list[int] = []
    cells: list[int] = []
    seen_tables = 0
    for match in TAG.finditer(section):
        closing, name, attrs, self_closing = match.group(1) == "/", match.group(2), match.group(3), match.group(4) == "/"
        if name == "hp:tbl" and not self_closing:
            if closing:
                if tables:
                    tables.pop()
            else:
                seen_tables += 1
                tables.append(seen_tables)
        elif name == "hp:tc" and not self_closing:
            if closing:
                if cells:
                    start = cells.pop()
                    key = pending.pop(start, None)
                    if key is not None:
                        index.setdefault(key, (start, match.end()))
            elif tables:
                cells.append(match.start())
        elif name == "hp:cellAddr" and not closing and tables and cells and cells[-1] not in pending:
            address = dict(CELL_ADDRESS.findall(attrs))
            if "rowAddr" in address and "colAddr" in address:
                pending[cells[-1]] = (tables[-1], int(address["rowAddr"]), int(address["colAddr"]))
    return index


def install_cell_span_index():
    """Replace the engine's per-cell section rescan with a cached per-section index."""
    import hashlib
    import inspect
    from collections import OrderedDict
    import hangeul_core.addressed as addressed
    import hangeul_core.fill as fill
    source = inspect.getsource(fill._find_cell_span).encode("utf-8")
    if hashlib.sha256(source).hexdigest() != PINNED_FIND_CELL_SPAN_SHA256:
        raise RuntimeError("GOVBIZ_HWPX_ENGINE_CHANGED")
    cache: "OrderedDict[tuple[int, int], dict]" = OrderedDict()

    def find_cell_span(section, table_index, row, col):
        key = (len(section), hash(section))
        index = cache.get(key)
        if index is None:
            index = cache[key] = cell_span_index(section)
            while len(cache) > 8:
                cache.popitem(last=False)
        return index.get((table_index, row, col))

    fill._find_cell_span = find_cell_span
    addressed._find_cell_span = find_cell_span


def install_addressed_patches():
    """Keep inspect, preview, apply and verify on the same physical paragraphs."""
    import hangeul_core.addressed as addressed

    def replace(xml, value):
        result = replace_plain_text_runs(xml, value)
        if result is not None:
            return result
        result = fill_empty_run(xml, value)
        if result is not None:
            return result
        raise ValueError("GOVBIZ_UNSUPPORTED_STYLE_RANGE")

    addressed._replace_text_nodes = replace

    def paragraphs(section, section_number):
        items = []
        for start, end, has_table in addressed._body_para_spans(section):
            if has_table:
                continue
            block = section[start:end]
            ordinal = len(items) + 1
            items.append({"target": f"s{section_number}.p{ordinal}", "start": start, "end": end,
                "block": block, "paragraph_id": addressed._paragraph_id(block),
                "paragraph_ordinal": ordinal, "text": addressed._paragraph_text(block)})
        return items

    def body_index(path):
        package = addressed.HwpxPackage.open(path)
        result = {}
        for section_number, name in enumerate(addressed._section_names(package)):
            for item in paragraphs(package.read(name).decode("utf-8"), section_number):
                result[f"b{len(result) + 1}"] = (name, item["paragraph_ordinal"])
        return result

    def replace_body(section, ordinal_map, keep_marker=True):
        items = paragraphs(section, 0)
        applied = []
        for ordinal in sorted(ordinal_map, reverse=True):
            if not 1 <= ordinal <= len(items):
                continue
            item = items[ordinal - 1]
            prefix = addressed.marker_prefix(item["text"]) if keep_marker else ""
            block = replace(item["block"], prefix + ordinal_map[ordinal])
            section = section[:item["start"]] + block + section[item["end"]:]
            applied.append(ordinal)
        return section, applied

    original_inspect = addressed.inspect_editable_regions
    def inspect(path, compact=False):
        result = original_inspect(path, compact=compact)
        package = addressed.HwpxPackage.open(path)
        blocks = [item for i, name in enumerate(addressed._section_names(package))
                  for item in paragraphs(package.read(name).decode("utf-8"), i)]
        for region in result["regions"]:
            if region["kind"] != "body_para":
                continue
            item = blocks[int(region["target"][1:]) - 1]
            if replace_plain_text_runs(item["block"], item["text"]) is None and fill_empty_run(item["block"], item["text"]) is None:
                region["editable"] = False
                region["reason"] = "UNSUPPORTED_BODY_STRUCTURE"
        mark_example_text(path, package, result["regions"], blocks)
        return result

    def mark_example_text(path, package, regions, blocks):
        """Add exampleText (the text drawn in a blue/gray example style) to body and cell paragraphs."""
        example_ids = example_char_prs(package.read("Contents/header.xml").decode("utf-8"))
        if not example_ids:
            return
        cells = {cell.field_id: cell for cell in addressed.analyze(path).all_cells()}
        for region in regions:
            if region["kind"] == "body_para":
                region["exampleText"] = paragraph_example_text(blocks[int(region["target"][1:]) - 1]["block"], example_ids)
                continue
            cell = cells.get(region["target"])
            if region["kind"] != "cell" or cell is None:
                continue
            section = package.read(cell.section).decode("utf-8")
            span = addressed._find_cell_span(section, cell.table_in_section, cell.row, cell.col)
            if span is None:
                continue
            items = addressed._paragraph_blocks(section[span[0]:span[1]])
            if [item["text"] for item in items] != [item["text"] for item in region.get("paragraphs", [])]:
                continue  # the cell does not match the inspected paragraphs; offer no example ranges
            for paragraph, item in zip(region["paragraphs"], items):
                paragraph["exampleText"] = paragraph_example_text(item["block"], example_ids)

    addressed._body_paragraphs_in_section = paragraphs
    addressed.body_field_index = body_index
    addressed.replace_body_paragraph = replace_body
    addressed.inspect_editable_regions = inspect


def main():
    install_cell_span_index()
    install_addressed_patches()
    from hangeul_mcp.server import main as serve
    from hangeul_mcp.server import mcp
    mcp.tool(name="govbiz_verify_hwpx_edits")(verify_edits)
    mcp.tool(name="govbiz_hwpx_fit")(fit_cells)
    mcp.tool(name="govbiz_hwpx_prepare_answer_styles")(prepare_answer_styles)
    serve()


if __name__ == "__main__":
    main()
