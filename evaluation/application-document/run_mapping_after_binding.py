"""Run one production-context HWPX Mapping call after native leaf eligibility changes."""

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

from app.application_preparation.document_contract import (
    DocumentError, DocumentFieldReference, MapDocumentRequest, digest, validate_mapping,
)
from app.application_preparation.document_pipeline import inspect_document
from evaluate_agent_mapping import ContextAgent, evidence_for, score
from validate_mapping import preserve_printed_labels


def target_context(target):
    locator = target.nativeLocator
    return {
        "targetId": target.targetId,
        "parentCell": locator.get("parent"),
        "table": locator.get("table"),
        "row": locator.get("row"),
        "col": locator.get("col"),
        "fieldLabels": locator.get("fieldLabels", []),
        "rowLabels": locator.get("rowLabels", []),
        "columnLabels": locator.get("columnLabels", []),
        "tableHeadings": locator.get("tableHeadings", []),
        "semanticSection": target.analysis.semanticSection,
        "sectionPath": target.analysis.sectionPath,
        "tableClassification": target.analysis.tableClassification,
        "bindingEligible": locator.get("bindingEligible", True),
    }


async def evaluate(source: Path, blind_path: Path, expected_path: Path, output_dir: Path, model_name: str):
    run_path = output_dir / "run-c.json"
    attempt_path = output_dir / "run-c-attempt.json"
    if run_path.exists() or attempt_path.exists():
        raise FileExistsError("Run C was already started; never repeat the approved single call")

    # This file contains no target IDs. Ground Truth is not opened until after the model responds.
    blind = json.loads(blind_path.read_text(encoding="utf-8"))
    source_sha256 = blind["sourceSha256"]
    source_bytes = source.read_bytes()
    if digest(source_bytes) != source_sha256:
        raise ValueError("Official source SHA-256 does not match the fixed document identity")
    request = MapDocumentRequest(
        sourceBase64=base64.b64encode(source_bytes).decode(), sourceSha256=source_sha256,
        format="hwpx", scope=blind["scopeTitle"],
        fields=[DocumentFieldReference(id=field["id"], label=field["label"], guidance="",
                                       required=False) for field in blind["fields"]],
    )
    document = await inspect_document(source, request)
    preserve_printed_labels(document, blind)
    evidence = evidence_for(request, document)
    candidates = {field.id: [] for field in request.fields}
    for group in evidence["sectionsAndTables"]:
        for candidate in group["fieldCandidates"]:
            candidates[candidate["fieldId"]].append(candidate["targetId"])
    if any(not ids for ids in candidates.values()):
        raise ValueError("A supplied field has no labeled native candidate")

    output_dir.mkdir(parents=True, exist_ok=True)
    agent = ContextAgent(evidence=None, model=ChatOpenAI(
        model=model_name, api_key=os.environ["OPENAI_API_KEY"], use_responses_api=True,
        store=False, reasoning={"effort": "none"}, max_retries=0), run_timeout_seconds=240)
    attempt_path.write_text(json.dumps({"run": "C", "model": model_name, "sourceSha256": source_sha256,
                                        "fieldCount": len(request.fields), "maximumApiCalls": 1,
                                        "status": "MODEL_CALL_STARTED"}, indent=2) + "\n", encoding="utf-8")
    selection = await agent.map_document(request, deepcopy(document))
    validation_error = None
    try:
        validate_mapping(request, document, selection)
    except DocumentError as error:
        validation_error = {"code": error.code, "reason": error.reason}

    # Ground Truth and the previous run are read only after the model returns.
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    baseline = json.loads((output_dir / "run-a.json").read_text(encoding="utf-8"))
    scored = score(expected, selection, validation_error)
    by_id = {target.targetId: target for target in document.targets}
    old_by_field = {row["fieldId"]: row for row in baseline["fields"]}
    for row in scored["fields"]:
        row["candidateCount"] = len(candidates[row["fieldId"]])
        selected = by_id.get(row["actualTargetId"])
        row["selectedCandidateContext"] = target_context(selected) if selected else None
        row["beforeStatus"] = old_by_field[row["fieldId"]]["status"]
    representative = next(row for row in scored["fields"] if row["fieldId"] == "applicant:representative-name")
    result = {
        "run": "C", "model": model_name, "apiCalls": agent.calls,
        "context": "current-production-mapping-after-binding-eligibility",
        "sourceSha256": source_sha256, "mapVersion": document.mapVersion,
        "groundTruthUsage": "Expected target IDs and prior model results were read after the single model response",
        "beforeRunA": {key: baseline[key] for key in ("correct", "wrong", "unmapped", "ambiguous", "wrongTargetRate")},
        **scored,
        "newWrongFieldIds": [row["fieldId"] for row in scored["fields"]
                             if row["status"] == "WRONG" and row["beforeStatus"] != "WRONG"],
        "representativeRemainingCandidates": [target_context(by_id[key]) for key in candidates["applicant:representative-name"]]
        if representative["status"] == "WRONG" else None,
    }
    run_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    attempt_path.write_text(json.dumps({"run": "C", "model": model_name, "sourceSha256": source_sha256,
                                        "fieldCount": len(request.fields), "maximumApiCalls": 1,
                                        "status": "COMPLETED", "apiCalls": agent.calls}, indent=2) + "\n", encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--blind", type=Path, default=Path(__file__).parent / "blind-seocho-2026-v1.json")
    parser.add_argument("--expected", type=Path, default=Path(__file__).parent / "expected/seocho-2026-v1.json")
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "runs/mapping-groundtruth-20260923-v1")
    parser.add_argument("--model", default=os.getenv("OPENAI_MODEL", "gpt-5.6-luna"))
    args = parser.parse_args()
    if not os.getenv("OPENAI_API_KEY"):
        parser.error("OPENAI_API_KEY is required for the approved paid evaluation")
    result = asyncio.run(evaluate(args.source, args.blind, args.expected, args.output, args.model))
    print(json.dumps({key: value for key, value in result.items() if key not in {"fields", "representativeRemainingCandidates"}},
                     ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
