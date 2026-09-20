"""Concrete integrations for the selected file editors (no format fallbacks)."""
import asyncio
import base64
from collections import defaultdict
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import zipfile
from xml.etree import ElementTree


from app.application_preparation.document_contract import (
    DocumentError, DocumentMap, ENGINES, GenerateDocumentRequest, MAX_BYTES,
    NativeTarget, WritePlan, digest, edited_text,
)
from app.application_preparation.document_mcp import document_session
from app.application_preparation.hwpx_form_analysis import analyze_cells
from app.application_preparation.pdf_form_detection import checked_regions, MODEL_SHA256

# One short-lived detector per AI worker; do not retain model memory between jobs.
_pdf_inspection_lock = asyncio.Semaphore(1)


def read_output(path: Path, root: Path) -> bytes:
    if path.is_symlink() or not path.is_file() or path.resolve().parent != root.resolve():
        raise DocumentError("VALIDATION_FAILED")
    if not 0 < path.stat().st_size <= MAX_BYTES:
        raise DocumentError("LIMIT_EXCEEDED")
    return path.read_bytes()


def validate_hwpx(path: Path):
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > 256 or len({e.filename for e in entries}) != len(entries) or sum(e.file_size for e in entries) > MAX_BYTES:
            raise DocumentError("LIMIT_EXCEEDED")
        if archive.read("mimetype").strip() != b"application/hwp+zip":
            raise DocumentError("UNSUPPORTED")
        for entry in entries:
            if entry.filename.endswith(".xml"):
                data = archive.read(entry)
                if b"<!DOCTYPE" in data.replace(b"\x00", b"").upper() or b"<!ENTITY" in data.replace(b"\x00", b"").upper():
                    raise DocumentError("UNSUPPORTED")
                ElementTree.fromstring(data)


