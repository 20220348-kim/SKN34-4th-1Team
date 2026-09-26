"""Preflight one official DOCX, then optionally make one production Mapping call."""

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
    DocumentFieldReference, MapDocumentRequest, digest, mapping_label_matches,
    validate_mapping, DocumentError,
)
from app.application_preparation.document_pipeline import inspect_document
from evaluate_agent_mapping import ContextAgent, score


class RecordedModel:
    """Record this evaluation's model boundary without changing production calls."""

    def __init__(self, model, output):
        self.model, self.output = model, output

    def model_copy(self, *, update):
        return RecordedModel(self.model.model_copy(update=update), self.output)

    def with_structured_output(self, *args, **kwargs):
        structured = self.model.with_structured_output(*args, **kwargs)
        output = self.output

        class RecordedInvocation:
            async def ainvoke(self, messages):
                import tiktoken
                text = json.dumps(messages[1].content, ensure_ascii=False)
                output.joinpath("input-metrics.json").write_text(json.dumps({
                    "characters": len(text),
                    "estimatedTokensO200k": len(tiktoken.get_encoding("o200k_base").encode(text)),
                    "estimateIncludesSchema": False,
                }, indent=2) + "\n", encoding="utf-8")
                result = await structured.ainvoke(messages)
                raw = result["raw"]
                output.joinpath("response-diagnostics.json").write_text(json.dumps({
                    "content": raw.content,
                    "responseMetadata": raw.response_metadata,
                    "usageMetadata": raw.usage_metadata,
                    "responseLength": len(json.dumps(raw.content, ensure_ascii=False)),
                    "parsingError": str(result["parsing_error"]) if result["parsing_error"] else None,
                }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                return result

        return RecordedInvocation()


async def run(source: Path, expected_path: Path, blind_path: Path, output: Path,
              model_name: str, preflight: bool):
    data = source.read_bytes()
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    blind = json.loads(blind_path.read_text(encoding="utf-8"))
    source_hash = digest(data)
    if source_hash != expected["sourceSha256"] or source_hash != blind["sourceSha256"]:
        raise ValueError("Official DOCX source hash mismatch")
    request = MapDocumentRequest(sourceBase64=base64.b64encode(data).decode(),
        sourceSha256=source_hash, format="docx", scope=blind["scopeTitle"],
        fields=[DocumentFieldReference(**field) for field in blind["fields"]])
    document = await inspect_document(source, request)
    targets = {target.targetId: target for target in document.targets}
    candidate_ids = {field.id: [target.targetId for target in document.targets
        if target.editable and target.nativeLocator.get("bindingEligible", True)
        and mapping_label_matches(field.label, target, field.guidance)] for field in request.fields}
    statuses = {field["id"]: (
        "EXACT" if candidate_ids[field["id"]] == [field["expectedTargetId"]] else
        "AMBIGUOUS" if field["expectedTargetId"] in candidate_ids[field["id"]] else
        "WRONG" if candidate_ids[field["id"]] else "UNMAPPED") for field in expected["fields"]}
    preflight_result = {"sourceSha256": source_hash, "engineVersion": document.engineVersion,
        "mapVersion": document.mapVersion, "paragraphCount": expected["paragraphCount"],
        "tableCount": expected["tableCount"], "controlCount": expected["controlCount"],
        "targetCount": len(targets), "editableCount": sum(t.editable for t in targets.values()),
        "candidateCounts": {key: len(ids) for key, ids in candidate_ids.items()},
        "candidateResults": statuses, "apiCalls": 0}
    if preflight:
        return preflight_result
    if any(value in {"WRONG", "UNMAPPED"} for value in statuses.values()):
        raise ValueError("Ground Truth candidate coverage is incomplete")
    output.mkdir(parents=True, exist_ok=True)
    attempt_path = output / "mapping-attempt.json"
    result_path = output / "mapping.json"
    if attempt_path.exists() or result_path.exists():
        raise FileExistsError("Official DOCX Mapping call already started")
    load_dotenv(ROOT / ".env", override=False)
    if not os.getenv("OPENAI_API_KEY"):
        raise ValueError("OPENAI_API_KEY unavailable")
    agent = ContextAgent(evidence=None, model=RecordedModel(ChatOpenAI(
        model=model_name, api_key=os.environ["OPENAI_API_KEY"], use_responses_api=True,
        store=False, reasoning={"effort": "none"}, max_retries=0), output), run_timeout_seconds=240)
    attempt_path.write_text(json.dumps({"status": "MODEL_CALL_STARTED", "sourceSha256": source_hash,
        "model": model_name, "maximumApiCalls": 1}, indent=2) + "\n", encoding="utf-8")
    try:
        selection = await agent.map_document(request, document)
        validation_error = None
        try:
            validate_mapping(request, document, selection)
        except DocumentError as error:
            validation_error = {"code": error.code, "reason": error.reason}
        scored = score(expected, selection, validation_error)
        result = {"run": "single-production-context", "sourceSha256": source_hash,
                  "engineVersion": document.engineVersion, "mapVersion": document.mapVersion,
                  "model": model_name, "apiCalls": agent.calls,
                  "groundTruthUsage": "Expected native IDs were omitted from the model request",
                  **scored}
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        attempt_path.write_text(json.dumps({"status": "COMPLETED", "apiCalls": agent.calls}, indent=2) + "\n", encoding="utf-8")
        return {key: value for key, value in result.items() if key != "fields"}
    except Exception as error:
        attempt_path.write_text(json.dumps({"status": "MODEL_CALL_FAILED", "apiCalls": agent.calls,
            "errorType": type(error).__name__}, indent=2) + "\n", encoding="utf-8")
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--expected", type=Path, default=Path(__file__).parent / "expected/docx-kotra-procurement-2026-v1.json")
    parser.add_argument("--blind", type=Path, default=Path(__file__).parent / "blind-docx-kotra-procurement-2026-v1.json")
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "runs/docx-kotra-20260926-v1")
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--preflight", action="store_true")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(run(args.source, args.expected, args.blind, args.output,
                                     args.model, args.preflight)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
