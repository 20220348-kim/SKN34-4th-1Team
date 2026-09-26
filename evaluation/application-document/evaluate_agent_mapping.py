"""Compare the production HWPX mapping call with an evaluation-only context hint."""

import argparse
import asyncio
import base64
from copy import deepcopy
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from langchain_openai import ChatOpenAI

from app.application_preparation.agent import ApplicationPreparationAgent
from app.application_preparation.document_contract import (
    DocumentError, DocumentFieldReference, MapDocumentRequest, digest, mapping_label_key,
    mapping_label_matches, validate_mapping,
)
from app.application_preparation.document_pipeline import inspect_document
from validate_mapping import preserve_printed_labels


def evidence_for(request, document):
    """Group the same production evidence by section and table, without expected IDs."""
    parents = {target.nativeLocator.get("parent") for target in document.targets}
    candidates = [target for target in document.targets if target.targetId not in parents
                  and target.editable and target.nativeLocator.get("bindingEligible", True)]
    scope_key = mapping_label_key(request.scope.splitlines()[0])
    grouped = {}
    for field in request.fields:
        for target in candidates:
            if not target.nativeLocator.get("fieldLabels") or not mapping_label_matches(field.label, target, field.guidance):
                continue
            locator = target.nativeLocator
            scope_text = " ".join([*locator.get("tableHeadings", []), *locator.get("columnLabels", []),
                                   *target.analysis.sectionPath])
            item = {
                "targetId": target.targetId,
                "fieldLabels": locator.get("fieldLabels", []),
                "rowLabels": locator.get("rowLabels", []),
                "columnLabels": locator.get("columnLabels", []),
            }
            group_key = (tuple(target.analysis.sectionPath), locator.get("table"))
            if group_key not in grouped:
                grouped[group_key] = {
                    "semanticSection": target.analysis.semanticSection,
                    "sectionPath": target.analysis.sectionPath,
                    "table": locator.get("table"),
                    "tableHeadings": locator.get("tableHeadings", []),
                    "tableClassification": target.analysis.tableClassification,
                    "scopeTitleObserved": bool(scope_key and scope_key in mapping_label_key(scope_text)),
                    "fieldCandidates": [],
                }
            grouped[group_key]["scopeTitleObserved"] |= bool(
                scope_key and scope_key in mapping_label_key(scope_text))
            grouped[group_key]["fieldCandidates"].append({"fieldId": field.id, **item})
    return {"scopeTitle": request.scope.splitlines()[0], "sectionsAndTables": list(grouped.values())}


class ContextAgent(ApplicationPreparationAgent):
    """Add evaluation context at the model boundary; production code stays unchanged."""

    def __init__(self, *, evidence, **kwargs):
        super().__init__(**kwargs)
        self.evidence = evidence
        self.calls = 0

    async def _invoke(self, selection_type, instructions, content, max_tokens, timeout_message,
                      *, discovery=False, document=False):
        self.calls += 1
        if self.calls > 1:
            raise RuntimeError("Evaluation call cap exceeded")
        if self.evidence is not None:
            content = [*content, {"type": "text", "text": json.dumps(
                {"evaluationOnlyObservedContext": self.evidence}, ensure_ascii=False)}]
        return await super()._invoke(selection_type, instructions, content, max_tokens, timeout_message,
                                     discovery=discovery, document=document)


def score(expected, selection, validation_error=None):
    bound = {}
    for binding in selection.bindings:
        bound.setdefault(binding.factId, []).append(binding.targetId)
    used = {}
    for field_id, targets in bound.items():
        for target_id in targets:
            used.setdefault(target_id, []).append(field_id)
    rows = []
    for field in expected["fields"]:
        actual = bound.get(field["id"], [])
        if len(actual) > 1 or any(len(used[target_id]) > 1 for target_id in actual):
            status = "AMBIGUOUS"
        elif not actual:
            status = "UNMAPPED"
        else:
            status = "CORRECT" if actual[0] == field["expectedTargetId"] else "WRONG"
        rows.append({"fieldId": field["id"], "label": field["label"],
                     "expectedTargetId": field["expectedTargetId"],
                     "actualTargetId": actual[0] if len(actual) == 1 else None,
                     "status": status})
    counts = {status: sum(row["status"] == status for row in rows)
              for status in ("CORRECT", "WRONG", "UNMAPPED", "AMBIGUOUS")}
    total = len(rows)
    return {"groundTruthFields": total, "correct": counts["CORRECT"], "wrong": counts["WRONG"],
            "unmapped": counts["UNMAPPED"], "ambiguous": counts["AMBIGUOUS"],
            "mappingAccuracy": counts["CORRECT"] / total,
            "wrongTargetRate": counts["WRONG"] / total,
            "coverage": (counts["CORRECT"] + counts["WRONG"]) / total,
            "productionValidation": "PASS" if validation_error is None else "FAIL",
            "validationError": validation_error, "fields": rows}


