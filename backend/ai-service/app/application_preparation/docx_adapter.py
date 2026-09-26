"""Conservative DOCX native addresses and edits, using only OOXML parts we inspect."""

from io import BytesIO
from pathlib import Path
from copy import deepcopy
import re
import zipfile
from html import escape
from xml.etree import ElementTree as ET

from app.application_preparation.document_contract import (
    DocumentError, DocumentMap, ENGINES, MAX_BYTES, NativeTarget,
    NativeTargetAnalysis, WritePlan, digest, edited_text,
)

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
W14 = "{http://schemas.microsoft.com/office/word/2010/wordml}"
_XML_PARTS = (".xml", ".rels")
_BLANK = re.compile(r"^(?:[_＿·.\s]{3,}|\[[\s_]*\]|\([\s_]*\))$")


def _load(data: bytes) -> tuple[zipfile.ZipFile, ET.Element]:
    if not 0 < len(data) <= MAX_BYTES:
        raise DocumentError("LIMIT_EXCEEDED")
    try:
        archive = zipfile.ZipFile(BytesIO(data))
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if (len(entries) > 512 or len(set(names)) != len(names)
                or sum(entry.file_size for entry in entries) > MAX_BYTES
                or any(entry.flag_bits & 1 or entry.file_size > MAX_BYTES or
                       entry.filename.startswith("/") or ".." in entry.filename.split("/") for entry in entries)):
            raise DocumentError("LIMIT_EXCEEDED")
        if "[Content_Types].xml" not in names or "word/document.xml" not in names or any(
                name.startswith("_xmlsignatures/") or name == "word/vbaProject.bin" for name in names):
            raise DocumentError("UNSUPPORTED")
        for entry in entries:
            if entry.filename.endswith(_XML_PARTS):
                value = archive.read(entry)
                if b"<!DOCTYPE" in value.upper() or b"<!ENTITY" in value.upper():
                    raise DocumentError("UNSUPPORTED")
                ET.fromstring(value)
        content_types = archive.read("[Content_Types].xml")
        if b"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" not in content_types:
            raise DocumentError("UNSUPPORTED")
        root = ET.fromstring(archive.read("word/document.xml"))
        if root.find(W + "body") is None:
            raise DocumentError("UNSUPPORTED")
        return archive, root
    except DocumentError:
        raise
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, ET.ParseError, RuntimeError):
        raise DocumentError("UNSUPPORTED") from None


def _text(node: ET.Element) -> str:
    return "".join(item.text or "" for item in node.iter(W + "t"))


def _simple_text(node: ET.Element) -> bool:
    """Mixed formatting, fields and drawings need a richer editor than a text swap."""
    if any(item.tag in {W + "fldChar", W + "instrText", W + "drawing", W + "object", W + "pict", W + "hyperlink", W + "sdt",
                        W + "ins", W + "del", W + "moveFrom", W + "moveTo", W + "commentRangeStart"}
           for item in node.iter() if item is not node):
        return False
    runs = list(node.iter(W + "r"))
    styles = {ET.tostring(run.find(W + "rPr"), encoding="unicode") if run.find(W + "rPr") is not None else ""
              for run in runs}
    return len(styles) <= 1 and not any(item.tag in {W + "br", W + "tab"} for item in node.iter())


def _replace_text(node: ET.Element, value: str) -> None:
    if not _simple_text(node) or "\n" in value or "\r" in value:
        raise DocumentError("UNSUPPORTED", reason="DOCX_STYLE_SENSITIVE_OR_MULTILINE")
    texts = list(node.iter(W + "t"))
    if not texts:
        paragraph = node if node.tag == W + "p" else node.find(".//" + W + "p")
        if paragraph is None:
            raise DocumentError("UNSUPPORTED")
        runs = paragraph.findall(W + "r")
        run = runs[0] if runs else ET.SubElement(paragraph, W + "r")
        if not runs:
            properties = paragraph.find("./" + W + "pPr/" + W + "rPr")
            if properties is not None:
                run.append(deepcopy(properties))
        texts = [ET.SubElement(run, W + "t")]
    texts[0].text = value
    if value.startswith(" ") or value.endswith(" "):
        texts[0].set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    for item in texts[1:]:
        item.text = ""