class HwpxDocumentAdapter:
    async def inspect(self, path: Path, fields=(), *, analyze=True) -> DocumentMap:
        validate_hwpx(path)
        async with document_session("hwpx", path.parent) as session:
            result = await session.call("inspect_editable_regions", {"path": str(path), "compact": False})
            contexts = await analyze_cells(session, path, fields) if analyze else {}
        if result["source_sha256"] != digest(path.read_bytes()):
            raise DocumentError("SOURCE_CHANGED")
        targets = []
        for item in [*result["regions"], *result["unsupported_controls"]]:
            locator = {key: item.get(key) for key in ("target", "kind", "section", "table", "row", "col", "paragraph_count")}
            if item["kind"] == "cell" and analyze:
                source_context = contexts.get(item["target"])
                if source_context is None or "".join(source_context["sourceCellText"].split()) != "".join(item["text"].split()):
                    raise DocumentError("SOURCE_CHANGED", reason="HWPX_TABLE_LAYOUT_MISMATCH")
                locator.update({key: value for key, value in source_context.items() if key != "sourceCellText"})
            context = str({k: v for k, v in locator.items() if v is not None})
            targets.append(NativeTarget(targetId=item["target"], nativeLocator=locator, kind=item["kind"],
                                        currentText=item["text"], context=context[:1000], editable=item["editable"],
                                        unsupportedReason=item.get("reason")))
            for paragraph in item.get("paragraphs", []):
                targets.append(NativeTarget(targetId=paragraph["target"], nativeLocator={**locator, "target": paragraph["target"], "kind": "paragraph", "parent": item["target"]},
                                            kind="paragraph", currentText=paragraph["text"], context=item["text"][:1000],
                                            editable=item["editable"], unsupportedReason=item.get("reason")))
        for i, target in enumerate(targets):
            target.context = (target.context + " | " + " | ".join(t.currentText for t in targets[max(0, i-2):i+3]))[:1000]
        return DocumentMap(sourceSha256=result["source_sha256"], format="hwpx", engineVersion=ENGINES["hwpx"], targets=targets)

    async def apply(self, path: Path, document: DocumentMap, plan: WritePlan, facts: dict[str, str]) -> tuple[bytes, dict]:
        fresh = await self.inspect(path, analyze=False)
        targets = {t.targetId: t for t in fresh.targets}
        grouped = defaultdict(list)
        for operation in plan.operations:
            if operation.operation in {"set_check", "set_field"}:
                raise DocumentError("UNSUPPORTED")
            if targets[operation.targetId].currentText != operation.expectedText:
                raise DocumentError("SOURCE_CHANGED")
            grouped[operation.targetId].append(operation)
        edits = [{"target": key, "kind": targets[key].nativeLocator["kind"], "operation": "replace_text",
                  "expected_text": targets[key].currentText, "value": edited_text(targets[key], operations, facts)}
                 for key, operations in grouped.items()]
        for edit in edits:
            if edit["kind"] == "cell" and "\n" in edit["value"] and not edit["expected_text"].strip():
                children = [t for t in targets.values() if t.nativeLocator.get("parent") == edit["target"]]
                if len(children) != 1:
                    raise DocumentError("UNSUPPORTED")
                # Resolve the actually inspected sole paragraph; never invent an ordinal.
                edit.update(target=children[0].targetId, kind="paragraph", expected_text=children[0].currentText)
        output = path.parent / "completed.hwpx"
        async with document_session("hwpx", path.parent) as session:
            # This tool estimates cell width; it is not a Hancom page renderer.
            fit_values = {}
            for edit in edits:
                cell = targets[edit["target"]].nativeLocator.get("parent", edit["target"])
                if cell.startswith("t"):
                    fit_values[cell] = edit["value"]
            fit = await session.call("analyze_formfit", {"path": str(path), "values": fit_values})
            if any(warning.get("overflow") for warning in fit["warnings"]):
                raise DocumentError("OVERFLOW", reason="HWPX_CELL_WIDTH_EXCEEDED")
            preview = await session.call("preview_addressed_edits", {"path": str(path), "edits": edits})
            counts = preview["counts"]
            if counts["requested"] != len(edits) or counts["resolved"] != len(edits) or counts["unresolved"] != 0 or preview["unresolved"]:
                raise DocumentError("MAPPING_FAILED")
            applied = await session.call("apply_addressed_edits", {"session_id": preview["session_id"], "out_path": str(output)})
            if applied["counts"]["applied"] != len(edits) or applied["counts"]["unresolved"]:
                raise DocumentError("VALIDATION_FAILED")
            validate_hwpx(output)
            expected = []
            for edit in preview["edits"]:
                expected.extend(edit.get("verify_expansion") or [{"target": edit["target"], "expected_text": edit["after_text"]}])
            verified = await session.call("govbiz_verify_hwpx_edits", {"source_path": str(path), "output_path": str(output), "expected_targets": expected})
            if verified["verified"] is not True or verified["counts"]["verified"] != len(expected):
                raise DocumentError("VALIDATION_FAILED")
        data = read_output(output, path.parent)
        validate_hwpx(output)
        if digest(path.read_bytes()) != document.sourceSha256:
            raise DocumentError("SOURCE_CHANGED")
        return data, {"requested": len(edits), "resolved": len(edits), "applied": len(edits), "verified": len(expected), "unresolved": 0,
                      "xml": "PASSED", "fitChecked": fit["checked"], "fitPolicy": "ESTIMATE_ONLY", "render": "NOT_RUN", "hancom": "NOT_RUN"}


