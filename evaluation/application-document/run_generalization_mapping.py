"""One production-context OpenAI Mapping call for one fixed, blind official form."""

import argparse
import asyncio
import base64
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
    DocumentError, DocumentFieldReference, MapDocumentRequest, digest, validate_mapping,
)
from app.application_preparation.document_pipeline import inspect_document
from app.application_preparation.agent import ApplicationPreparationAgent
from evaluate_agent_mapping import ContextAgent, evidence_for, score
from validate_mapping import preserve_printed_labels


async def run(source: Path, blind_path: Path, expected_path: Path, output_dir: Path,
              model_name: str, preflight: bool, targets_path: Path | None) -> dict:
    blind = json.loads(blind_path.read_text(encoding="utf-8"))
    source_bytes = source.read_bytes()
    if digest(source_bytes) != blind["sourceSha256"]:
        raise ValueError("Official source SHA-256 mismatch")
    format_name = source.suffix.lower().removeprefix(".")
    if format_name not in {"hwp", "hwpx"}:
        raise ValueError("Only HWP/HWPX official forms are supported by this evaluation")
    hwp_targets = []
    if format_name == "hwp":
        if targets_path is None:
            raise ValueError("Core hwplib --targets export is required for HWP")
        exported = json.loads(targets_path.read_text(encoding="utf-8"))
        if exported["sourceSha256"] != blind["sourceSha256"]:
            raise ValueError("Core target export source mismatch")
        hwp_targets = exported["targets"]
    request = MapDocumentRequest(
        sourceBase64=base64.b64encode(source_bytes).decode(), sourceSha256=blind["sourceSha256"],
        format=format_name, scope=blind["scopeTitle"], hwpTargets=hwp_targets,
        fields=[DocumentFieldReference(id=field["id"], label=field["label"], guidance="", required=False)
                for field in blind["fields"]],
    )
    document = await inspect_document(source, request)
    preserve_printed_labels(document, blind)
    evidence = evidence_for(request, document)
    candidate_counts = {field.id: 0 for field in request.fields}
    for group in evidence["sectionsAndTables"]:
        for item in group["fieldCandidates"]:
            candidate_counts[item["fieldId"]] += 1
    if format_name == "hwpx" and any(count == 0 for count in candidate_counts.values()):
        raise ValueError("A question has no production candidate")
    if preflight:
        class CapturedPayload(Exception):
            def __init__(self, payload: str):
                self.payload = payload

        async def capture(_type, _instructions, content, *_args, **_kwargs):
            raise CapturedPayload(content[0]["text"])

        probe = ApplicationPreparationAgent(model=None, run_timeout_seconds=1)
        probe._invoke = capture
        try:
            await probe.map_document(request, document)
        except CapturedPayload as captured:
            mapping_input = captured.payload
        else:
            raise AssertionError("Mapping payload capture did not run")
        return {"status": "PREFLIGHT_PASSED", "sourceSha256": blind["sourceSha256"],
                "mapVersion": document.mapVersion, "targetCount": len(document.targets),
                "fieldCount": len(request.fields), "candidateCounts": candidate_counts,
                "mappingInputTargetCount": len(json.loads(mapping_input)["documentMap"]["targets"]),
                "mappingInputCharacters": len(mapping_input),
                "mappingInputUtf8Bytes": len(mapping_input.encode("utf-8")),
                "openAiCalls": 0}

    attempt_path = output_dir / "mapping-attempt.json"
    result_path = output_dir / "mapping.json"
    if attempt_path.exists() or result_path.exists():
        raise FileExistsError("The single-call evaluation was already started")
    load_dotenv(ROOT / ".env", override=False)
    if not os.getenv("OPENAI_API_KEY"):
        raise ValueError("OPENAI_API_KEY is unavailable")
    output_dir.mkdir(parents=True, exist_ok=True)
    agent = ContextAgent(evidence=None, model=ChatOpenAI(
        model=model_name, api_key=os.environ["OPENAI_API_KEY"], use_responses_api=True,
        store=False, reasoning={"effort": "none"}, max_retries=0), run_timeout_seconds=240)
    attempt_path.write_text(json.dumps({"status": "MODEL_CALL_STARTED", "model": model_name,
        "sourceSha256": blind["sourceSha256"], "fieldCount": len(request.fields), "maximumApiCalls": 1},
        indent=2) + "\n", encoding="utf-8")
    try:
        selection = await agent.map_document(request, document)
    except Exception as error:
        attempt_path.write_text(json.dumps({"status": "MODEL_CALL_FAILED", "model": model_name,
            "sourceSha256": blind["sourceSha256"], "apiCalls": agent.calls,
            "errorType": type(error).__name__}, indent=2) + "\n", encoding="utf-8")
        raise

    validation_error = None
    try:
        validate_mapping(request, document, selection)
    except DocumentError as error:
        validation_error = {"code": error.code, "reason": error.reason}
    # No expected native ID has been loaded before the model response.
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    if expected["sourceSha256"] != blind["sourceSha256"] or [f["id"] for f in expected["fields"]] != [f.id for f in request.fields]:
        raise ValueError("Ground Truth identity or field order mismatch")
    scored = score(expected, selection, validation_error)
    for row in scored["fields"]:
        row["candidateCount"] = candidate_counts[row["fieldId"]]
    result = {"run": "single-production-context", "sourceSha256": blind["sourceSha256"],
              "mapVersion": document.mapVersion, "model": model_name, "apiCalls": agent.calls,
              "groundTruthUsage": "Native expected IDs loaded after model response for scoring only", **scored}
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    attempt_path.write_text(json.dumps({"status": "COMPLETED", "model": model_name,
        "sourceSha256": blind["sourceSha256"], "apiCalls": agent.calls}, indent=2) + "\n", encoding="utf-8")
    return {key: value for key, value in result.items() if key != "fields"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--blind", required=True, type=Path)
    parser.add_argument("--expected", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--targets", type=Path, help="Core hwplib target JSON, required for HWP")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(run(args.source, args.blind, args.expected, args.output,
                                      args.model, args.preflight, args.targets)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
