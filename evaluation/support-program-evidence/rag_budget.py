"""고정 자료를 사용하는 내부 RAG 세션의 SDK 승인·정산 경계. Ops 실행 명세 또는 내부 세션 명세를 검증한다."""

import json
import re
import sys
from copy import deepcopy
from hashlib import sha256
from pathlib import Path

from app.support_program_evidence.models import (
    SupportProgramEvidenceAnswerRequest,
    SupportProgramEvidenceAnswerSelection,
    SupportProgramEvidenceBatchRequest,
    SupportProgramEvidenceSearchRequest,
    SupportProgramEvidenceSearchResponse,
)
from budget_client import BudgetUnavailable
from embedding_budget import EmbeddingBudget, embedding_operations
from evaluate import (
    DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
    DEFAULT_OPENAI_MODEL,
    MAX_INPUT_TOKENS,
    SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS,
)
from openai import pydantic_function_tool

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/ops-service"))
RUNTIME_FILES = (
    *(
        f"evaluation/support-program-evidence/{name}.py"
        for name in (
            "rag_budget",
            "embedding_budget",
            "budget_client",
            "serve_flow",
            "evaluate",
        )
    ),
    *(
        f"backend/ai-service/app/{name}.py"
        for name in (
            "bootstrap",
            "main",
            "config",
            "tracing",
            "support_program_embedding",
            "support_program_llm",
            "support_program_identity",
            "support_program_evidence/service",
            "support_program_evidence/agent",
            "support_program_evidence/answer_service",
            "support_program_evidence/router",
            "support_program_evidence/models",
            "support_program_evidence/prompt",
            "support_program_evidence/errors",
        )
    ),
    "backend/ai-service/pyproject.toml",
    "backend/ai-service/uv.lock",
    "backend/ops-service/apps/evaluations/vector_cache.py",
)


def digest(value):
    return sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def require(condition):
    if not condition:
        raise BudgetUnavailable("RAG request differs from the approved session")


def make_rag_spec(cases, *, model=DEFAULT_OPENAI_MODEL, document_sources=None, document_vectors=None):
    """전송할 청크·질문과 순서, 현행 소스·모델·토큰 상한을 고정한다. 예약 생성은 하지 않는다."""
    require(
        isinstance(model, str) and bool(re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", model))
    )
    require(isinstance(cases, list) and 1 <= len(cases) <= 12)
    prepared, operations, seen = [], [], set()
    for case in cases:
        require(
            isinstance(case, dict)
            and set(case) == {"case_id", "chunks", "question", "limit"}
        )
        name = case["case_id"]
        require(
            isinstance(name, str)
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}", name)
            and name not in seen
        )
        seen.add(name)
        batch = SupportProgramEvidenceBatchRequest.model_validate(
            {"chunks": case["chunks"]}
        )
        chunks = batch.model_dump(by_alias=True)["chunks"]
        search = SupportProgramEvidenceSearchRequest.model_validate(
            {
                "question": case["question"],
                "limit": case["limit"],
                "eligibleChunks": [
                    {key: value for key, value in chunk.items() if key != "text"}
                    for chunk in chunks
                ],
            }
        )
        prepared.append(
            {
                "case_id": name,
                "chunks": chunks,
                "question": search.question,
                "limit": search.limit,
            }
        )
        for kind, texts in (
            ("document_embedding", [chunk["text"] for chunk in chunks]),
            ("query_embedding", [search.question]),
        ):
            operations.extend(
                embedding_operations(
                    texts,
                    kind=kind,
                    label=name,
                    model="text-embedding-3-small",
                    dimensions=1536,
                    request_token_limit=262112,
                )
            )
        operations.append(
            {
                "id": f"answer:{name}",
                "kind": "answer",
                "case_id": name,
                "model": model,
                "max_input_tokens": MAX_INPUT_TOKENS,
                "max_output_tokens": 2000,
            }
        )
    require(len(operations) <= 512)
    plan = {
        "evaluation_scope": "source-chunks-retrieval-answer",
        "execution_mode": "live",
        "rag_cases": prepared,
        "runtime_sha256": {
            name: sha256((ROOT / name).read_bytes()).hexdigest()
            for name in RUNTIME_FILES
        },
        "live_config": {
            "model": model,
            "embedding_model": "text-embedding-3-small",
            "embedding_dimensions": 1536,
            "max_model_calls": len(operations),
            "max_input_tokens": max(item["max_input_tokens"] for item in operations),
            "max_output_tokens": 2000,
        },
        "model_operations": operations,
    }
    if document_sources is not None:
        from apps.evaluations.vector_cache import apply_plan

        require(set(document_sources) == seen and all(
            isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
            for value in document_sources.values()
        ))
        plan["document_sources"] = document_sources
        plan["document_vector_keys"] = {
            case["case_id"]: digest({
                "schema_version": 1,
                "source_sha256": document_sources[case["case_id"]],
                "chunks": case["chunks"],
                "model": plan["live_config"]["embedding_model"],
                "dimensions": plan["live_config"]["embedding_dimensions"],
                "embedding_code_sha256": plan["runtime_sha256"]["backend/ai-service/app/support_program_embedding.py"],
            }) for case in prepared
        }
        if document_vectors is not None:
            plan = apply_plan(plan, document_vectors)
    else:
        require(document_vectors is None)
    return plan