class PdfDocumentAdapter:
    async def inspect(self, path: Path, request: GenerateDocumentRequest) -> DocumentMap:
        async with _pdf_inspection_lock:
            return await self._inspect(path, request)

    async def _inspect(self, path: Path, request: GenerateDocumentRequest) -> DocumentMap:
        if not path.read_bytes().startswith(b"%PDF-") or not request.pageImages:
            raise DocumentError("UNSUPPORTED")
        fields = {field.targetId: field for field in request.pdfFields}
        targets = []
        for target in request.pdfTargets:
            field = fields.get(target.id)
            is_field = target.id.startswith("pdf-field:")
            targets.append(NativeTarget(targetId=target.id, nativeLocator=field.model_dump() if field else {"target": target.id, "pageText": target.text},
                kind="PDF_FIELD" if is_field else "PDF_PAGE", label=target.context, currentText=target.text if is_field else "", context=target.context,
                editable=(field.editable if field else not is_field), unsupportedReason=None if (field and field.editable) or not is_field else "FIELD_NOT_EDITABLE_OR_METADATA_MISSING"))
        async with document_session("pdf", path.parent) as session:
            text = await session.call("pdf_get_text", {"pdf_path": str(path)})
            if text["page_count"] != len(request.pageImages) or not 1 <= text["page_count"] <= 50:
                raise DocumentError("LIMIT_EXCEEDED")
            if not text["text"].strip():
                raise DocumentError("UNSUPPORTED")
            geometry = await session.call("govbiz_pdf_text_regions", {"pdf_path": str(path)})
            if geometry["page_count"] != text["page_count"] or len(geometry["pages"]) != text["page_count"]:
                raise DocumentError("VALIDATION_FAILED", reason="PDF_GEOMETRY_PAGE_MISMATCH")
            detections = None
            if not fields:
                image_paths = []
                for page, encoded in enumerate(request.pageImages):
                    image_path = path.parent / f"detection-{page}.png"
                    image_path.write_bytes(base64.b64decode(encoded, validate=True))
                    image_paths.append(str(image_path))
                detections = await session.call("govbiz_pdf_detect_inputs", {"image_paths": image_paths})
                if (detections["modelSha256"] != MODEL_SHA256 or detections["page_count"] != text["page_count"]
                        or [page["page"] for page in detections["pages"]] != list(range(text["page_count"]))):
                    raise DocumentError("VALIDATION_FAILED", reason="PDF_DETECTION_SOURCE_MISMATCH")
            for page, item in enumerate(geometry["pages"]):
                if item["page"] != page:
                    raise DocumentError("VALIDATION_FAILED", reason="PDF_GEOMETRY_PAGE_MISMATCH")
                for target in targets:
                    if target.targetId == f"page-{page}":
                        target.nativeLocator["printedTextRegions"] = item["regions"]
                        target.editable = False
                        target.unsupportedReason = "PAGE_IS_READ_ONLY"
                if not fields:
                    for region in checked_regions(detections["pages"][page]["detections"], item["regions"], item.get("blankRegions", [])):
                        targets.append(NativeTarget(targetId=f"pdf-blank:{page}:{region['id']}", kind="PDF_INPUT", currentText="",
                            label=" / ".join(region["labels"])[:1000], context=f"FFDetr input on PDF page {page+1}; no printed-word overlap",
                            nativeLocator={"page": page, "pageTarget": f"page-{page}", "box": region["box"], "fieldLabels": region["labels"],
                                           "detectorConfidence": region["confidence"], "detectorSha256": MODEL_SHA256}))
            # Do not use pdf_inspect: upstream swallows individual page failures.
            for page in range(text["page_count"]):
                layout = await session.call("pdf_get_text_layout", {"pdf_path": str(path), "page": page})
                if not layout["blocks"] and any(t.id == f"page-{page}" and t.text.strip() for t in request.pdfTargets):
                    raise DocumentError("UNSUPPORTED")
                paragraphs = await session.call("pdf_detect_paragraphs", {"pdf_path": str(path), "page": page})
                for index, paragraph in enumerate(paragraphs["paragraphs"]):
                    targets.append(NativeTarget(targetId=f"pdf-text:{page}:{index}", kind="PDF_TEXT", currentText=paragraph["text"],
                                                nativeLocator={"page": page, "bbox": paragraph["bbox"], "fontName": paragraph["font_name"],
                                                               "fontSize": paragraph["font_size"], "geometryVerified": False},
                                                context=f"PDF page {page + 1}; native paragraph; use image for visual bounds"))
        return DocumentMap(sourceSha256=digest(path.read_bytes()), format="pdf", engineVersion=ENGINES["pdf"], targets=targets)

    async def apply(self, path: Path, document: DocumentMap, plan: WritePlan, facts: dict[str, str]) -> tuple[bytes, dict]:
        targets = {t.targetId: t for t in document.targets}
        current = path
        deletions = [op for op in plan.operations if op.operation == "delete_range"]
        warnings = []
        async with document_session("pdf", path.parent) as session:
            for index, operation in enumerate(deletions):
                target = targets[operation.targetId]
                if target.kind != "PDF_TEXT":
                    raise DocumentError("UNSUPPORTED")
                search = target.currentText[operation.start:operation.end]
                # Refuse a repeated occurrence rather than deleting another form's example.
                matches = await session.call("pdf_find_text", {"pdf_path": str(current), "search": search})
                if len(matches["matches"]) != 1 or matches["matches"][0]["page"] != target.nativeLocator["page"]:
                    raise DocumentError("MAPPING_FAILED")
                output = path.parent / f"cleaned-{index}.pdf"
                result = await session.call("pdf_replace_single", {"pdf_path": str(current), "search": search,
                    "replacement": "", "output_path": str(output), "match_index": 0, "reflow": False})
                fidelity = result["fidelity"]
                if result.get("warnings") or fidelity["overflow_detected"] or fidelity["glyphs_missing"] or fidelity["font_substituted"]:
                    raise DocumentError("VALIDATION_FAILED")
                if fidelity["degradations"]:
                    if any(d["kind"] != "positioning_adjustment_skipped" for d in fidelity["degradations"]):
                        raise DocumentError("VALIDATION_FAILED")
                    proof = await session.call("govbiz_verify_pdf_deletion", {"source_path": str(current), "output_path": str(output), "expected_text": search})
                    if proof.get("verified") is not True or proof.get("sourceSha256") != digest(current.read_bytes()) or proof.get("outputSha256") != digest(output.read_bytes()):
                        raise DocumentError("VALIDATION_FAILED")
                    warnings.append({"code": "positioning_adjustment_skipped", "disposition": "WHOLE_TEXT_OBJECT_DELETION_VERIFIED", "changedTextObjects": proof["changedTextObjects"]})
                read_output(output, path.parent)
                remaining = await session.call("pdf_find_text", {"pdf_path": str(output), "search": search})
                if remaining["matches"]:
                    raise DocumentError("VALIDATION_FAILED")
                current = output
        placements = []
        for op in plan.operations:
            if op.operation == "delete_range":
                continue
            if op.operation != "set_field" or targets[op.targetId].kind not in {"PDF_PAGE", "PDF_FIELD", "PDF_INPUT"}:
                raise DocumentError("UNSUPPORTED")
            target = targets[op.targetId]
            placements.append({"factId": op.valueRef,
                "targetId": target.nativeLocator["pageTarget"] if target.kind == "PDF_INPUT" else op.targetId,
                "box": target.nativeLocator["box"] if target.kind == "PDF_INPUT" else op.box.model_dump() if op.box else None})
        return read_output(current, path.parent), {"stage": "PDFBOX_REQUIRED", "deletionsVerified": len(deletions), "placements": placements, "warnings": warnings, "render": "NOT_RUN"}


