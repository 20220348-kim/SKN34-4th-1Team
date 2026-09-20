"""Reconcile Hangeul's form analysis with its independently inspected edit addresses."""
from collections import defaultdict
import re
import zipfile
from xml.etree import ElementTree

from app.application_preparation.document_contract import DocumentError, mapping_label_key


def table_contexts(tables: list[dict], fields: list[dict]) -> dict[str, dict]:
    detected = defaultdict(list)
    for field in fields:
        # Body-field numbering excludes empty paragraphs in upstream analyze_form.
        # Only cell IDs can be joined to addressed edits without losing identity.
        if str(field.get("field_id", "")).startswith("t"):
            detected[field["field_id"].split("#", 1)[0]].append(field)
    contexts = {}
    for table in tables:
        cells = table["cells"]
        top_row = min((cell["row"] for cell in cells), default=0)
        column_labels = [cell["text"].strip() for cell in cells if cell["row"] == top_row and cell["text"].strip()]
        for cell in cells:
            key = cell["field_id"]
            if key in contexts or key != f"t{table['index']}.r{cell['row']}.c{cell['col']}":
                raise DocumentError("VALIDATION_FAILED", reason="HWPX_TABLE_ADDRESS_MISMATCH")
            candidates = detected[key]
            left = [c for c in cells if c["row"] <= cell["row"] < c["row"] + c["row_span"]
                    and c["col"] + c["col_span"] <= cell["col"] and c["text"].strip()]
            above = [c for c in cells if c["col"] <= cell["col"] < c["col"] + c["col_span"]
                     and c["row"] + c["row_span"] <= cell["row"] and c["text"].strip()
                     and not detected[c["field_id"]]]
            adjacent = []
            if left:
                adjacent.append(max(left, key=lambda c: c["col"]))
            if above:
                nearest_row = max(c["row"] for c in above)
                adjacent.extend(c for c in above if c["row"] == nearest_row)
            labels = [f["label"] for f in candidates if f.get("label")]
            labels.extend(c["text"] for c in adjacent)
            labels = list(dict.fromkeys(label.strip() for label in labels if mapping_label_key(label)))
            contexts[key] = {
                "table": table["index"], "row": cell["row"], "col": cell["col"],
                "rowSpan": cell["row_span"], "colSpan": cell["col_span"],
                "sourceCellText": cell["text"], "fieldLabels": labels,
                "columnLabels": column_labels,
                "rowLabels": [max(left, key=lambda c: c["col"])["text"]] if left else [],
                "formFields": [{k: f.get(k) for k in ("field_id", "label", "kind", "insert_after", "capacity_hint")}
                               for f in candidates],
                "labelCells": [{"targetId": c["field_id"], "text": c["text"]} for c in adjacent],
            }
    return contexts


def source_table_headings(path):
    """Keep literal preceding body text; table cells/labels still come from MCP."""
    ns = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph"}
    headings, index = {}, 0
    with zipfile.ZipFile(path) as archive:
        sections = sorted((name for name in archive.namelist() if re.fullmatch(r"Contents/section\d+\.xml", name)),
                          key=lambda name: int(re.search(r"\d+", name).group()))
        for name in sections:
            preceding = []
            for paragraph in ElementTree.fromstring(archive.read(name)):
                tables = paragraph.findall(".//hp:tbl", ns)
                if not tables:
                    text = "".join(t.text or "" for t in paragraph.findall(".//hp:t", ns)).strip()
                    if text:
                        preceding.append(text[:1000])
                for _ in tables:
                    index += 1
                    headings[index] = preceding[-3:]
    return headings


async def analyze_cells(session, path, requested_fields):
    table_map = await session.call("get_table_map", {"path": str(path)})
    form = await session.call("analyze_form", {"path": str(path)})
    contexts = table_contexts(table_map["tables"], form["fields"])
    headings = source_table_headings(path)
    for cell in contexts.values():
        cell["tableHeadings"] = headings.get(cell["table"], [])
    # Search exact document labels, not rewritten UI labels such as "first row / name".
    wanted = {mapping_label_key(field.label.rsplit(" / ", 1)[-1]) for field in requested_fields}
    labels = {mapping_label_key(label): label for cell in contexts.values() for label in cell["fieldLabels"]
              if mapping_label_key(label) in wanted}
    for label in sorted(labels.values()):
        match = await session.call("find_cell_by_label", {"path": str(path), "label": label})
        state = match.get("state")
        if state not in {"resolved", "ambiguous_label", "missing"}:
            raise DocumentError("VALIDATION_FAILED", reason="HWPX_LABEL_RESULT_INVALID")
        ids = ([match["value_field_id"]] if state == "resolved" else match.get("candidate_field_ids", []))
        for field_id in ids:
            key = field_id.split("#", 1)[0]
            if key not in contexts:
                raise DocumentError("VALIDATION_FAILED", reason="HWPX_LABEL_TARGET_MISSING")
            contexts[key].setdefault("labelSearch", []).append({"label": label, "state": state})
    return contexts


async def discovery_layouts(request):
    import base64
    from pathlib import Path
    from tempfile import TemporaryDirectory
    from app.application_preparation.document_adapters import HwpxDocumentAdapter

    layouts = {}
    for source in request.documents:
        if source.sourceBase64 is None:
            continue
        with TemporaryDirectory(prefix="govbiz-form-") as directory:
            path = Path(directory) / "source.hwpx"
            path.write_bytes(base64.b64decode(source.sourceBase64, validate=True))
            document = await HwpxDocumentAdapter().inspect(path)
            layouts[source.documentIndex] = [{"targetId": target.targetId, "text": target.currentText,
                "editable": target.editable, "kind": target.kind,
                "inputCandidate": target.editable and (not target.currentText.strip()
                    or bool(target.nativeLocator.get("formFields"))
                    or bool(re.fullmatch(r"[\s._]+", target.currentText))),
                "structure": target.nativeLocator, "context": target.context}
                for target in document.targets if target.kind in {"cell", "body_para"}]
    return layouts
