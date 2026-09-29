"""Ops의 로컬 또는 내부 HTTP 저장소 읽기. 원격 장애 시 로컬 사본으로 대체하지 않는다."""

import json
import os
from http.client import HTTPException
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from django.conf import settings

from .artifact_files import (
    EVIDENCE_FILES,
    MAX_FILE_BYTES,
    read_file,
    result_name,
    validate_token,
)


class ResultsUnavailable(Exception):
    pass


class NoArtifactRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def remote_read(path):
    try:
        endpoint = settings.LLMOPS_ARTIFACT_URL
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.hostname.endswith(".invalid")
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or any(char.isspace() for char in endpoint)
        ):
            raise ValueError("Invalid artifact endpoint")
        validate_token(settings.LLMOPS_ARTIFACT_TOKEN)
        request = Request(
            endpoint.rstrip("/") + path,
            headers={"Authorization": f"Bearer {settings.LLMOPS_ARTIFACT_TOKEN}"},
        )
        # Do not forward storage credentials to a redirect or environment-configured proxy.
        with build_opener(ProxyHandler({}), NoArtifactRedirect()).open(
            request, timeout=3
        ) as response:
            if response.status != 200 or response.headers.get("Content-Encoding"):
                raise ValueError("Invalid artifact response")
            raw = response.read(MAX_FILE_BYTES + 1)
            if len(raw) > MAX_FILE_BYTES or int(response.headers["Content-Length"]) != len(raw):
                raise ValueError("Incomplete or oversized artifact")
            return raw
    except HTTPError as exc:
        exc.close()
        raise ResultsUnavailable from None
    except (OSError, ValueError, TypeError, HTTPException) as exc:
        raise ResultsUnavailable from exc


def read_artifact(run_id, name):
    try:
        name = result_name(run_id, name)
        if settings.LLMOPS_ARTIFACT_URL:
            return remote_read("/v1/results/" + name)
        return read_file(settings.LLMOPS_RESULTS_DIR, name)
    except (OSError, ValueError) as exc:
        raise ResultsUnavailable from exc


def read_evidence(name):
    try:
        if name not in EVIDENCE_FILES:
            raise ValueError("Unknown evidence")
        if settings.LLMOPS_ARTIFACT_URL:
            return remote_read("/v1/evidence/" + quote(name, safe="/"))
        return read_file(settings.LLMOPS_EVIDENCE_DIR, name)
    except (OSError, ValueError) as exc:
        raise ResultsUnavailable from exc


def check_results():
    try:
        if settings.LLMOPS_ARTIFACT_URL:
            value = json.loads(remote_read("/v1/status"))
            return value == {"schema_version": 1, "results_readable": True}
        with os.scandir(settings.LLMOPS_RESULTS_DIR) as entries:
            next(entries, None)
        return True
    except (OSError, ValueError, ResultsUnavailable):
        return False