class HwpDocumentAdapter:
    def inspect(self, request: GenerateDocumentRequest) -> DocumentMap:
        """Core's authenticated hwplib inspection is the authority for binary HWP addresses."""
        source = base64.b64decode(request.sourceBase64, validate=True)
        if not source.startswith(bytes.fromhex("d0cf11e0a1b11ae1")):
            raise DocumentError("UNSUPPORTED")
        if not request.hwpTargets or len({t.id for t in request.hwpTargets}) != len(request.hwpTargets):
            raise DocumentError("MAPPING_FAILED")
        return DocumentMap(sourceSha256=request.sourceSha256, format="hwp", engineVersion=ENGINES["hwp"], targets=[
            NativeTarget(targetId=t.id, nativeLocator={"paragraph": t.id, "group": t.groupId},
                         kind="CHECKBOX" if t.kind == "CHECKBOX" else "paragraph", label=t.text if t.kind == "CHECKBOX" else "",
                         currentText=t.text, context=t.context, editable=t.editable, unsupportedReason=t.unsupportedReason)
            for t in request.hwpTargets
        ])

    def stage(self, source: bytes, plan: WritePlan) -> tuple[bytes, dict]:
        # No binary edits in Python. Core independently validates and applies these exact ranges.
        return source, {"stage": "HWPLIB_REQUIRED", "render": "NOT_RUN", "placements": [
            {"factId": op.valueRef, "targetId": op.targetId, "box": None} for op in plan.operations if op.valueRef is not None
        ]}


async def assist_with_kordoc(path: Path, document: DocumentMap):
    # Only missing primary context needs a second reader. Its addresses never become edit addresses.
    texts = [t.currentText for t in document.targets if t.currentText.strip() and not t.nativeLocator.get("parent")]
    needs_context = any(not t.context.strip() for t in document.targets if t.editable)
    repeated_labels = len(texts) != len(set(texts))
    if not needs_context and not repeated_labels:
        return
    with TemporaryDirectory(prefix="govbiz-read-") as directory:
        root = Path(directory).resolve()
        copy = root / ("read-only" + path.suffix)
        shutil.copyfile(path, copy)
        copy.chmod(0o400)
        try:
            async with document_session("kordoc", root) as session:
                result = await session.call("parse_document", {"file_path": str(copy), "ocr": False, "formula_ocr": False,
                    "remove_header_footer": False, "keep_empty_paragraphs": True, "keep_trailing_empty_cols": True})
            if digest(copy.read_bytes()) != document.sourceSha256:
                raise DocumentError("VALIDATION_FAILED")
            text = result["text"]
            # Only attach exact primary text matches, never kordoc cell IDs or inferred coordinates.
            matched = [t for t in document.targets if t.currentText.strip() and t.currentText in text]
            if not matched:
                raise DocumentError("MAPPING_FAILED")
            document.auxiliaryText = "\n".join(t.currentText for t in matched)[:40000]
            document.auxiliaryStatus = "READ_ONLY_EXACT_TEXT_MATCHED"
        finally:
            copy.chmod(0o600)
