import asyncio
import json
import logging
from hashlib import sha256
from time import perf_counter
from uuid import uuid4

from langgraph.graph.state import CompiledStateGraph
from openai import APITimeoutError
from pydantic import ValidationError

from app.assistant_agent.errors import AssistantAgentError, AssistantAgentTimeoutError
from app.assistant_agent.models import SCHEMA_VERSION, AssistantAgentRequest, AssistantAgentResponse
from app.assistant_agent.usage import AssistantModelUsage
from app.config import LangfuseSettings
from app.tracing import LLMTracing

logger = logging.getLogger(__name__)


class AssistantAgentService:
    """그래프를 전체 제한 시간 안에 돌리고 응답 계약을 다시 검증한다."""

    def __init__(
        self, *, graph: CompiledStateGraph, timeout_seconds: float, tracing: LLMTracing | None = None,
    ) -> None:
        if not 0 < timeout_seconds <= 60:
            raise ValueError("timeout_seconds must be within 60 seconds")
        self._graph = graph
        self._timeout_seconds = timeout_seconds
        self._tracing = tracing or LLMTracing(LangfuseSettings())

    async def answer(
        self, request: AssistantAgentRequest, *, trace_id: str | None = None, parent_span_id: str | None = None,
    ) -> AssistantAgentResponse:
        started = perf_counter()
        outcome = "failed"
        state: dict = {}
        usage = AssistantModelUsage()
        trace_id = trace_id or uuid4().hex
        documents = request.saved_program_documents or []
        metadata = {
            "schema_version": SCHEMA_VERSION,
            "document_count": len(documents),
            "document_manifest_sha256": sha256(json.dumps(
                [document.model_dump(mode="json", by_alias=True) for document in documents],
                sort_keys=True, ensure_ascii=False, separators=(",", ":"),
            ).encode()).hexdigest(),
        }
        with self._tracing.observation(
            "assistant.agent", trace_id=trace_id, parent_span_id=parent_span_id, metadata=metadata,
        ) as observation:
            try:
                async with asyncio.timeout(self._timeout_seconds):
                    async for update in self._graph.astream({
                        "request": request, "messages": [], "tool_results": [], "answer_attempts": 0,
                        "model_calls": 0, "input_tokens": 0, "output_tokens": 0,
                    }, config={"callbacks": [usage]}, stream_mode="values"):
                        # 이후 노드가 실패해도 이미 완료된 의도·도구 상태는 남긴다.
                        state = update
                response = state.get("response")
                if not isinstance(response, AssistantAgentResponse):
                    raise AssistantAgentError("graph finished without a response")
                response = AssistantAgentResponse.model_validate(response.model_dump(by_alias=True))
                if not set(response.citations) <= request.help_entry_ids():
                    raise AssistantAgentError("citation outside the help entries")
                outcome = "completed"
                return response
            except (TimeoutError, APITimeoutError) as error:
                outcome = "timeout"
                raise AssistantAgentTimeoutError() from error
            except AssistantAgentError:
                raise
            except asyncio.CancelledError:
                outcome = "cancelled"
                raise
            except (ValidationError, ValueError, Exception) as error:
                raise AssistantAgentError() from error
            finally:
                # 시간·호출 수·토큰만 남긴다. 질문·답·도구 본문은 남기지 않는다.
                results = state.get("tool_results", []) if isinstance(state, dict) else []
                classification = state.get("classification") if isinstance(state, dict) else None
                counts = usage.snapshot()
                self._tracing.update(observation, metadata={
                    "intent": getattr(classification, "intent", None),
                    "model_calls": counts["model_calls"],
                    "usage_input_tokens": counts["input_tokens"],
                    "usage_output_tokens": counts["output_tokens"],
                    "usage_observed_input_tokens": counts["observed_input_tokens"],
                    "usage_observed_output_tokens": counts["observed_output_tokens"],
                    "usage_unknown_calls": counts["usage_unknown_calls"],
                    "usage_complete": counts["usage_unknown_calls"] == 0,
                    "tool_calls": len(results),
                    "tool_failures": sum(not result["ok"] for result in results),
                    "answer_attempts": state.get("answer_attempts", 0),
                })
                logger.info(
                    "assistant_agent_run outcome=%s intent=%s model_calls=%d tool_calls=%d tool_failures=%d "
                    "answer_attempts=%d input_tokens=%s output_tokens=%s observed_input_tokens=%d "
                    "observed_output_tokens=%d usage_unknown_calls=%d elapsed_ms=%d trace_id=%s",
                    outcome, getattr(classification, "intent", None), counts["model_calls"],
                    len(results), sum(1 for result in results if not result["ok"]),
                    state.get("answer_attempts", 0) if isinstance(state, dict) else 0,
                    counts["input_tokens"], counts["output_tokens"], counts["observed_input_tokens"],
                    counts["observed_output_tokens"], counts["usage_unknown_calls"],
                    round((perf_counter() - started) * 1000), trace_id,
                )
