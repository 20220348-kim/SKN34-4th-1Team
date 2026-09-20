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
        return xml[:empty_text.start()] + f"<hp:t>{text}</hp:t>" + xml[empty_text.end():]
    run = re.search(r"<hp:run\b([^<>]*?)/>", xml)
    if run:
        return xml[:run.start()] + f"<hp:run{run.group(1)}><hp:t>{text}</hp:t></hp:run>" + xml[run.end():]
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
        return result

    addressed._body_paragraphs_in_section = paragraphs
    addressed.body_field_index = body_index
    addressed.replace_body_paragraph = replace_body
    addressed.inspect_editable_regions = inspect


def main():
    install_addressed_patches()
    from hangeul_mcp.server import main as serve
    from hangeul_mcp.server import mcp
    mcp.tool(name="govbiz_verify_hwpx_edits")(verify_edits)
    serve()


if __name__ == "__main__":
    main()
