"""Official XLSX preflight and at most one paid Mapping per source SHA."""
import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
from collections import Counter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.application_preparation.document_contract import (
    DocumentFieldReference, MapDocumentRequest, digest, mapping_label_matches,
    validate_mapping, DocumentError,
)
from app.application_preparation.document_pipeline import inspect_document
from evaluate_agent_mapping import ContextAgent, score
from run_docx_mapping import RecordedModel


async def run(args):
    data = args.source.read_bytes()
    expected = json.loads(args.expected.read_text(encoding="utf-8"))
    blind = json.loads(args.blind.read_text(encoding="utf-8"))
    source_hash = digest(data)
    if source_hash != expected["sourceSha256"] or source_hash != blind["sourceSha256"]:
        raise ValueError("Official XLSX source hash mismatch")
    if not 8 <= len(expected["fields"]) <= 15:
        raise ValueError("Official ground truth must contain 8 to 15 real fields")
    if "expectedTargetId" in json.dumps(blind):
        raise ValueError("Blind model input must omit ground truth native IDs")
    request = MapDocumentRequest(sourceBase64=base64.b64encode(data).decode(), sourceSha256=source_hash,
        format="xlsx", scope=blind["scopeTitle"], fields=[DocumentFieldReference(**f) for f in blind["fields"]])
    document = await inspect_document(args.source, request)
    candidates = {f.id: [t.targetId for t in document.targets if t.editable
        and t.nativeLocator.get("bindingEligible") and mapping_label_matches(f.label, t, f.guidance)]
        for f in request.fields}
    statuses = {f["id"]: ("EXACT" if candidates[f["id"]] == [f["expectedTargetId"]] else
        "AMBIGUOUS" if f["expectedTargetId"] in candidates[f["id"]] else
        "WRONG" if candidates[f["id"]] else "UNMAPPED") for f in expected["fields"]}
    counts = Counter(statuses.values())
    summary = {"sourceSha256": source_hash, "engineVersion": document.engineVersion,
        "mapVersion": document.mapVersion, "workbook": document.workbookMetadata,
        "targetCount": len(document.targets), "editableCount": sum(t.editable for t in document.targets),
        "groundTruthFields": len(expected["fields"]),
        "candidateCoverage": (counts["EXACT"] + counts["AMBIGUOUS"]) / len(expected["fields"]),
        "exact": counts["EXACT"], "ambiguous": counts["AMBIGUOUS"],
        "wrong": counts["WRONG"], "unmapped": counts["UNMAPPED"],
        "candidateResults": statuses, "candidates": candidates, "apiCalls": 0,
        "groundTruthReview": "Agent reviewed official cell content and addresses; no independent user review"}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "preflight.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.preflight:
        return summary
    if summary["candidateCoverage"] != 1:
        raise ValueError("Ground truth candidate coverage must be 100% before paid Mapping")
    attempt = args.output / "mapping-attempt.json"
    if attempt.exists() or (args.output / "mapping.json").exists():
        raise FileExistsError("Paid Mapping already attempted for this official XLSX")
    # Global cap across XLSX run directories; no hidden retries or source replays.
    previous = list((Path(__file__).parent / "runs").glob("xlsx-*/mapping-attempt.json"))
    previous += list((Path(__file__).parent / "runs").glob("xlsx-*/*/mapping-attempt.json"))
    started = [json.loads(p.read_text(encoding="utf-8")) for p in previous]
    if len(started) >= 2 or any(item.get("sourceSha256") == source_hash for item in started):
        raise ValueError("XLSX paid-call cap (2 total, 1 per source) exhausted")
    from dotenv import load_dotenv
    from langchain_openai import ChatOpenAI
    load_dotenv(Path(os.environ.get("XLSX_EVALUATION_ENV", str(ROOT / ".env"))), override=False)
    if not os.getenv("OPENAI_API_KEY"):
        raise ValueError("OPENAI_API_KEY unavailable")
    agent = ContextAgent(evidence=None, model=RecordedModel(ChatOpenAI(model=args.model,
        api_key=os.environ["OPENAI_API_KEY"], use_responses_api=True, store=False,
        reasoning={"effort": "none"}, max_retries=0), args.output), run_timeout_seconds=240)
    record = {"status": "MODEL_CALL_STARTED", "sourceSha256": source_hash, "model": args.model,
              "maximumApiCalls": 1}
    attempt.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    try:
        selection = await agent.map_document(request, document)
        validation_error = None
        try:
            validate_mapping(request, document, selection)
        except DocumentError as error:
            validation_error = {"code": error.code, "reason": error.reason}
        result = {"sourceSha256": source_hash, "model": args.model, "apiCalls": agent.calls,
            "groundTruthUsage": "Expected native IDs omitted from model input",
            "humanReview": "NOT_INDEPENDENTLY_REVIEWED",
            "engineVersion": document.engineVersion, "mapVersion": document.mapVersion,
            **score(expected, selection, validation_error)}
        (args.output / "mapping.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        record.update(status="COMPLETED", apiCalls=agent.calls)
        return result
    except Exception as error:
        record.update(status="MODEL_CALL_FAILED", apiCalls=agent.calls, errorType=type(error).__name__)
        raise
    finally:
        attempt.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("source", "expected", "blind", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--preflight", action="store_true")
    print(json.dumps(asyncio.run(run(parser.parse_args())), ensure_ascii=False, indent=2))
