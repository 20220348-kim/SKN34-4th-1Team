"""Ops가 접수한 유료 실행의 예약을 전송 직전에 확인한다. 재전송은 하지 않는다."""

import asyncio
import json
import os
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

    async def authorize(self, sequence, model, max_output_tokens):
        await asyncio.to_thread(self.request, "authorize", sequence=sequence,
                                model=model, max_output_tokens=max_output_tokens)

    async def settle(self, sequence, usage):
        await asyncio.to_thread(self.request, "settle", sequence=sequence, usage=usage)
        if usage is None:
            raise BudgetUnavailable("Model usage is unknown; further calls are blocked")

    def close(self):
        self.request("close")