def _is_merged(cell: ET.Element) -> tuple[int, bool]:
    span = cell.find("./" + W + "tcPr/" + W + "gridSpan")
    columns = int(span.get(W + "val", "1")) if span is not None else 1
    # A horizontal gridSpan remains one physical tc. Vertical merges can address
    # continuation cells with no independent value, so they are not writable.
    return columns, cell.find("./" + W + "tcPr/" + W + "vMerge") is not None


def _signature(root: ET.Element) -> tuple:
    """Structural and style evidence independent of written text and check state."""
    parents = {child: parent for parent in root.iter() for child in parent}
    run_styles = []
    for run in root.iter(W + "r"):
        properties = run.find(W + "rPr")
        if properties is None:
            continue
        paragraph = parents.get(run)
        while paragraph is not None and paragraph.tag != W + "p":
            paragraph = parents.get(paragraph)
        mark = paragraph.find("./" + W + "pPr/" + W + "rPr") if paragraph is not None else None
        value = ET.tostring(properties, encoding="unicode")
        if mark is None or value != ET.tostring(mark, encoding="unicode"):
            run_styles.append(value)
    return (len(list(root.iter(W + "tbl"))),
            tuple(len(table.findall("./" + W + "tr")) for table in root.iter(W + "tbl")),
            tuple(tuple(len(row.findall("./" + W + "tc")) for row in table.findall("./" + W + "tr"))
                  for table in root.iter(W + "tbl")),
            tuple(_is_merged(cell) for cell in root.iter(W + "tc")),
            len(list(root.iter(W + "sdt"))),
            tuple(ET.tostring(item, encoding="unicode") for tag in ("tblPr", "tblGrid", "tcPr", "pPr")
                  for item in root.iter(W + tag)), tuple(run_styles))


def _serialize_document(root: ET.Element, source_xml: bytes) -> bytes:
    """Keep namespace aliases referenced by OOXML compatibility attributes."""
    declarations = {}
    for event, value in ET.iterparse(BytesIO(source_xml), events=("start-ns", "start")):
        if event == "start":
            break
        declarations[value[0]] = value[1]
    xml = ET.tostring(root, encoding="utf-8")
    opening = xml[:xml.index(b">")]
    missing = []
    for prefix, uri in declarations.items():
        attribute = b"xmlns" + (b":" + prefix.encode() if prefix else b"") + b"="
        if attribute not in opening:
            name = "xmlns" + (":" + prefix if prefix else "")
            missing.append(f' {name}="{escape(uri, quote=True)}"'.encode())
    if missing:
        xml = xml.replace(b">", b"".join(missing) + b">", 1)
    return b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + xml


