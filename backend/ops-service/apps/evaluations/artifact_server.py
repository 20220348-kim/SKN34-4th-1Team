"""Compose 결과 볼륨의 인증된 읽기 전용 WSGI 서비스. DB와 Django 설정을 사용하지 않는다."""

import hmac
import json
import os
from pathlib import Path

from .artifact_files import (
    EVIDENCE_FILES,
    MAX_RECEIPT_BYTES,
    read_file,
    receipt_name,
    result_name,
    validate_token,
)


def create_app():
    return application(
        Path(os.environ["LLMOPS_RESULTS_DIR"]),
        Path(os.environ["LLMOPS_EVIDENCE_DIR"]),
        os.environ["LLMOPS_ARTIFACT_TOKEN"],
    )


def application(results, evidence, token):
    validate_token(token)

    def serve(environ, start_response):
        status, raw = "404 Not Found", b'{"code":"ARTIFACT_UNAVAILABLE"}'
        authorization = environ.get("HTTP_AUTHORIZATION", "")
        if not hmac.compare_digest(authorization.encode(), f"Bearer {token}".encode()):
            status, raw = "401 Unauthorized", b'{"code":"ARTIFACT_AUTH_REQUIRED"}'
        elif environ.get("REQUEST_METHOD") != "GET":
            status, raw = "405 Method Not Allowed", b'{"code":"READ_ONLY"}'
        elif not environ.get("QUERY_STRING"):
            path = environ.get("PATH_INFO", "")
            try:
                if path == "/v1/status":
                    # Availability only; this does not prove writer liveness or volume identity.
                    with os.scandir(results) as entries:
                        next(entries, None)
                    raw = json.dumps({"schema_version": 1, "results_readable": True}).encode()
                elif path.startswith("/v1/usage-receipts/"):
                    run_id, sequence = path.removeprefix("/v1/usage-receipts/").split("/", 1)
                    if sequence != str(int(sequence)):
                        raise ValueError("Noncanonical receipt sequence")
                    raw = read_file(
                        results, receipt_name(run_id, int(sequence)), max_bytes=MAX_RECEIPT_BYTES
                    )
                elif path.startswith("/v1/vector-cache/"):
                    from .vector_cache import status as vector_status

                    raw = json.dumps(
                        vector_status(results, path.removeprefix("/v1/vector-cache/"))
                    ).encode()
                elif path.startswith("/v1/results/"):
                    run_id, name = path.removeprefix("/v1/results/").split("/", 1)
                    raw = read_file(results, result_name(run_id, name))
                elif path.startswith("/v1/evidence/"):
                    name = path.removeprefix("/v1/evidence/")
                    if name not in EVIDENCE_FILES:
                        raise ValueError("Unknown evidence")
                    raw = read_file(evidence, name)
                else:
                    raise ValueError("Unknown path")
                status = "200 OK"
            except (OSError, ValueError):
                pass
        headers = [
            ("Content-Type", "application/octet-stream"),
            ("Content-Length", str(len(raw))),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
        ]
        if status.startswith("401"):
            headers.append(("WWW-Authenticate", "Bearer"))
        if status.startswith("405"):
            headers.append(("Allow", "GET"))
        start_response(status, headers)
        return [raw]

    return serve