class RagBudget:
    """하나의 승인된 세션에서 색인·검색·답변과 그 SDK 호출을 순서대로 대조한다."""

    def __init__(self, client, spec, *, receipt_directory, execution_spec=None):
        require(
            spec == make_rag_spec(
                spec["rag_cases"], model=spec["live_config"]["model"],
                document_sources=spec.get("document_sources"),
                document_vectors=spec["live_config"].get("document_vectors"),
            )
            and digest(execution_spec or spec) == client.identity["spec_hash"]
            and (
                execution_spec is None
                or (
                    execution_spec["evaluation_scope"] == spec["evaluation_scope"]
                    and execution_spec["execution_mode"] == "live"
                    and execution_spec["model_operations"] == spec["model_operations"]
                    and all(
                        execution_spec["live_config"][key] == value
                        for key, value in spec["live_config"].items()
                    )
                )
            )
        )
        self.client, self.spec = client, deepcopy(spec)
        self.receipt_directory = Path(receipt_directory)
        self.embeddings = EmbeddingBudget(
            client, spec["model_operations"], receipt_directory=receipt_directory
        )
        self.case_index, self.phase = 0, "chunks"
        self.busy, self.stopped = False, False
        self.answer = self.count_payload = None
        self.sdk = None

    def stop(self):
        self.stopped = self.embeddings.stopped = True

    def begin_api(self, method, path, payload):
        require(
            not self.stopped
            and not self.busy
            and self.case_index < len(self.spec["rag_cases"])
        )
        self.busy = True
        case = self.spec["rag_cases"][self.case_index]
        require(
            path == "/internal/v1/support-program-evidence/" + self.phase
            and method == ("PUT" if self.phase == "chunks" else "POST")
        )
        if self.phase == "chunks":
            expected = {"chunks": case["chunks"]}
        elif self.phase == "search":
            expected = {
                "question": case["question"],
                "limit": case["limit"],
                "eligibleChunks": [
                    {k: v for k, v in chunk.items() if k != "text"}
                    for chunk in case["chunks"]
                ],
            }
        else:
            expected = self.answer
        require(payload == expected)

    def finish_api(self, status, payload):
        if status != 200:
            self.stop()
            return
        case = self.spec["rag_cases"][self.case_index]
        if self.phase == "chunks":
            require(payload == {"indexedCount": len(case["chunks"])})
            self.phase = "search"
        elif self.phase == "search":
            result = SupportProgramEvidenceSearchResponse.model_validate(payload)
            require(
                result.question == case["question"]
                and 0 < len(result.matches) <= case["limit"]
            )
            chunks = {chunk["id"]: chunk for chunk in case["chunks"]}
            selected = []
            for match in result.matches:
                chunk = chunks.get(match.id)
                require(
                    chunk is not None
                    and all(
                        chunk[key] == value
                        for key, value in match.model_dump(
                            by_alias=True, exclude={"score"}
                        ).items()
                    )
                )
                selected.append({k: v for k, v in chunk.items() if k != "contentHash"})
            self.answer = SupportProgramEvidenceAnswerRequest(
                question=case["question"], chunks=selected
            ).model_dump(by_alias=True)
            self.phase = "answers"
        else:
            sequence = self.embeddings.last_sequence
            require(
                not self.embeddings.stopped
                and sequence >= 0
                and self.spec["model_operations"][sequence]["id"]
                == "answer:" + case["case_id"]
            )
            self.case_index += 1
            self.phase, self.answer = "chunks", None
        self.busy = False

    async def before_request(self, request):
        require(not self.stopped and self.busy and request.method == "POST")
        endpoint = str(request.url)
        body = json.loads(request.content)
        if endpoint == "https://api.openai.com/v1/responses/input_tokens":
            expected, self.count_payload = self.count_payload, None
            require(expected is not None and body == expected)
            return
        if endpoint == "https://api.openai.com/v1/embeddings":
            require(self.phase in {"chunks", "search"})
            await self.embeddings.before_request(
                request,
                operation_kind=(
                    "document_embedding"
                    if self.phase == "chunks"
                    else "query_embedding"
                ),
            )
            require(not self.stopped)
            return
        require(
            endpoint == "https://api.openai.com/v1/responses"
            and self.phase == "answers"
            and not self.embeddings.stopped
        )
        self.embeddings.stopped = (
            True  # Remains closed on timeout, lost approval, or cancellation.
        )
        case = self.spec["rag_cases"][self.case_index]
        sequence, operation = next(
            (i, item)
            for i, item in enumerate(self.spec["model_operations"])
            if item["id"] == "answer:" + case["case_id"]
        )
        require(
            sequence > self.embeddings.last_sequence
            and not any(
                item["kind"] == "answer"
                for item in self.spec["model_operations"][
                    self.embeddings.last_sequence + 1 : sequence
                ]
            )
        )
        schema = pydantic_function_tool(SupportProgramEvidenceAnswerSelection)[
            "function"
        ]
        answer_payload = {
            "question": self.answer["question"],
            "chunks": [
                {"index": i, **{k: v for k, v in chunk.items() if k != "id"}}
                for i, chunk in enumerate(self.answer["chunks"])
            ],
        }
        require(
            set(body)
            <= {
                "model",
                "input",
                "text",
                "reasoning",
                "max_output_tokens",
                "store",
                "stream",
            }
            and body.get("model") == operation["model"]
            and type(body.get("max_output_tokens")) is int
            and body.get("max_output_tokens") == 2000
            and body.get("store") is False
            and body.get("stream", False) is False
            and body.get("reasoning") == {"effort": "none"}
            and body.get("text")
            == {
                "format": {
                    "type": "json_schema",
                    "name": schema["name"],
                    "schema": schema["parameters"],
                    "strict": True,
                }
            }
            and body.get("input")
            == [
                {
                    "type": "message",
                    "role": "system",
                    "content": SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS,
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": json.dumps(answer_payload, ensure_ascii=False),
                },
            ]
        )
        self.count_payload = {
            key: body[key] for key in ("model", "input", "text", "reasoning")
        }
        try:
            raw = await self.sdk.responses.input_tokens.with_raw_response.count(
                **self.count_payload, timeout=DEFAULT_LLM_MODEL_TIMEOUT_SECONDS
            )
            measured = raw.http_response.json()
        finally:
            self.count_payload = None
        tokens = measured.get("input_tokens") if isinstance(measured, dict) else None
        require(
            not self.stopped
            and isinstance(measured, dict)
            and measured.get("object") == "response.input_tokens"
            and type(tokens) is int
            and 0 <= tokens <= operation["max_input_tokens"]
        )
        await self.client.authorize(
            sequence,
            operation["model"],
            operation["max_output_tokens"],
            operation_id=operation["id"],
            input_token_count=tokens,
        )
        require(not self.stopped)
        self.embeddings.last_sequence = sequence
        request.extensions["rag_answer_budget"] = (sequence, operation)
        request.extensions["rag_input_tokens"] = tokens

    async def after_response(self, response):
        if (
            str(response.request.url)
            == "https://api.openai.com/v1/responses/input_tokens"
        ):
            return
        if "embedding_budget" in response.request.extensions:
            await self.embeddings.after_response(response)
            return
        sequence, item = response.request.extensions["rag_answer_budget"]
        await response.aread()
        try:
            body = response.json()
        except ValueError:
            body = {}
        usage = body.get("usage") if isinstance(body, dict) else None
        valid = (
            response.status_code == 200
            and isinstance(body, dict)
            and body.get("model") == item["model"]
            and body.get("status") in {"completed", "incomplete", "failed", "cancelled"}
            and isinstance(usage, dict)
            and all(
                type(usage.get(key)) is int and usage[key] >= 0
                for key in ("input_tokens", "output_tokens", "total_tokens")
            )
            and usage["input_tokens"] <= item["max_input_tokens"]
            and usage["output_tokens"] <= item["max_output_tokens"]
            and usage["input_tokens"] + usage["output_tokens"] == usage["total_tokens"]
        )
        if not valid:
            await self.client.settle(sequence, None, operation_id=item["id"])
            raise BudgetUnavailable("Answer usage is unknown")
        self.client.record_usage_receipt(
            self.receipt_directory,
            sequence,
            item["model"],
            item["max_output_tokens"],
            response.status_code,
            body,
        )
        await self.client.settle(
            sequence,
            {
                key: usage[key]
                for key in ("input_tokens", "output_tokens", "total_tokens")
            },
            operation_id=item["id"],
        )
        self.embeddings.stopped = body["status"] != "completed"
