#!/usr/bin/env python3
"""고정 가상 근거의 답변 평가. 기본 실행은 모델 호출 없는 입력 검증이다."""

import argparse
import asyncio
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
from time import perf_counter


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "backend/ai-service"))

from app.config import (  # noqa: E402
    DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
    DEFAULT_LLM_RUN_TIMEOUT_SECONDS,
    DEFAULT_OPENAI_MODEL,
)
from app.support_program_evidence.models import (  # noqa: E402
    SupportProgramEvidenceAnswerRequest,
    SupportProgramEvidenceAnswerResponse,
    SupportProgramEvidenceAnswerSelection,
    SupportProgramEvidenceAnswerChunk,
)
from app.support_program_evidence.prompt import (  # noqa: E402
    SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS,
)


def digest(value: bytes) -> str:
    return sha256(value).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load_fixture(path: Path) -> tuple[dict, list[tuple[dict, SupportProgramEvidenceAnswerRequest]], str]:
    raw = path.read_bytes()
    fixture = json.loads(raw)
    require(isinstance(fixture, dict), "fixture must be an object")
    require(fixture.get("schemaVersion") == "support-program-evidence-eval-v1", "unsupported fixture schema")
    require(fixture.get("dataType") == "synthetic", "this fixture must be explicitly synthetic")
    require(fixture.get("referenceSource") == "ai-authored", "reference source must be disclosed")
    documents = fixture.get("documents")
    cases = fixture.get("cases")
    require(isinstance(documents, list) and 1 <= len(documents) <= 3, "expected 1 to 3 documents")
    require(isinstance(cases, list) and 1 <= len(cases) <= 12, "expected 1 to 12 cases")
    by_id = {}
    for document in documents:
        require(isinstance(document, dict), "invalid document")
        document_id = document.get("id")
        require(isinstance(document_id, str) and document_id not in by_id, "duplicate or invalid document id")
        require(isinstance(document.get("title"), str) and bool(document["title"].strip()), "document title required")
        chunks = document.get("chunks")
        require(isinstance(chunks, list) and 1 <= len(chunks) <= 5, "expected 1 to 5 fixed chunks")
        prepared = []
        for order, chunk in enumerate(chunks):
            require(isinstance(chunk, dict) and type(chunk.get("order")) is int and chunk["order"] == order,
                    "chunk orders must be unique and contiguous")
            text = chunk.get("text")
            require(isinstance(text, str), "chunk text required")
            # These are manually fixed evaluation contexts, not a reimplementation of Core's chunker.
            chunk_id = digest(f"evidence-eval-v1\0{document_id}\0{order}\0{text}".encode())
            prepared.append(SupportProgramEvidenceAnswerChunk.model_validate({
                "id": chunk_id, "documentId": document_id, "order": order, "text": text,
            }).model_dump(by_alias=True))
        by_id[document_id] = prepared
    prepared_cases = []
    seen = set()
    for case in cases:
        require(isinstance(case, dict), "invalid case")
        case_id = case.get("id")
        require(isinstance(case_id, str) and bool(case_id.strip()) and case_id not in seen, "duplicate or invalid case id")
        seen.add(case_id)
        require(isinstance(case.get("category"), str) and bool(case["category"].strip()), "case category required")
        require(isinstance(case.get("documentId"), str) and case["documentId"] in by_id, "unknown case document")
        request = SupportProgramEvidenceAnswerRequest.model_validate({
            "question": case.get("question"), "chunks": by_id[case["documentId"]],
        })
        require(request.question == case["question"], "question must already be trimmed")
        status = case.get("expectedStatus")
        require(isinstance(status, str) and status in {"ANSWERED", "INSUFFICIENT_EVIDENCE"}, "invalid expected status")
        orders = case.get("expectedCitationOrders")
        require(isinstance(orders, list) and all(type(value) is int and value in range(len(request.chunks)) for value in orders),
                "invalid reference citation orders")
        require(len(orders) == len(set(orders)), "duplicate reference citation order")
        require(bool(orders) == (status == "ANSWERED"), "reference status and citations disagree")
        for field in ("referenceFacts", "forbiddenClaims"):
            values = case.get(field)
            require(isinstance(values, list) and bool(values) and
                    all(isinstance(value, str) and bool(value.strip()) for value in values), f"{field} required")
        prepared_cases.append((case, request))
    return fixture, prepared_cases, digest(raw)