class DocxDocumentAdapter:
    def _inspect_bytes(self, data: bytes) -> tuple[DocumentMap, dict[str, ET.Element], ET.Element]:
        archive, root = _load(data)
        archive.close()
        targets: list[NativeTarget] = []
        nodes: dict[str, ET.Element] = {}
        body = root.find(W + "body")
        heading = ""
        paragraph_number = 0
        table_number = 0

        def add(target_id: str, kind: str, node: ET.Element, locator: dict, editable: bool,
                reason: str | None = None, label: str = "", analysis: NativeTargetAnalysis | None = None):
            text = label if kind == "CHECKBOX" else _text(node)
            if len(text) > 6000 or len(targets) >= 3000:
                raise DocumentError("LIMIT_EXCEEDED")
            targets.append(NativeTarget(targetId=target_id, nativeLocator=locator, kind=kind,
                                        currentText=text, label=label[:1000], context=(heading + " | " + label)[:1000],
                                        editable=editable, unsupportedReason=reason,
                                        analysis=analysis or NativeTargetAnalysis()))
            nodes[target_id] = node

        for child in body:
            if child.tag == W + "p":
                paragraph_number += 1
                style = child.find("./" + W + "pPr/" + W + "pStyle")
                style_name = style.get(W + "val", "") if style is not None else ""
                text = _text(child)
                if re.fullmatch(r"Heading[1-3]|제목[1-3]", style_name) and text.strip():
                    heading = text.strip()[:300]
                explicit = bool(_BLANK.fullmatch(text))
                add(f"docx:p:{paragraph_number}", "paragraph", child,
                    {"paragraph": paragraph_number, "style": style_name, "sectionPath": [heading] if heading else [],
                     "bindingEligible": explicit}, explicit and _simple_text(child),
                    None if explicit and _simple_text(child) else "BODY_PARAGRAPH_NOT_EXPLICIT_INPUT")
            elif child.tag == W + "tbl":
                table_number += 1
                rows = child.findall("./" + W + "tr")
                column_headings: list[str] = []
                for row_index, row in enumerate(rows, 1):
                    cells = row.findall("./" + W + "tc")
                    row_labels = [_text(cell).strip()[:150] for cell in cells]
                    for column_index, cell in enumerate(cells, 1):
                        cell_id = f"docx:t:{table_number}:r:{row_index}:c:{column_index}"
                        span, merged = _is_merged(cell)
                        cell_text = _text(cell)
                        preceding = next((value for value in reversed(row_labels[:column_index - 1]) if value), "")
                        column_label = column_headings[column_index - 1] if len(column_headings) == len(cells) else ""
                        field_labels = ([" ".join((preceding, column_label)).strip()] if preceding and column_label and
                                        column_label != preceding and not cell_text.strip() else
                                        [preceding] if preceding and preceding != cell_text.strip() else [])
                        locator = {"table": table_number, "row": row_index, "col": column_index,
                                   "rowSpan": 1, "colSpan": span, "rowLabels": field_labels,
                                   "columnLabels": [column_label] if column_label else [],
                                   "fieldLabels": field_labels, "tableHeadings": [heading] if heading else [],
                                   "merged": merged, "bindingEligible": False}
                        analysis = NativeTargetAnalysis(tableClassification="FORM_TABLE" if len(cells) > 1 and
                            any(not value for value in row_labels) else "AMBIGUOUS",
                            tableClassificationConfidence=0.7 if len(cells) > 1 and
                            any(not value for value in row_labels) else 0.3,
                            reviewRequired=not (len(cells) > 1 and any(not value for value in row_labels)))
                        add(cell_id, "cell", cell, locator, False, "CELL_PARENT_READ_ONLY", analysis=analysis)
                        paragraphs = cell.findall("./" + W + "p")
                        for paragraph_index, paragraph in enumerate(paragraphs, 1):
                            value = _text(paragraph)
                            single = len(paragraphs) == 1
                            printed_choice = bool(re.search(r"[□☐☑☒]", preceding))
                            writable = (not merged and not printed_choice and single and bool(field_labels) and _simple_text(paragraph)
                                        and (not value.strip() or bool(_BLANK.fullmatch(value))))
                            add(f"{cell_id}:p:{paragraph_index}", "paragraph", paragraph,
                                {**locator, "parent": cell_id, "paragraph": paragraph_index,
                                 "bindingEligible": writable}, writable,
                                None if writable else "PRINTED_CHECKBOX_NOT_NATIVE" if printed_choice else
                                "MERGED_OR_AMBIGUOUS_CELL", " / ".join(field_labels), analysis.model_copy(deep=True))
                    if (len(row_labels) == 3 and not row_labels[0] and
                            all(0 < len(value) <= 8 and value.isalnum() for value in row_labels[1:])):
                        column_headings = row_labels

        for index, control in enumerate(root.iter(W + "sdt"), 1):
            props = control.find(W + "sdtPr")
            content = control.find(W + "sdtContent")
            if props is None or content is None:
                continue
            alias = props.find(W + "alias")
            tag = props.find(W + "tag")
            label = ((alias.get(W + "val") if alias is not None else None)
                     or (tag.get(W + "val") if tag is not None else None) or "")
            checkbox = props.find(W14 + "checkbox")
            text_control = props.find(W + "text")
            kind = "CHECKBOX" if checkbox is not None else "DOCX_CONTROL"
            editable = bool(label and ((checkbox is not None and checkbox.find(W14 + "checked") is not None)
                                       or (text_control is not None and _simple_text(content))))
            add(f"docx:sdt:{index}", kind, content,
                {"control": index, "fieldLabels": [label] if label else [], "controlType":
                 "checkbox" if checkbox is not None else "text" if text_control is not None else "unsupported",
                 "bindingEligible": editable}, editable,
                None if editable else "UNSUPPORTED_CONTENT_CONTROL", label)
            nodes[f"docx:sdt:{index}"] = control
        return DocumentMap(sourceSha256=digest(data), format="docx", engineVersion=ENGINES["docx"], targets=targets), nodes, root

    async def inspect(self, path: Path) -> DocumentMap:
        document, _, _ = self._inspect_bytes(path.read_bytes())
        return document

    async def apply(self, path: Path, document: DocumentMap, plan: WritePlan,
                    facts: dict[str, str]) -> tuple[bytes, dict]:
        source = path.read_bytes()
        if digest(source) != document.sourceSha256:
            raise DocumentError("SOURCE_CHANGED")
        fresh, nodes, root = self._inspect_bytes(source)
        before = {target.targetId: target for target in fresh.targets}
        if {target.targetId for target in document.targets} != before.keys():
            raise DocumentError("SOURCE_CHANGED")
        signature = _signature(root)
        check_states = {target_id: nodes[target_id].find("./" + W + "sdtPr/" + W14 + "checkbox/" + W14 + "checked").get(W14 + "val")
                        for target_id, target in before.items() if target.kind == "CHECKBOX"}
        grouped: dict[str, list] = {}
        for operation in plan.operations:
            target = before.get(operation.targetId)
            if target is None or not target.editable or target.currentText != operation.expectedText:
                raise DocumentError("SOURCE_CHANGED")
            grouped.setdefault(operation.targetId, []).append(operation)
        for target_id, operations in grouped.items():
            target = before[target_id]
            node = nodes[target_id]
            if target.kind == "CHECKBOX":
                if len(operations) != 1 or operations[0].operation != "set_check":
                    raise DocumentError("UNSUPPORTED")
                checked = node.find("./" + W + "sdtPr/" + W14 + "checkbox/" + W14 + "checked")
                checked.set(W14 + "val", "1")
            else:
                if any((op.operation != "set_field" if target.kind == "DOCX_CONTROL" else
                        op.operation not in {"input", "replace_range", "delete_range"}) for op in operations):
                    raise DocumentError("UNSUPPORTED")
                edit_node = node.find(W + "sdtContent") if target.kind == "DOCX_CONTROL" else node
                _replace_text(edit_node, edited_text(target, operations, facts))
        with zipfile.ZipFile(BytesIO(source)) as original:
            output_xml = _serialize_document(root, original.read("word/document.xml"))
        output_buffer = BytesIO()
        with zipfile.ZipFile(BytesIO(source)) as original, zipfile.ZipFile(output_buffer, "w") as output:
            for entry in original.infolist():
                output.writestr(entry, output_xml if entry.filename == "word/document.xml" else original.read(entry))
        result = output_buffer.getvalue()
        if len(result) > MAX_BYTES:
            raise DocumentError("LIMIT_EXCEEDED")
        reopened, output_nodes, output_root = self._inspect_bytes(result)
        after = {target.targetId: target for target in reopened.targets}
        if before.keys() != after.keys() or _signature(output_root) != signature:
            raise DocumentError("VALIDATION_FAILED", reason="DOCX_STRUCTURE_OR_STYLE_CHANGED")
        for target_id, target in before.items():
            expected = (edited_text(target, grouped[target_id], facts)
                        if target_id in grouped and target.kind != "CHECKBOX" else target.currentText)
            contains_edited_target = target_id not in grouped and any(
                nodes[edited_id] in nodes[target_id].iter() for edited_id in grouped)
            if after[target_id].currentText != expected and not contains_edited_target:
                raise DocumentError("VALIDATION_FAILED", reason="DOCX_TARGET_TEXT_MISMATCH")
        for target_id, old_state in check_states.items():
            checked = output_nodes[target_id].find("./" + W + "sdtPr/" + W14 + "checkbox/" + W14 + "checked")
            if checked is None or checked.get(W14 + "val") != ("1" if target_id in grouped else old_state):
                raise DocumentError("VALIDATION_FAILED", reason="DOCX_CHECKBOX_STATE_MISMATCH")
        if digest(path.read_bytes()) != document.sourceSha256:
            raise DocumentError("SOURCE_CHANGED")
        return result, {"requested": len(grouped), "resolved": len(grouped), "applied": len(grouped),
                        "verified": len(grouped), "unresolved": 0, "xml": "PASSED", "reopened": True,
                        "styleStructure": "PASSED", "render": "NOT_RUN"}
