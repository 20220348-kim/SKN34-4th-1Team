"""Ops가 접수한 유료 실행의 예약을 전송 직전에 확인한다. 재전송은 하지 않는다."""

import asyncio
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
import re
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID, uuid4


class BudgetUnavailable(RuntimeError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class BudgetClient:
    def __init__(self, request_id, flow_id, spec_hash):
        self.url = os.environ.get("LLMOPS_OPS_API_URL", "http://127.0.0.1:18001").rstrip("/")
        self.token = os.environ.get("LLMOPS_BUDGET_TOKEN", "")
        parsed = urlsplit(self.url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path or len(self.token) < 32):
            raise BudgetUnavailable("Ops budget connection is not configured")
        self.url += f"/internal/llmops/evaluations/{UUID(request_id)}/budget/"
        self.run_id = str(UUID(request_id))
        self.identity = {"worker_id": str(uuid4()), "flow_id": str(UUID(flow_id)),
                         "spec_hash": spec_hash}

    def request(self, action, **fields):
        request = Request(self.url + action,
                          data=json.dumps({**self.identity, **fields}).encode(),
                          headers={"Authorization": "Bearer " + self.token,
                                   "Content-Type": "application/json"}, method="POST")
        try:
            with build_opener(NoRedirect()).open(request, timeout=3) as response:
                result = json.loads(response.read(8193))
                if response.status != 200 or result != {"accepted": True}:
                    raise ValueError("Unexpected budget response")
        except (URLError, OSError, ValueError) as error:
            raise BudgetUnavailable("Ops budget authorization or settlement failed") from error

    def claim(self):
        self.request("claim")

    async def authorize(self, sequence, model, max_output_tokens, *, operation_id, input_token_count, input_sha256=None, dimensions=None):
        embedding = {} if input_sha256 is None else {"input_sha256": input_sha256, "dimensions": dimensions}
        await asyncio.to_thread(self.request, "authorize", sequence=sequence,
                                model=model, max_output_tokens=max_output_tokens, operation_id=operation_id,
                                input_token_count=input_token_count, **embedding)

    async def settle(self, sequence, usage, *, operation_id):
        await asyncio.to_thread(self.request, "settle", sequence=sequence, usage=usage, operation_id=operation_id)
        if usage is None:
            raise BudgetUnavailable("Model usage is unknown; further calls are blocked")

    def record_usage_receipt(self, directory, sequence, model, max_output_tokens, status, body):
        """Persist allowlisted, authenticated usage before attempting the settlement HTTP call."""
        usage = body.get("usage") if isinstance(body, dict) else None
        if (status != 200 or not isinstance(usage, dict)
                or body.get("status") not in {"completed", "incomplete", "failed", "cancelled"}
                or not re.fullmatch(r"resp_[A-Za-z0-9_-]{1,180}", str(body.get("id", "")))):
            return  # No trustworthy usage receipt: the existing settlement rules still apply.
        usage = {key: usage.get(key) for key in ("input_tokens", "output_tokens", "total_tokens")}
        if (any(type(value) is not int or not 0 <= value <= 2**53 - 1 for value in usage.values())
                or usage["input_tokens"] + usage["output_tokens"] != usage["total_tokens"]
                or usage["output_tokens"] > max_output_tokens):
            return
        payload = {
            "version": 1, "source": "WORKER_RESPONSE", "run_id": self.run_id,
            **self.identity, "sequence": sequence, "model": model,
            "max_output_tokens": max_output_tokens, "response_id": body["id"],
            "response_status": body["status"], "usage": usage,
            "observed_at": datetime.now(timezone.utc).isoformat(),
        }
        self._write_usage_receipt(directory, sequence, payload)

    def record_embedding_usage_receipt(self, directory, sequence, operation, provider_request_id, usage):
        """Keep the observed request ID, batch identity and usage; never invent a response ID."""
        if (not isinstance(provider_request_id, str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,199}", provider_request_id)):
            return  # Usage can settle normally; a lost settlement without this ID stays unknown.
        if (operation.get("kind") not in {"document_embedding", "query_embedding"}
                or type(sequence) is not int or not 0 <= sequence <= 511
                or type(operation.get("max_input_tokens")) is not int
                or not 1 <= operation["max_input_tokens"] <= 262112
                or type(operation.get("max_output_tokens")) is not int or operation["max_output_tokens"] != 0
                or not isinstance(usage, dict) or set(usage) != {"input_tokens", "output_tokens", "total_tokens"}
                or any(type(value) is not int for value in usage.values())
                or not 0 <= usage["input_tokens"] <= operation["max_input_tokens"]
                or usage["output_tokens"] != 0 or usage["total_tokens"] != usage["input_tokens"]):
            raise BudgetUnavailable("Invalid embedding usage receipt")
        payload = {
            "version": 2, "source": "WORKER_EMBEDDING_RESPONSE", "run_id": self.run_id,
            **self.identity, "sequence": sequence, "operation_id": operation["id"],
            "operation_kind": operation["kind"], "model": operation["model"],
            "dimensions": operation["dimensions"], "input_sha256": operation["input_sha256"],
            "max_input_tokens": operation["max_input_tokens"], "max_output_tokens": 0,
            "provider_request_id": provider_request_id, "usage": usage,
            "observed_at": datetime.now(timezone.utc).isoformat(),
        }
        self._write_usage_receipt(directory, sequence, payload)

    def _write_usage_receipt(self, directory, sequence, payload):
        """Both receipt versions use the same exclusive, durable file boundary."""
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        domain = f"govbiz-budget-usage-v{payload['version']}\n".encode()
        signature = hmac.new(self.token.encode(), domain + canonical,
                             hashlib.sha256).hexdigest()
        raw = json.dumps({"payload": payload, "signature": signature},
                         sort_keys=True, separators=(",", ":")).encode()
        temporary = directory / f".usage-{sequence}-{uuid4()}.tmp"
        try:
            with temporary.open("xb") as stream:
                os.chmod(temporary, 0o600)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            # Link is exclusive: never overwrite an earlier receipt for the same call.
            os.link(temporary, directory / f"usage-{sequence}.json")
            descriptor = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        except OSError as error:
            raise BudgetUnavailable("Usage receipt could not be preserved") from error
        finally:
            temporary.unlink(missing_ok=True)

    def close(self):
        self.request("close")