def request_digest(request: SupportProgramEvidenceAnswerRequest) -> str:
    return digest(request.model_dump_json(by_alias=True).encode())


def select_cases(prepared: list, case_ids: list) -> list:
    require(isinstance(case_ids, list) and bool(case_ids) and all(isinstance(value, str) for value in case_ids),
            "case ids must be a nonempty list")
    require(len(case_ids) == len(set(case_ids)), "duplicate selected case")
    selected = [(case, request) for case, request in prepared if case["id"] in case_ids]
    require([case["id"] for case, _ in selected] == case_ids, "unknown or unordered selected case")
    return selected


def report(fixture: dict, prepared: list, fixture_hash: str, capture: dict | None = None) -> dict:
    if capture is not None:
        require(isinstance(capture, dict), "capture must be an object")
        prepared = select_cases(prepared, capture.get("caseIds", [case["id"] for case, _ in prepared]))
    result = {
        "dataType": fixture["dataType"], "referenceSource": fixture["referenceSource"],
        "scope": "fixed-answer-context-only", "fixtureSha256": fixture_hash,
        "documentCount": len(fixture["documents"]), "caseCount": len(prepared),
        "fixtureCaseCount": len(fixture["cases"]), "selectedCaseIds": [case["id"] for case, _ in prepared],
        "measured": False, "completed": False, "observedCaseCount": 0,
        "statusAccuracy": None, "referenceCitationRecall": None, "semanticFaithfulness": None,
        "semanticReviewRequired": True, "cases": [],
    }
    if capture is None:
        result["maxApiCallsOnExecute"] = len(prepared)
        return result
    require(isinstance(capture, dict), "capture must be an object")
    require(capture.get("schemaVersion") == "support-program-evidence-capture-v1", "unsupported capture schema")
    require(capture.get("fixtureSha256") == fixture_hash, "capture fixture hash differs")
    for field in ("promptSha256", "runnerSha256"):
        value = capture.get(field)
        require(isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value),
                "capture execution hashes required")
    require(isinstance(capture.get("model"), str) and bool(capture["model"].strip()), "capture model required")
    for field in ("modelTimeoutSeconds", "runTimeoutSeconds"):
        require(type(capture.get(field)) in (int, float) and 0 < capture[field] < float("inf"), "invalid timeout")
    result["execution"] = {field: capture[field] for field in (
        "model", "promptSha256", "runnerSha256", "modelTimeoutSeconds", "runTimeoutSeconds",
    )}
    records = capture.get("cases")
    require(isinstance(records, list) and 0 < len(records) <= len(prepared), "invalid capture coverage")
    complete = capture.get("completed")
    require(type(complete) is bool, "capture completed flag required")
    matches = 0
    citation_recalls = []
    failed = False
    for index, record in enumerate(records):
        require(isinstance(record, dict), "invalid capture record")
        case, request = prepared[index]
        require(record.get("caseId") == case["id"] and record.get("requestSha256") == request_digest(request),
                "capture request order or hash differs")
        require(isinstance(record.get("outcome"), str) and record["outcome"] in {"success", "error"}, "invalid outcome")
        if record["outcome"] == "error":
            require(index == len(records) - 1 and not complete, "failed run must stop immediately")
            failed = True
            result["cases"].append({"id": case["id"], "outcome": "error"})
            continue
        answer = SupportProgramEvidenceAnswerResponse.model_validate(record.get("response"))
        by_id = {chunk.id: chunk.order for chunk in request.chunks}
        require(set(answer.citation_chunk_ids) <= by_id.keys(), "capture cites an unprovided chunk")
        cited_orders = [by_id[chunk_id] for chunk_id in answer.citation_chunk_ids]
        status_matches = answer.answer_status.value == case["expectedStatus"]
        matches += int(status_matches)
        if case["expectedCitationOrders"]:
            citation_recalls.append(len(set(cited_orders) & set(case["expectedCitationOrders"])) / len(case["expectedCitationOrders"]))
        result["cases"].append({
            "id": case["id"], "question": case["question"], "outcome": "success",
            "expectedStatus": case["expectedStatus"], "actualStatus": answer.answer_status.value,
            "statusMatches": status_matches, "answer": answer.answer,
            "citedOrders": cited_orders, "expectedCitationOrders": case["expectedCitationOrders"],
            "referenceFacts": case["referenceFacts"], "forbiddenClaims": case["forbiddenClaims"],
        })
    require(complete == (len(records) == len(prepared) and not failed), "capture completion is inconsistent")
    result.update(measured=True, completed=complete, observedCaseCount=len(records))
    if complete:
        result["statusAccuracy"] = matches / len(prepared)
        result["referenceCitationRecall"] = sum(citation_recalls) / len(citation_recalls) if citation_recalls else None
    # Valid citation IDs and expected statuses do not prove factual faithfulness.
    return result