def diagnostics(expected, document, runs, evidence):
    by_id = {target.targetId: target for target in document.targets}
    evidence_by_field = {}
    for group in evidence["sectionsAndTables"]:
        for item in group["fieldCandidates"]:
            evidence_by_field.setdefault(item["fieldId"], []).append(item)
    fields = []
    for field in expected["fields"]:
        target = by_id[field["expectedTargetId"]]
        source_cell = field["sourceCellId"]
        siblings = [item.targetId for item in document.targets
                    if item.nativeLocator.get("parent") == source_cell]
        candidates = evidence_by_field[field["id"]]
        observations = []
        if len(siblings) > 1:
            observations.append("SAME_CELL_MULTIPLE_PARAGRAPHS")
        if len(candidates) > 1:
            observations.append("MULTIPLE_LABEL_MATCHES")
        if not target.analysis.sectionPath:
            observations.append("SECTION_PATH_ABSENT")
        fields.append({"fieldId": field["id"], "expectedTargetId": field["expectedTargetId"],
                       "parentCell": source_cell, "childParagraphs": siblings,
                       "fieldLabels": target.nativeLocator.get("fieldLabels", []),
                       "expectedTargetSectionPath": target.analysis.sectionPath,
                       "candidateTargetIds": [item["targetId"] for item in candidates],
                       "observedConditions": observations,
                       "runA": next(row for row in runs["a"]["fields"] if row["fieldId"] == field["id"]),
                       "runB": next(row for row in runs["b"]["fields"] if row["fieldId"] == field["id"])})
    detected = {target.analysis.semanticSection for target in document.targets
                if target.analysis.headingStatus == "ACCEPTED" and target.analysis.semanticSection}
    return {"fields": fields, "headings": {
        "expected": len(expected["headings"]),
        "detected": len(set(expected["headings"]) & detected),
        "missed": sorted(set(expected["headings"]) - detected),
        "note": "Observed conditions are not proven causes of a model selection."}}


def interpret(runs):
    a, b = runs["a"], runs["b"]
    if b["wrong"] > a["wrong"]:
        outcome = "HOLD_WRONG_TARGET_INCREASE"
    elif b["correct"] > a["correct"] and b["wrong"] == 0 and b["productionValidation"] == "PASS":
        outcome = "STRUCTURED_EVIDENCE_PRODUCTION_CANDIDATE"
    elif a["correct"] >= b["correct"] and a["wrong"] == 0 and a["productionValidation"] == "PASS":
        outcome = "REVIEW_CURRENT_PRODUCTION_SUFFICIENCY"
    else:
        outcome = "REVIEW_CANDIDATE_OR_SECTION_STRUCTURE"
    return {"outcome": outcome,
            "correctDelta": b["correct"] - a["correct"],
            "wrongTargetRateDelta": b["wrongTargetRate"] - a["wrongTargetRate"],
            "priority": "Do not accept an increased wrong target rate for a correct-count gain",
            "scope": "Single-document first pass; production change needs repeated field effects and fail-safe review"}


async def evaluate(source, expected_path, output_dir, model_name):
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    source_bytes = source.read_bytes()
    if digest(source_bytes) != expected["sourceSha256"]:
        raise ValueError("Official source SHA-256 does not match fixed ground truth")
    request = MapDocumentRequest(
        sourceBase64=base64.b64encode(source_bytes).decode(), sourceSha256=expected["sourceSha256"],
        format="hwpx", scope=expected["scopeTitle"],
        fields=[DocumentFieldReference(id=field["id"], label=field["label"], guidance="",
                                       required=False) for field in expected["fields"]],
    )
    document = await inspect_document(source, request)
    preserve_printed_labels(document, expected)
    extra = evidence_for(request, document)
    output_dir.mkdir(parents=True, exist_ok=True)
    runs = {}
    for key, evidence in (("a", None), ("b", extra)):
        agent = ContextAgent(evidence=evidence, model=ChatOpenAI(
            model=model_name, api_key=os.environ["OPENAI_API_KEY"], use_responses_api=True,
            store=False, reasoning={"effort": "none"}, max_retries=0),
            run_timeout_seconds=240,
        )
        selection = await agent.map_document(request, deepcopy(document))
        validation_error = None
        try:
            validate_mapping(request, document, selection)
        except DocumentError as error:
            validation_error = {"code": error.code, "reason": error.reason}
        result = {"run": key.upper(), "model": model_name, "apiCalls": agent.calls,
                  "context": "production" if key == "a" else "same-production-evidence-reorganized-by-scope-section-table",
                  "comparisonType": "presentation-of-identical-production-evidence",
                  **score(expected, selection, validation_error)}
        (output_dir / f"run-{key}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        runs[key] = result
    comparison = {"groundTruthId": expected["id"], "sourceSha256": expected["sourceSha256"],
                  "model": model_name, "apiCalls": sum(run["apiCalls"] for run in runs.values()),
                  "comparisonType": "presentation-of-identical-production-evidence",
                  "groundTruthUsage": "expected target IDs used for scoring only; never included in model requests",
                  "runA": {key: value for key, value in runs["a"].items() if key not in {"fields"}},
                  "runB": {key: value for key, value in runs["b"].items() if key not in {"fields"}},
                  "interpretation": interpret(runs),
                  "diagnostics": diagnostics(expected, document, runs, extra)}
    (output_dir / "comparison.json").write_text(json.dumps(comparison, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return comparison


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--expected", type=Path, default=Path(__file__).parent / "expected/seocho-2026-v1.json")
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "runs/mapping-groundtruth-20260923-v1")
    parser.add_argument("--model", default=os.getenv("OPENAI_MODEL", "gpt-5.6-luna"))
    args = parser.parse_args()
    if not os.getenv("OPENAI_API_KEY"):
        parser.error("OPENAI_API_KEY is required for the approved paid evaluation")
    print(json.dumps(asyncio.run(evaluate(args.source, args.expected, args.output, args.model)),
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
