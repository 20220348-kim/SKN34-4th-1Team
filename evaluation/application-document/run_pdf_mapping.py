"""Score one production-context PDF Mapping call against withheld native targets."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from langchain_openai import ChatOpenAI

from app.application_preparation.document_contract import (
    DocumentError, DocumentFieldReference, DocumentMap, MapDocumentRequest,
    digest, mapping_label_matches, validate_mapping,
)
from evaluate_agent_mapping import ContextAgent, score
from validate_mapping import preserve_printed_labels


async def run(source: Path, core_request_path: Path, map_path: Path, blind_path: Path,
              expected_path: Path, output: Path, model_name: str, preflight: bool) -> dict:
    blind = json.loads(blind_path.read_text(encoding="utf-8"))
    core = json.loads(core_request_path.read_text(encoding="utf-8"))
    source_hash = digest(source.read_bytes())
    document = DocumentMap.model_validate_json(map_path.read_text(encoding="utf-8"))
    if not (blind["sourceSha256"] == core["sourceSha256"] == document.sourceSha256 == source_hash):
        raise ValueError("Official PDF, Core request, and production map source mismatch")
    request = MapDocumentRequest(
        sourceBase64=core["sourceBase64"], sourceSha256=source_hash, format="pdf",
        scope=blind["scopeTitle"], pdfTargets=core["pdfTargets"],
        pageImages=core["pageImages"], pdfFields=core["pdfFields"],
        fields=[DocumentFieldReference(**field) for field in blind["fields"]],
    )
    preserve_printed_labels(document, blind)
    parents = {target.nativeLocator.get("parent") for target in document.targets}
    candidates = {field.id: [target.targetId for target in document.targets
        if target.targetId not in parents and target.editable and target.kind in {"PDF_INPUT", "PDF_FIELD"}
        and target.nativeLocator.get("fieldLabels")
        and mapping_label_matches(field.label, target, field.guidance)] for field in request.fields}
    if any(not ids for ids in candidates.values()):
        raise ValueError("A PDF question has no labeled native input candidate")
    if preflight:
        expected = json.loads(expected_path.read_text(encoding="utf-8"))
        if expected["sourceSha256"] != source_hash:
            raise ValueError("Ground Truth source mismatch")
        missing = [field["id"] for field in expected["fields"]
                   if field["expectedTargetId"] not in candidates[field["id"]]]
        return {"status": "PREFLIGHT_PASSED" if not missing else "PREFLIGHT_FAILED",
                "sourceSha256": source_hash, "fieldCount": len(request.fields),
                "candidateCounts": {key: len(ids) for key, ids in candidates.items()},
                "missingExpectedCandidates": missing, "apiCalls": 0}

    output.mkdir(parents=True, exist_ok=True)
    attempt_path = output / "mapping-attempt.json"
    result_path = output / "mapping.json"
    if attempt_path.exists() or result_path.exists():
        raise FileExistsError("This official PDF Mapping call was already started")
    load_dotenv(ROOT / ".env", override=False)
    if not os.getenv("OPENAI_API_KEY"):
        raise ValueError("OPENAI_API_KEY is unavailable")
    agent = ContextAgent(evidence=None, model=ChatOpenAI(
        model=model_name, api_key=os.environ["OPENAI_API_KEY"], use_responses_api=True,
        store=False, reasoning={"effort": "none"}, max_retries=0), run_timeout_seconds=240)
    attempt_path.write_text(json.dumps({"status": "MODEL_CALL_STARTED", "model": model_name,
        "sourceSha256": source_hash, "fieldCount": len(request.fields), "maximumApiCalls": 1},
        indent=2) + "\n", encoding="utf-8")
    try:
        selection = await agent.map_document(request, document)
    except Exception as error:
        attempt_path.write_text(json.dumps({"status": "MODEL_CALL_FAILED", "model": model_name,
            "sourceSha256": source_hash, "apiCalls": agent.calls, "errorType": type(error).__name__},
            indent=2) + "\n", encoding="utf-8")
        raise
    validation_error = None
    try:
        validate_mapping(request, document, selection)
    except DocumentError as error:
        validation_error = {"code": error.code, "reason": error.reason}
    # Expected IDs are first loaded after the model response.
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    if expected["sourceSha256"] != source_hash or [field["id"] for field in expected["fields"]] != [field.id for field in request.fields]:
        raise ValueError("Ground Truth identity or field order mismatch")
    scored = score(expected, selection, validation_error)
    for row in scored["fields"]:
        row["candidateTargetIds"] = candidates[row["fieldId"]]
    result = {"run": "single-production-context", "sourceSha256": source_hash,
              "mapVersion": document.mapVersion, "model": model_name, "apiCalls": agent.calls,
              "groundTruthUsage": "Expected native IDs loaded after model response for scoring only",
              **scored}
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    attempt_path.write_text(json.dumps({"status": "COMPLETED", "model": model_name,
        "sourceSha256": source_hash, "apiCalls": agent.calls}, indent=2) + "\n", encoding="utf-8")
    return {key: value for key, value in result.items() if key != "fields"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--core-request", required=True, type=Path)
    parser.add_argument("--map", required=True, type=Path)
    parser.add_argument("--blind", required=True, type=Path)
    parser.add_argument("--expected", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--preflight", action="store_true")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(run(args.source, args.core_request, args.map,
        args.blind, args.expected, args.output, args.model, args.preflight)),
        ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