def diagnose_response(response: dict, request: SupportProgramEvidenceAnswerRequest) -> str:
    """Classify recorded evidence only; this cannot recover an unrecorded historical cause."""
    if response.get("responseStatus") == "incomplete":
        return "incomplete_response"
    if response.get("responseStatus") == "failed":
        return "upstream_failed"
    if response.get("hasRefusal") is True:
        return "model_refusal"
    if response.get("outputTextTruncated") is True:
        return "unknown"
    texts = response.get("outputTexts")
    if not isinstance(texts, list) or len(texts) != 1 or not isinstance(texts[0], str):
        return "unknown"
    try:
        payload = json.loads(texts[0])
    except ValueError:
        return "invalid_json"
    try:
        if isinstance(payload, dict) and "citationChunkIndexes" in payload:
            selection = SupportProgramEvidenceAnswerSelection.model_validate(payload)
            return "unknown_citation" if any(index >= len(request.chunks) for index in selection.citation_chunk_indexes) else "unknown"
        answer = SupportProgramEvidenceAnswerResponse.model_validate(payload)
    except ValueError:
        return "invalid_answer_contract"
    if not set(answer.citation_chunk_ids).issubset({chunk.id for chunk in request.chunks}):
        return "unknown_citation"
    return "unknown"


def response_record(status_code: int, body: object) -> dict:
    """Allowlisted response diagnostics shared by the answer and full-flow evaluation tools."""
    body = body if isinstance(body, dict) else {}
    usage = body.get("usage")
    parts = [part for item in body.get("output", [])
             if isinstance(item, dict) and isinstance(item.get("content"), list)
             for part in item["content"] if isinstance(part, dict)] \
        if status_code == 200 and isinstance(body.get("output"), list) else []
    status = body.get("status")
    incomplete = body.get("incomplete_details")
    reason = incomplete.get("reason") if isinstance(incomplete, dict) else None
    return {
        "httpStatus": status_code,
        "usage": {name: usage.get(name) for name in ("input_tokens", "output_tokens", "total_tokens")}
        if isinstance(usage, dict) else None,
        "responseStatus": status if status in (
            "completed", "failed", "in_progress", "cancelled", "queued", "incomplete",
        ) else None,
        "incompleteReason": reason if reason in ("max_output_tokens", "content_filter") else None,
        "hasRefusal": any(part.get("type") == "refusal" for part in parts),
        "outputTextTruncated": any(part.get("type") == "output_text" and
                                   isinstance(part.get("text"), str) and len(part["text"]) > 20_000 for part in parts),
        "outputTexts": [part["text"][:20_000] for part in parts
                        if part.get("type") == "output_text" and isinstance(part.get("text"), str)],
    }


