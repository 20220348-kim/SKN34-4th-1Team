"""Disposable CI-only AI wire recorder. Never enable on a user/production server."""

import json
import os
import re
from hashlib import sha256
from pathlib import Path

CAPTURE_PATH = Path("/tmp/govbiz-rag-capture.jsonl")
PREFIX = "/internal/v1/support-program-evidence/"
PROGRAM = "BIZINFO:PBLN_COMPOSE_EXPORT"
QUERY = re.compile(
    r"PRIVATE-RAG-QUERY-[0-9a-f]{32}-(ok|miss|citation-miss|insufficient|fail|timeout|invalid-citation|search-fail)\Z"
)


def fixture_request(operation, payload):
    if not isinstance(payload, dict):
        return False
    if operation in {"chunks", "answers"}:
        chunks = payload.get("chunks")
        allowed_chunks = (
            isinstance(chunks, list)
            and bool(chunks)
            and all(
                isinstance(chunk, dict)
                and chunk.get("documentId") == PROGRAM
                and str(chunk.get("text", "")).startswith("PRIVATE-RAG-SOURCE ")
                for chunk in chunks
            )
        )
        if not allowed_chunks or operation == "chunks":
            return allowed_chunks
    elif operation == "search":
        chunks = payload.get("eligibleChunks")
        if (
            not isinstance(chunks, list)
            or not chunks
            or not all(
                isinstance(chunk, dict) and chunk.get("documentId") == PROGRAM
                for chunk in chunks
            )
        ):
            return False
    else:
        return False
    return QUERY.fullmatch(str(payload.get("question", ""))) is not None


class RagCaptureApp:
    """Record only the allowlisted synthetic evidence operations without changing HTTP bytes."""

    def __init__(self, app, path):
        self.app, self.path = app, path

    async def __call__(self, scope, receive, send):
        operation = scope.get("path", "").removeprefix(PREFIX)
        if (
            scope["type"] != "http"
            or scope.get("path") != PREFIX + operation
            or operation not in {"chunks", "search", "answers"}
        ):
            return await self.app(scope, receive, send)
        request_body, response_body = bytearray(), bytearray()
        status = None

        async def receive_record():
            message = await receive()
            if message["type"] == "http.request":
                request_body.extend(message.get("body", b""))
            return message

        async def send_record(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            if message["type"] == "http.response.body":
                response_body.extend(message.get("body", b""))
                if not message.get("more_body", False):
                    try:
                        payload = json.loads(request_body)
                    except (ValueError, UnicodeError):
                        payload = None
                    if fixture_request(operation, payload):
                        headers = dict(scope.get("headers", []))
                        parent = headers.get(b"traceparent", b"").decode("ascii")
                        if not re.fullmatch(r"00-[0-9a-f]{32}-[0-9a-f]{16}-01", parent):
                            raise ValueError(
                                "RAG capture requires an actual Core traceparent"
                            )
                        record = {
                            "operation": operation,
                            "traceId": parent.split("-")[1],
                            "request": payload,
                            "status": status,
                            "response": json.loads(response_body),
                        }
                        # Persist before the final response reaches Core; no recording endpoint is exposed.
                        with self.path.open("a", encoding="utf-8") as stream:
                            stream.write(
                                json.dumps(record, ensure_ascii=False, allow_nan=False)
                                + "\n"
                            )
            await send(message)

        await self.app(scope, receive_record, send_record)


def create_app():
    base = os.environ.get("OPENAI_BASE_URL", "")
    if (
        os.environ.get("RAG_CAPTURE_FIXTURE") != "true"
        or os.environ.get("OPENAI_API_KEY") != "catalog-verification-key-never-sent"
        or not re.fullmatch(
            r"http://govbiz-catalog-check-[0-9a-f]{12}-openai-stub-1:8002/v1", base
        )
    ):
        raise ValueError(
            "RAG recorder requires the disposable catalog HTTP model fixture"
        )
    from app.config import Settings
    from app.main import create_app as production_app
    from app.support_program_evidence.prompt import (
        SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS,
    )

    # Restarting cannot silently append to another recorder's run.
    settings = Settings.from_environment()
    execution = {
        "kind": "integration-stub",
        "model": settings.openai_model,
        "embeddingModel": settings.openai_embedding_model,
        "promptSha256": sha256(
            SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS.encode()
        ).hexdigest(),
        "recorderSha256": sha256(Path(__file__).read_bytes()).hexdigest(),
        "paidModelApiCalls": 0,
    }
    with CAPTURE_PATH.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps({"execution": execution}) + "\n")
    return RagCaptureApp(production_app(settings=settings), CAPTURE_PATH)
