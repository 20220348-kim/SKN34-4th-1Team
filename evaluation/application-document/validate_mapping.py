"""Evaluate fixed human-reviewed HWPX mappings and a ground-truth native write."""
import argparse
import asyncio
import base64
from copy import deepcopy
import json
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))

from app.application_preparation.document_adapters import HwpxDocumentAdapter
from app.application_preparation.document_contract import (
    EditOperation,
    GenerateDocumentRequest,
    PlanSelection,
    digest,
    mapping_label_key,
    mapping_label_matches,
    validate_plan,
)
from app.application_preparation.hwpx_form_analysis import annotate_semantic_reading_order


def preserve_printed_labels(document, expected):
    labels = {mapping_label_key(field["label"]) for field in expected["fields"]}
    labels.add(mapping_label_key(expected["scopeTitle"]))
    field_labels = labels.copy()
    labels.update(key for target in document.targets for label in target.nativeLocator.get("fieldLabels", [])
                  if (key := mapping_label_key(label)) and
                  (key in field_labels or len(key) >= 2 and any(key in field for field in field_labels)))
    printed_label_cells = {target.targetId for target in document.targets
                           if target.kind == "cell" and mapping_label_key(target.currentText) in labels}
    for target in document.targets:
        if target.kind in {"cell", "paragraph", "body_para", "PDF_TEXT"} and (
                mapping_label_key(target.currentText) in labels or
                target.kind == "paragraph" and target.nativeLocator.get("parent") in printed_label_cells):
            if not (target.kind == "body_para" and target.currentText.rstrip().endswith((":", "："))):
                target.editable = False
                target.unsupportedReason = "PRESERVED_FIELD_LABEL_OR_TITLE"


def mapping_targets(document):
    parents = {target.nativeLocator.get("parent") for target in document.targets}
    return [target for target in document.targets if target.targetId not in parents and target.editable
            and target.kind not in {"PDF_TEXT", "PDF_PAGE"}
            and target.nativeLocator.get("bindingEligible", True)]


def address(locator):
    return {key: locator.get(key) for key in ("target", "kind", "section", "table", "row", "col", "parent")}


