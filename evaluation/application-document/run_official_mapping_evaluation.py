"""Approved five-call evaluation of the current mapping agent on blind public forms.

Uses only the inspect-stage maps from the offline run. Expected placements and
dummy writing bindings are never supplied to the model. No retries or repairs.
"""

import argparse
import asyncio
import base64
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ai-service"))

from dotenv import dotenv_values
from langchain_openai import ChatOpenAI
from openai import AuthenticationError, NotFoundError, PermissionDeniedError, RateLimitError
from app.application_preparation.document_contract import (
    DocumentError, DocumentFieldReference, DocumentMap, MapDocumentRequest, digest, validate_mapping,
)
from evaluate_agent_mapping import ContextAgent, score
from run_official_format_regression import SAMPLES


class RecordedModel:
    def __init__(self, model, output, counter):
        self.model, self.output, self.counter = model, output, counter

    def model_copy(self, *, update):
        if update.get("max_tokens", 0) > 32000:
            raise ValueError("Approved output token cap exceeded")
        return RecordedModel(self.model.model_copy(update=update), self.output, self.counter)

    def with_structured_output(self, *args, **kwargs):
        structured = self.model.with_structured_output(*args, **kwargs)
        output, counter = self.output, self.counter

        class Invocation:
            async def ainvoke(self, messages):
                attempt = output / "attempt.json"
                if attempt.exists() or counter[0] >= 5:
                    raise RuntimeError("Approved call cap exceeded or attempt already started")
                counter[0] += 1
                attempt.write_text(json.dumps({"status": "STARTED", "attempt": counter[0],
                    "maximumApiCalls": 1, "maxOutputTokens": 32000}) + "\n", encoding="utf-8")
                try:
                    result = await structured.ainvoke(messages)
                except Exception as error:
                    attempt.write_text(json.dumps({"status": "FAILED", "attempt": counter[0],
                        "errorType": type(error).__name__, "maximumApiCalls": 1}) + "\n", encoding="utf-8")
                    raise
                raw = result["raw"]
                (output / "usage.json").write_text(json.dumps({"usage": raw.usage_metadata,
                    "model": raw.response_metadata.get("model_name"),
                    "finishReason": raw.response_metadata.get("finish_reason"),
                    "parsingErrorType": type(result["parsing_error"]).__name__ if result["parsing_error"] else None},
                    ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                attempt.write_text(json.dumps({"status": "RESPONSE_RECEIVED", "attempt": counter[0],
                    "maximumApiCalls": 1}) + "\n", encoding="utf-8")
                return result

        return Invocation()


async def run(sources, native_run, output, key_env, model):
    if output.exists():
        raise FileExistsError("Use a fresh evidence directory; never repeat an attempt")
    key = dotenv_values(key_env).get("OPENAI_API_KEY")
    if not key:
        raise ValueError("OPENAI_API_KEY unavailable")
    # Prepare all identities before allowing the first model call.
    prepared = {}
    definitions = Path(__file__).parent
    for format_name, (_, blind_name) in SAMPLES.items():
        blind = json.loads((definitions / f"{blind_name}.json").read_text(encoding="utf-8"))
        source = (sources / f"official.{format_name}").read_bytes()
        document = DocumentMap.model_validate_json((native_run / format_name / "map.json").read_text(encoding="utf-8"))
        if digest(source) != blind["sourceSha256"] or document.sourceSha256 != blind["sourceSha256"]:
            raise ValueError("Blind form source identity mismatch")
        native = {}
        if format_name in {"hwp", "pdf"}:
            inspection = json.loads((sources.parent / ("hwp-targets.json" if format_name == "hwp" else "pdf-inspection.json")).read_text(encoding="utf-8"))
            if inspection["sourceSha256"] != blind["sourceSha256"]:
                raise ValueError("Core inspection source identity mismatch")
            native = ({"hwpTargets": inspection["targets"]} if format_name == "hwp" else
                      {name: inspection[name] for name in ("pdfTargets", "pageImages", "pdfFields")})
        request = MapDocumentRequest(sourceBase64=base64.b64encode(source).decode(),
            sourceSha256=blind["sourceSha256"], format=format_name, scope=blind["scopeTitle"], **native,
            fields=[DocumentFieldReference(**{"guidance": "", "required": False, **field}) for field in blind["fields"]])
        prepared[format_name] = request, document

    output.mkdir(parents=True)
    counter, results, provider_blocked = [0], {}, False
    for format_name, (request, document) in prepared.items():
        folder = output / format_name
        folder.mkdir()
        if provider_blocked:
            results[format_name] = {"status": "NOT_RUN", "apiAttempts": 0,
                                   "reason": "SHARED_PROVIDER_FAILURE", "retry": False}
            (folder / "result.json").write_text(json.dumps(results[format_name]) + "\n", encoding="utf-8")
            (output / "summary.json").write_text(json.dumps({"attempts": counter[0], "maximumApiCalls": 5,
                "results": results}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(json.dumps({"format": format_name, **results[format_name]}), flush=True)
            continue
        agent = ContextAgent(evidence=None, model=RecordedModel(ChatOpenAI(
            model=model, api_key=key, use_responses_api=True, store=False,
            reasoning={"effort": "none"}, max_retries=0), folder, counter), run_timeout_seconds=240)
        previous_attempts = counter[0]
        try:
            selection = await agent.map_document(request, document)
            (folder / "selection.json").write_text(selection.model_dump_json(), encoding="utf-8")
            validation_error = None
            try:
                validate_mapping(request, document, selection)
            except DocumentError as error:
                validation_error = {"code": error.code, "reason": error.reason}
            # Holdout is opened only after the model response.
            expected_name = SAMPLES[format_name][0]
            expected = json.loads((definitions / "expected" / f"{expected_name}.json").read_text(encoding="utf-8"))
            if expected["sourceSha256"] != request.sourceSha256:
                raise ValueError("Ground truth source mismatch")
            results[format_name] = {"status": "SCORED", "sourceSha256": request.sourceSha256,
                "model": model, "apiAttempts": counter[0] - previous_attempts, **score(expected, selection, validation_error)}
        except Exception as error:
            provider_blocked = isinstance(error, (AuthenticationError, NotFoundError, PermissionDeniedError, RateLimitError))
            results[format_name] = {"status": "FAILED", "errorType": type(error).__name__,
                "model": model, "apiAttempts": counter[0] - previous_attempts, "retry": False,
                **({"code": error.code, "reason": error.reason} if isinstance(error, DocumentError) else {})}
        (folder / "result.json").write_text(json.dumps(results[format_name], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (output / "summary.json").write_text(json.dumps({"attempts": counter[0], "maximumApiCalls": 5,
            "results": results}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"format": format_name, **{k: v for k, v in results[format_name].items() if k != "fields"}},
                         ensure_ascii=False), flush=True)
    return all(result["status"] == "SCORED" and result["productionValidation"] == "PASS"
               and result["correct"] == result["groundTruthFields"] for result in results.values())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("sources", "native-run", "output", "key-env"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    sys.exit(0 if asyncio.run(run(args.sources, args.native_run, args.output, args.key_env, args.model)) else 1)
