"""Reconcile Hangeul's form analysis with its independently inspected edit addresses."""
from collections import defaultdict
import re
import zipfile
from xml.etree import ElementTree

from app.application_preparation.document_contract import DocumentError, mapping_label_key

NUMBERED_HEADING = re.compile(r"^(?:제\s*\d+\s*[장절항]|\d+[.)]|[Ⅰ-Ⅻ]+[.)]|[가-힣][.)]|[①-⑳])\s*")


def classify_table(cells: list[dict], detected: dict[str, list[dict]]) -> tuple[str, float, list[str], bool]:
    """Classify without changing the table; uncertain input-like structures stay eligible."""
    fields = [field for cell in cells for field in detected[cell["field_id"]]]
    form_fields = len(fields)
    rows = {cell["row"] for cell in cells}
    visible_texts = [cell.get("text", "").strip() for cell in cells if cell.get("text", "").strip()]
    section_marker = any(re.fullmatch(r"(?:\d+|붙임\s*\d+(?:-\d+)?)", text) for text in visible_texts)
    spacer_fields = fields and all(
        field.get("kind") == "empty_cell" and (field.get("capacity_hint") or 0) <= 1
        for field in fields
    )
    if len(cells) <= 6 and len(rows) <= 2 and section_marker and spacer_fields:
        return "LAYOUT_TABLE", 0.98, ["numbered_section_banner", "empty_spacer_fields"], False
    if form_fields:
        return "FORM_TABLE", 1.0, ["analyze_form_field"], False
    if not cells:
        return "DECORATIVE_TABLE", 1.0, ["no_cells"], False
    empty_cells = [cell for cell in cells if cell.get("is_empty") or not cell.get("text", "").strip()]
    if empty_cells:
        return "AMBIGUOUS", 0.0, ["no_confirmed_form_field", "contains_empty_cells"], True
    cols = {cell["col"] for cell in cells}
    text = " ".join(cell["text"] for cell in cells)
    if len(rows) == 1 and len(cells) >= 2 and re.search(r"(?:→|⇒|➜|->)", text):
        return "LAYOUT_TABLE", 0.95, ["single_row_flow_arrows", "no_form_fields"], False
    if len(rows) >= 2 and len(cols) >= 2:
        return "DATA_TABLE", 0.65, ["filled_grid", "no_form_fields"], True
    return "AMBIGUOUS", 0.0, ["insufficient_structural_evidence"], True


def semantic_heading(
    headings: list[str], *, table_classification: str, form_field_count: int,
    occurrences: dict[str, int],
) -> tuple[str | None, float | None, list[str], str]:
    """Combine only observable structure signals; never invent style evidence."""
    bounded = [value.strip() for value in headings if value.strip() and len(value.strip()) <= 100]
    candidate = (next((value for value in reversed(bounded) if NUMBERED_HEADING.match(value)), "")
                 or next(reversed(bounded), ""))
    if not candidate or len(candidate) > 100:
        return None, None, ["no_bounded_preceding_text"], "PRESERVED"
    compact = "".join(candidate.split())
    if (re.match(r"^(?:[*※◦○•]|\s*-\s+)", candidate)
            or re.match(r"^\(\s*단위\s*[:：]", candidate)
            or re.search(r"(?:장관|청장|시장|도지사)(?:귀하)?$", compact)):
        return None, None, ["note_bullet_or_signature"], "PRESERVED"
    if re.search(r"(?:다|함|음)[.!?]$", candidate):
        return None, None, ["sentence_ending"], "PRESERVED"
    reasons = []
    confidence = 0.0
    numbered = bool(NUMBERED_HEADING.match(candidate))
    if numbered:
        confidence += 0.4
        reasons.append("numbered_text")
    if len(candidate) <= 40:
        confidence += 0.2
        reasons.append("short_text")
    if table_classification == "FORM_TABLE":
        confidence += 0.3
        reasons.append("followed_by_form_table")
    if form_field_count >= 2:
        confidence += 0.15
        reasons.append("multiple_following_form_fields")
    normalized = mapping_label_key(candidate)
    if normalized and occurrences.get(normalized, 0) == 1:
        confidence += 0.05
        reasons.append("unique_nearby_text")
    confidence = min(confidence, 0.95)
    if confidence >= 0.65:
        return candidate, confidence, reasons, "ACCEPTED"
    if confidence >= 0.4:
        return None, confidence, reasons + ["insufficient_combined_evidence"], "REVIEW_REQUIRED"
    return None, confidence, reasons + ["weak_context_only"], "PRESERVED"