async def execute(prepared: list, fixture_hash: str, output_dir: Path) -> dict:
    from langchain_openai import ChatOpenAI
    import httpx2
    from openai import AsyncOpenAI
    from app.support_program_evidence.agent import SupportProgramEvidenceAnswerAgent
    from app.support_program_evidence.answer_service import SupportProgramEvidenceAnswerService

    key = os.environ.get("OPENAI_API_KEY", "").strip()
    require(bool(key), "OPENAI_API_KEY must be explicitly supplied; .env is not read")
    output_dir.mkdir(parents=True, exist_ok=False)
    capture = {
        "schemaVersion": "support-program-evidence-capture-v1", "fixtureSha256": fixture_hash,
        "promptSha256": digest(SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS.encode()),
        "runnerSha256": digest(Path(__file__).read_bytes()), "model": DEFAULT_OPENAI_MODEL,
        "modelTimeoutSeconds": DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
        "runTimeoutSeconds": DEFAULT_LLM_RUN_TIMEOUT_SECONDS,
        "startedAt": datetime.now(timezone.utc).isoformat(), "completed": False,
        "caseIds": [case["id"] for case, _ in prepared],
        "cases": [], "apiResponses": [],
    }

    def save_capture() -> None:
        temporary = output_dir / "capture.partial.json"
        temporary.write_text(json.dumps(capture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        temporary.replace(output_dir / "capture.json")

    async def record_usage(response: httpx2.Response) -> None:
        await response.aread()
        try:
            body = response.json()
        except ValueError:
            body = {}
        capture["apiResponses"].append(response_record(response.status_code, body))

    client = AsyncOpenAI(
        api_key=key, base_url="https://api.openai.com/v1", max_retries=0,
        http_client=httpx2.AsyncClient(event_hooks={"response": [record_usage]}),
    )
    service = SupportProgramEvidenceAnswerService(SupportProgramEvidenceAnswerAgent(
        model=ChatOpenAI(
            model=DEFAULT_OPENAI_MODEL, api_key=key, use_responses_api=True, max_retries=0,
            root_async_client=client, async_client=client.chat.completions,
        ),
        model_timeout_seconds=DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
        run_timeout_seconds=DEFAULT_LLM_RUN_TIMEOUT_SECONDS,
    ))
    try:
        for case, request in prepared:
            record = {"caseId": case["id"], "requestSha256": request_digest(request)}
            response_offset = len(capture["apiResponses"])
            started = perf_counter()
            try:
                answer = await service.answer(request)
                record.update(outcome="success", response=answer.model_dump(by_alias=True, mode="json"))
            except Exception as error:
                # Never persist SDK exception text, authentication headers or raw error bodies.
                record.update(outcome="error", errorType=type(error).__name__)
                if error.__cause__ is not None:
                    record["causeType"] = type(error.__cause__).__name__
                observed = capture["apiResponses"][response_offset:]
                record["diagnosticCategory"] = diagnose_response(observed[0], request) \
                    if len(observed) == 1 else "unknown"
            record["elapsedMs"] = round((perf_counter() - started) * 1000, 3)
            capture["cases"].append(record)
            save_capture()
            if record["outcome"] == "error":
                break
        capture["completed"] = len(capture["cases"]) == len(prepared) and all(
            record["outcome"] == "success" for record in capture["cases"]
        )
    finally:
        try:
            capture["finishedAt"] = datetime.now(timezone.utc).isoformat()
            save_capture()
        finally:
            await client.close()
    return capture


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=HERE / "fixture.json")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--capture", type=Path, help="recalculate a saved model run without API calls")
    mode.add_argument("--execute", action="store_true", help="make up to 12 paid answer calls; no embeddings or retries")
    parser.add_argument("--output-dir", type=Path, help="new directory required only with --execute")
    parser.add_argument("--case-id", action="append", help="select fixture questions in fixture order; repeat to select several")
    args = parser.parse_args()
    if bool(args.output_dir) != args.execute:
        parser.error("--execute and a new --output-dir must be used together")
    if args.capture and args.case_id:
        parser.error("saved captures already identify their selected cases")
    try:
        fixture, prepared, fixture_hash = load_fixture(args.fixture)
        if args.case_id:
            prepared = select_cases(prepared, args.case_id)
        capture = json.loads(args.capture.read_text(encoding="utf-8")) if args.capture else None
        if args.execute:
            capture = asyncio.run(execute(prepared, fixture_hash, args.output_dir))
        result = report(fixture, prepared, fixture_hash, capture)
        if args.execute:
            (args.output_dir / "report.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n",
            )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if capture is not None and not result["completed"] else 0
    except (ValueError, OSError) as error:
        print(f"Evaluation failed: {type(error).__name__}. Check fixture, capture and output paths.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
