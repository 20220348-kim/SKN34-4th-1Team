"""RAG 임베딩의 고정 배치 계획과 SDK HTTP 예산 경계. 독립 실행·승인은 하지 않는다."""

import json
import re
from copy import deepcopy
from hashlib import sha256

from app.support_program_embedding import embedding_usage, prepare_embedding_batches
from budget_client import BudgetUnavailable


def input_digest(inputs):
    return sha256(
        json.dumps(inputs, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def embedding_operations(texts, *, kind, label, model, dimensions, request_token_limit):
    """서비스와 동일하게 중복 문자열을 제거하고 전처리된 실제 배치를 고정한다."""
    if (
        kind not in {"document_embedding", "query_embedding"}
        or not isinstance(label, str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}", label)
        or model not in {"text-embedding-3-small", "text-embedding-3-large"}
        or type(dimensions) is not int
        or not 1 <= dimensions <= (1536 if model.endswith("small") else 3072)
        or not isinstance(texts, list)
        or not texts
        or any(not isinstance(text, str) for text in texts)
    ):
        raise ValueError("Invalid embedding plan")
    return [
        {
            "id": f"{kind}:{label}:{index}",
            "kind": kind,
            "model": model,
            "dimensions": dimensions,
            "max_input_tokens": tokens,
            "max_output_tokens": 0,
            "input_sha256": input_digest(batch),
        }
        for index, (batch, tokens) in enumerate(
            prepare_embedding_batches(list(dict.fromkeys(texts)), request_token_limit)
        )
    ]


class EmbeddingBudget:
    """승인된 작업 목록과 실제 임베딩 전송을 대조하고 Ops에 승인·정산한다."""

    def __init__(self, client, operations, *, receipt_directory):
        if not isinstance(operations, list) or not 1 <= len(operations) <= 512:
            raise ValueError("Approved operations are required")
        self.client = client
        self.operations = deepcopy(operations)
        self.receipt_directory = receipt_directory
        self.last_sequence = -1
        self.stopped = False

    async def before_request(self, request, *, operation_kind=None):
        if self.stopped:
            raise BudgetUnavailable("Embedding budget is stopped")
        # Mark before awaiting: concurrent sends, timeout and a lost approval cannot retry.
        self.stopped = True
        if request.method != "POST" or str(request.url) != "https://api.openai.com/v1/embeddings":
            raise BudgetUnavailable("Unapproved embedding endpoint")
        try:
            body = json.loads(request.content)
            inputs = body["input"]
            if (
                set(body) != {"model", "input", "dimensions", "encoding_format"}
                or body["encoding_format"] != "float"
                or not isinstance(inputs, list)
                or not inputs
                or any(not isinstance(item, str) for item in inputs)
            ):
                raise ValueError
            fingerprint = input_digest(inputs)
            matches = [
                (sequence, item)
                for sequence, item in enumerate(self.operations)
                if sequence > self.last_sequence
                and item["kind"] in {"document_embedding", "query_embedding"}
                and (operation_kind is None or item["kind"] == operation_kind)
                and item["input_sha256"] == fingerprint
                and item["model"] == body["model"]
                and item["dimensions"] == body["dimensions"]
            ]
            if not matches:
                raise ValueError
            sequence, item = matches[0]
            if any(
                step["kind"] == "answer"
                for step in self.operations[self.last_sequence + 1 : sequence]
            ):
                raise ValueError
            # Reject re-truncation/re-batching: hashes describe exactly the outgoing payload.
            batches = prepare_embedding_batches(inputs, item["max_input_tokens"])
            if len(batches) != 1 or batches[0][0] != inputs or type(body["dimensions"]) is not int:
                raise ValueError
        except (ValueError, TypeError, KeyError):
            raise BudgetUnavailable("Embedding input differs from the approved batch") from None
        await self.client.authorize(
            sequence,
            item["model"],
            0,
            operation_id=item["id"],
            input_token_count=batches[0][1],
            input_sha256=fingerprint,
            dimensions=item["dimensions"],
        )
        self.last_sequence = sequence
        request.extensions["embedding_budget"] = (sequence, item)

    async def after_response(self, response):
        sequence, item = response.request.extensions["embedding_budget"]
        await response.aread()
        try:
            body = response.json()
            if (
                response.status_code != 200
                or not isinstance(body, dict)
                or body.get("model") != item["model"]
            ):
                raise ValueError
            tokens = embedding_usage(body, item["max_input_tokens"])
        except (ValueError, TypeError):
            await self.client.settle(sequence, None, operation_id=item["id"])
            raise BudgetUnavailable("Embedding usage is unknown") from None
        usage = {"input_tokens": tokens, "output_tokens": 0, "total_tokens": tokens}
        self.client.record_embedding_usage_receipt(
            self.receipt_directory, sequence, item, response.headers.get("x-request-id"), usage
        )
        await self.client.settle(sequence, usage, operation_id=item["id"])
        self.stopped = False