def annotate_semantic_reading_order(targets) -> None:
    """Assign local semantic ranks without moving targets or changing native locators."""
    cell_pattern = re.compile(r"^t(?P<table>\d+)\.r(?P<row>\d+)\.c(?P<col>\d+)$")
    groups = defaultdict(list)
    for native_index, target in enumerate(targets):
        target.analysis.nativeOrderIndex = native_index
        target.analysis.semanticOrderIndex = native_index
        target.analysis.readingOrderIndex = native_index
        target.analysis.readingOrderConfidence = 1.0
        target.analysis.readingOrderStatus = "PRESERVED"
        target.analysis.readingOrderReason = ["native_order_preserved"]
        cell_id = target.nativeLocator.get("parent") or (target.targetId if target.kind == "cell" else None)
        match = cell_pattern.fullmatch(cell_id or "")
        if match:
            groups[int(match.group("table"))].append((native_index, target, match))

    for entries in groups.values():
        classifications = {target.analysis.tableClassification for _, target, _ in entries}
        if classifications != {"FORM_TABLE"}:
            if "AMBIGUOUS" in classifications:
                for _, target, _ in entries:
                    target.analysis.readingOrderStatus = "REVIEW_REQUIRED"
                    target.analysis.readingOrderConfidence = 0.0
                    target.analysis.readingOrderReason = ["ambiguous_table_structure"]
            else:
                for _, target, _ in entries:
                    target.analysis.readingOrderReason = ["non_form_table_preserved"]
            continue
        native_positions = sorted(index for index, _, _ in entries)
        if native_positions != list(range(native_positions[0], native_positions[-1] + 1)):
            _mark_reading_review(entries, "interleaved_table_targets")
            continue
        cells = [(index, target, match) for index, target, match in entries if target.kind == "cell"]
        coordinates = {(int(match.group("row")), int(match.group("col"))) for _, _, match in cells}
        if len(coordinates) != len(cells) or any(
            target.nativeLocator.get("rowSpan", 1) != 1 or target.nativeLocator.get("colSpan", 1) != 1
            for _, target, _ in cells
        ):
            _mark_reading_review(entries, "merged_or_duplicate_cell_structure")
            continue
        form_cells = [(target, match) for _, target, match in cells if target.nativeLocator.get("formFields")]
        normalized_labels = [tuple(mapping_label_key(label) for label in target.nativeLocator.get("fieldLabels", []))
                             for target, _ in form_cells]
        if not form_cells or len(normalized_labels) != len(set(normalized_labels)):
            _mark_reading_review(entries, "repeated_or_missing_form_group")
            continue
        safe_pairs = True
        for target, input_match in form_cells:
            label_ids = [item.get("targetId", "") for item in target.nativeLocator.get("labelCells", [])]
            label_matches = [cell_pattern.fullmatch(value) for value in label_ids]
            if not label_matches or not any(
                match and match.group("table") == input_match.group("table")
                and match.group("row") == input_match.group("row")
                and int(match.group("col")) < int(input_match.group("col"))
                for match in label_matches
            ):
                safe_pairs = False
                break
        if not safe_pairs:
            _mark_reading_review(entries, "no_same_row_label_input_pair")
            continue
        desired = sorted(entries, key=lambda item: (
            int(item[2].group("row")), int(item[2].group("col")),
            0 if item[1].kind == "cell" else 1, item[0],
        ))
        for semantic_index, (_, target, _) in zip(native_positions, desired):
            target.analysis.semanticOrderIndex = semantic_index
            target.analysis.readingOrderIndex = semantic_index
            if target.analysis.nativeOrderIndex != semantic_index:
                target.analysis.readingOrderStatus = "LOCAL_REORDERED"
                target.analysis.readingOrderConfidence = 0.95
                target.analysis.readingOrderReason = ["same_table_adjacent_label_input_pair"]
            else:
                target.analysis.readingOrderReason = ["simple_label_input_rows_native_order"]


def _mark_reading_review(entries, reason: str) -> None:
    for _, target, _ in entries:
        target.analysis.readingOrderStatus = "REVIEW_REQUIRED"
        target.analysis.readingOrderConfidence = 0.0
        target.analysis.readingOrderReason = [reason]


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
        classification, confidence, evidence, review = classify_table(cells, detected)
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
                "tableClassification": classification,
                "tableClassificationConfidence": confidence,
                "tableClassificationEvidence": evidence,
                "tableClassificationReviewRequired": review,
                # Only high-confidence layout tables are excluded. Ambiguous tables remain eligible.
                "bindingEligible": classification != "LAYOUT_TABLE" or confidence < 0.9,
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
    occurrences = defaultdict(int)
    for values in headings.values():
        for value in values:
            if key := mapping_label_key(value):
                occurrences[key] += 1
    table_cells_by_index = defaultdict(list)
    for cell in contexts.values():
        table_cells_by_index[cell["table"]].append(cell)
    for table_index, table_cells in table_cells_by_index.items():
        form_field_count = sum(bool(item["formFields"]) for item in table_cells)
        section, confidence, reasons, status = semantic_heading(
            headings.get(table_index, []), table_classification=table_cells[0]["tableClassification"],
            form_field_count=form_field_count, occurrences=occurrences,
        )
        for cell in table_cells:
            cell["tableHeadings"] = headings.get(table_index, [])
            cell["semanticSection"] = section
            cell["headingConfidence"] = confidence
            cell["headingReason"] = reasons
            cell["headingStatus"] = status
            cell["sectionPath"] = [section] if section else []
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
                    or bool(re.fullmatch(r"[\s._]+", target.currentText)))
                    and target.nativeLocator.get("bindingEligible", True),
                "structure": target.nativeLocator, "analysis": target.analysis.model_dump(),
                "context": target.context}
                for target in document.targets if target.kind in {"cell", "body_para"}]
    return layouts
