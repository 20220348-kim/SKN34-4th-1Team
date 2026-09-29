"""검색·근거 답변이 공유하는 본문 없는 Langfuse 기록과 전송 장애 경계."""

import asyncio
import logging
import re
from contextlib import contextmanager
from hashlib import sha256
from threading import Thread

from httpx import TimeoutException
from langfuse import Langfuse
from langfuse.types import MaskOtelSpansResult, OtelSpanPatch
from openai import APITimeoutError
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import get_current_span

from app.config import LangfuseSettings
from app.support_program_evidence.prompt import (
    SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS,
)

logger = logging.getLogger(__name__)
PROMPT_HASH = sha256(SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS.encode()).hexdigest()
SPAN_NAMES = {
    "assistant.agent",
    "assistant.classify",
    "assistant.resume",
    "assistant.plan",
    "assistant.tools",
    "assistant.tool",
    "assistant.answer",
    "assistant.verify",
    "assistant.finalize",
    "assistant.saved_programs",
    "assistant.saved.retrieve",
    "assistant.saved.map",
    "assistant.saved.judge",
    "assistant.saved.reduce",
    "assistant.saved.verify",
    "evidence.answer",
    "evidence.model",
    "search.semantic.request",
    "search.semantic",
    "search.embedding",
    "search.vector",
    "search.ranking.request",
    "search.ranking",
    "search.ranking.model",
    "search.selection",
}


def remote_parent(value: str | None) -> dict:
    """내부 HTTP에서 W3C v00 ID만 수용한다. baggage·본문·임의 속성은 전파하지 않는다."""
    match = re.fullmatch(r"00-([0-9a-f]{32})-([0-9a-f]{16})-01", value or "")
    if not match or int(match[1], 16) == 0 or int(match[2], 16) == 0:
        return {}
    return {"trace_id": match[1], "parent_span_id": match[2]}


def mask_spans(*, params):
    # 명시적으로 허용한 span도 본문 속성을 제거한다. 예외 이벤트는 처음부터 만들지 않는다.
    return MaskOtelSpansResult(
        span_patches={
            identifier: OtelSpanPatch(
                delete_attributes=[
                    key
                    for key in span.attributes
                    if "input" in key
                    and "usage" not in key
                    or "output" in key
                    and "usage" not in key
                    or key.startswith("exception.")
                ]
            )
            for identifier, span in params.spans.items()
        }
    )


def error_code(error: BaseException) -> str:
    if isinstance(error, asyncio.CancelledError):
        return "cancelled"
    cause = error
    while cause is not None:
        if isinstance(cause, (TimeoutError, APITimeoutError, TimeoutException)):
            return "timeout"
        cause = cause.__cause__
    return "failed"


class LLMTracing:
    def __init__(self, settings: LangfuseSettings) -> None:
        self.client = None
        self.provider = None
        self._closed = False
        if settings.enabled:
            self.provider = TracerProvider(shutdown_on_exit=False)
            self.client = Langfuse(
                public_key=settings.public_key,
                secret_key=settings.secret_key,
                base_url=settings.base_url,
                environment=settings.environment,
                release=settings.release,
                tracer_provider=self.provider,
                timeout=2,
                flush_at=32,
                flush_interval=1,
                should_export_span=lambda span: span.name in SPAN_NAMES,
                mask_otel_spans=mask_spans,
            )

    @contextmanager
    def observation(
        self,
        name: str,
        *,
        trace_id: str | None = None,
        parent_span_id: str | None = None,
        metadata: dict | None = None,
        **kwargs,
    ):
        if self.client is None or self._closed:
            yield None
            return
        try:
            context = {"trace_id": trace_id} if trace_id else None
            if context is not None and parent_span_id is not None:
                context["parent_span_id"] = parent_span_id
            manager = self.client.start_as_current_observation(
                name=name,
                trace_context=context,
                metadata=({"prompt_sha256": PROMPT_HASH} if name.startswith("evidence.") else {})
                | (metadata or {}),
                **kwargs,
            )
            observation = manager.__enter__()
            if name.startswith("search."):
                get_current_span().set_attribute("langfuse.trace.name", "support-program-search")
            elif name.startswith("assistant."):
                get_current_span().set_attribute("langfuse.trace.name", "assistant-agent")
        except Exception:
            logger.error("evidence_trace_start_failed")
            yield None
            return
        try:
            yield observation
        except BaseException as error:
            self.update(
                observation,
                level="ERROR",
                status_message=error_code(error),
                metadata={"outcome": error_code(error)},
            )
            raise
        else:
            self.update(observation, metadata={"outcome": "completed"})
        finally:
            # 실제 업무 예외를 SDK context manager에 넘기면 메시지·스택이 자동 수집될 수 있다.
            try:
                manager.__exit__(None, None, None)
            except Exception:
                logger.error("evidence_trace_end_failed")

    def update(self, observation, **kwargs) -> None:
        if observation is not None:
            try:
                observation.update(**kwargs)
            except Exception:
                logger.error("evidence_trace_update_failed")

    async def close(self) -> None:
        if self.client is None or self._closed:
            return
        self._closed = True

        # SDK 종료가 응답 서버 종료를 무기한 붙잡지 않도록 daemon에서 유한 시간 기다린다.
        def shutdown():
            try:
                self.client.shutdown()
            except Exception:
                logger.error("evidence_trace_shutdown_failed")
            finally:
                self.provider.shutdown()

        worker = Thread(target=shutdown, name="evidence-trace-shutdown", daemon=True)
        worker.start()
        await asyncio.to_thread(worker.join, 5)
        if worker.is_alive():
            logger.error("evidence_trace_shutdown_timeout")