async def evaluate(source: Path, expected_path: Path) -> dict:
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    source_bytes = source.read_bytes()
    if digest(source_bytes) != expected["sourceSha256"]:
        raise ValueError("source hash mismatch")
    adapter = HwpxDocumentAdapter()
    document = await adapter.inspect(source)
    annotate_semantic_reading_order(document.targets)
    detected_headings = sorted({target.analysis.semanticSection for target in document.targets
                                if target.analysis.headingStatus == "ACCEPTED" and target.analysis.semanticSection})
    expected_headings = expected["headings"]
    heading_review_tables = {target.nativeLocator.get("table") for target in document.targets
                             if target.analysis.headingStatus == "REVIEW_REQUIRED"}
    reading_review = [target for target in document.targets
                      if target.analysis.readingOrderStatus == "REVIEW_REQUIRED"]
    preserve_printed_labels(document, expected)
    targets = mapping_targets(document)
    target_ids = {target.targetId for target in targets}
    results = []
    for field in expected["fields"]:
        expected_id = field["expectedTargetId"]
        if expected_id not in target_ids:
            raise ValueError(f"ground truth target unavailable: {expected_id}")
        candidates = sorted(target.targetId for target in targets
                            if target.nativeLocator.get("fieldLabels")
                            and mapping_label_matches(field["label"], target))
        scope_key = mapping_label_key(expected["scopeTitle"])
        scoped_candidates = sorted(target.targetId for target in targets if target.targetId in candidates and scope_key in
                                   mapping_label_key(" ".join([
                                       *target.nativeLocator.get("tableHeadings", []),
                                       *target.nativeLocator.get("columnLabels", []),
                                       *target.analysis.sectionPath,
                                   ])))
        if candidates == [expected_id]:
            disposition = "CORRECT"
        elif not candidates:
            disposition = "UNMAPPED"
        elif expected_id not in candidates:
            disposition = "WRONG"
        else:
            disposition = "AMBIGUOUS"
        if scoped_candidates == [expected_id]:
            scoped_disposition = "CORRECT"
        elif not scoped_candidates:
            scoped_disposition = "UNMAPPED"
        elif expected_id not in scoped_candidates:
            scoped_disposition = "WRONG"
        else:
            scoped_disposition = "AMBIGUOUS"
        results.append({"fieldId": field["id"], "label": field["label"],
                        "expectedTargetId": expected_id, "candidateTargetIds": candidates,
                        "disposition": disposition, "scopeEvidenceCandidateTargetIds": scoped_candidates,
                        "scopeEvidenceDisposition": scoped_disposition})

    counts = {name: sum(result["disposition"] == name for result in results)
              for name in ("CORRECT", "WRONG", "UNMAPPED", "AMBIGUOUS")}
    scoped_counts = {name: sum(result["scopeEvidenceDisposition"] == name for result in results)
                     for name in ("CORRECT", "WRONG", "UNMAPPED", "AMBIGUOUS")}
    write_fields = [field for field in expected["fields"] if field.get("writeValue")]
    with TemporaryDirectory(prefix="govbiz-ground-truth-") as directory:
        root = Path(directory)
        copied = root / "source.hwpx"
        shutil.copyfile(source, copied)
        copied_document = await adapter.inspect(copied)
        copied_targets = {target.targetId: target for target in copied_document.targets}
        before_ids = [target.targetId for target in copied_document.targets]
        before_addresses = {target.targetId: address(target.nativeLocator) for target in copied_document.targets}
        facts = [{"id": field["id"], "label": field["label"], "value": field["writeValue"]}
                 for field in write_fields]
        request = GenerateDocumentRequest(
            sourceBase64=base64.b64encode(source_bytes).decode(), sourceSha256=expected["sourceSha256"],
            format="hwpx", answerRevision=1, facts=facts, scope="Human-reviewed ground-truth fields",
        )
        operations = []
        for field in write_fields:
            target = copied_targets[field["expectedTargetId"]]
            if target.currentText:
                raise ValueError(f"ground-truth write target is not empty: {target.targetId}")
            operations.append(EditOperation(
                targetId=target.targetId, operation="input", expectedText="", start=0, end=0,
                valueRef=field["id"], box=None, reason="Human-reviewed official input cell",
            ))
        selection = PlanSelection(operations=operations, unresolvedTargets=[],
                                  scopeTargetIds=[operation.targetId for operation in operations])
        plan = validate_plan(request, copied_document, selection)
        output, verification = await adapter.apply(
            copied, copied_document, plan, {field["id"]: field["writeValue"] for field in write_fields},
        )
        output_path = root / "completed.hwpx"
        if output != output_path.read_bytes() or digest(copied.read_bytes()) != expected["sourceSha256"]:
            raise ValueError("source/output identity mismatch")
        completed = await adapter.inspect(output_path)
        completed_targets = {target.targetId: target for target in completed.targets}
        changed_ids = {field["expectedTargetId"] for field in write_fields}
        changed_ids.update(field["sourceCellId"] for field in write_fields)
        unexpected_text_changes = [target.targetId for target in copied_document.targets
                                   if target.targetId not in changed_ids
                                   and completed_targets[target.targetId].currentText != target.currentText]
        write_results = [{"fieldId": field["id"], "targetId": field["expectedTargetId"],
                          "expectedValue": field["writeValue"],
                          "actualValue": completed_targets[field["expectedTargetId"]].currentText}
                         for field in write_fields]
        write_passed = (all(item["actualValue"] == item["expectedValue"] for item in write_results)
                        and not unexpected_text_changes
                        and before_ids == [target.targetId for target in completed.targets]
                        and before_addresses == {target.targetId: address(target.nativeLocator)
                                                 for target in completed.targets})

    total = len(results)
    covered = counts["CORRECT"] + counts["AMBIGUOUS"]
    return {
        "schemaVersion": 1,
        "evaluationId": expected["id"],
        "sourceSha256": expected["sourceSha256"],
        "mapping": {
            "groundTruthFields": total,
            "correctMappings": counts["CORRECT"],
            "wrongMappings": counts["WRONG"],
            "unmappedFields": counts["UNMAPPED"],
            "ambiguousMappings": counts["AMBIGUOUS"],
            "exactAccuracy": counts["CORRECT"] / total,
            "candidateCoverage": covered / total,
            "wrongTargetRate": counts["WRONG"] / total,
            "actualOpenAiCalls": 0,
            "scopeEvidenceDiagnostic": {
                "correctMappings": scoped_counts["CORRECT"],
                "wrongMappings": scoped_counts["WRONG"],
                "unmappedFields": scoped_counts["UNMAPPED"],
                "ambiguousMappings": scoped_counts["AMBIGUOUS"],
                "exactAccuracy": scoped_counts["CORRECT"] / total,
                "note": "Diagnostic only; production mapping does not force this filter",
            },
            "results": results,
        },
        "heading": {
            "expected": len(expected_headings),
            "detected": len(set(expected_headings) & set(detected_headings)),
            "missed": sorted(set(expected_headings) - set(detected_headings)),
            "falsePositive": sorted(set(detected_headings) - set(expected_headings)),
            "reviewRequiredTables": len(heading_review_tables),
            "sectionPathPolicy": "single-level",
        },
        "readingOrder": {
            "reorderedTargets": sum(target.analysis.readingOrderStatus == "LOCAL_REORDERED"
                                    for target in document.targets),
            "reviewRequiredTargets": len(reading_review),
            "reviewRequiredTables": len({target.nativeLocator.get("table") for target in reading_review}),
        },
        "write": {
            "requested": len(write_fields),
            "passed": write_passed,
            "sourcePreserved": digest(source.read_bytes()) == expected["sourceSha256"],
            "outputSha256": digest(output),
            "unexpectedTextChanges": unexpected_text_changes,
            "verification": verification,
            "results": write_results,
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--expected", type=Path, default=Path(__file__).parent / "expected/seocho-2026-v1.json")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(evaluate(args.source, args.expected)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
