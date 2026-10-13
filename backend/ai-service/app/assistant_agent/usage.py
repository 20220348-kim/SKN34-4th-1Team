"""요청 안의 채팅 모델 호출·관측 토큰만 보존한다. 본문·예외·자격증명은 저장하지 않는다."""

from uuid import UUID

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.outputs import LLMResult

from app.tracing import LLMTracing, error_code


class AssistantModelUsage(AsyncCallbackHandler):
    # 요청마다 한 개를 만들며, 병렬 map도 같은 이벤트 루프에서 대기 없이 집계한다.
    run_inline = True

    def __init__(self, tracing: LLMTracing | None = None) -> None:
        self._calls: dict[UUID, tuple[int | None, int | None]] = {}
        self._tracing = tracing
        self._generations: dict[UUID, object] = {}

    async def on_chat_model_start(self, serialized, messages, *, run_id: UUID, **kwargs) -> None:
        # 전송·응답 여부는 아직 모른다. 오류/취소로 end가 오지 않아도 미확인으로 남는다.
        if run_id in self._calls:
            return
        self._calls[run_id] = (None, None)
        if self._tracing is not None:
            # LangChain이 제공하는 모델 식별자만 사용한다. 메시지·직렬화 객체는 내보내지 않는다.
            metadata = kwargs.get("metadata") or {}
            params = kwargs.get("invocation_params") or {}
            model = metadata.get("ls_model_name") or params.get("model_name") or params.get("model")
            model = model if isinstance(model, str) and model else None
            self._generations[run_id] = self._tracing.start_generation(
                "assistant.model", model=model, metadata={"model_known": model is not None},
            )

    async def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs) -> None:
        if run_id not in self._calls:
            return
        # 현재 경로는 요청당 한 응답이다. 누락·뜻밖의 응답을 0으로 추정하지 않는다.
        if len(response.generations) == 1 and len(response.generations[0]) == 1:
            message = getattr(response.generations[0][0], "message", None)
            self._record_usage(run_id, getattr(message, "usage_metadata", None))
        self._finish_generation(run_id, "completed")

    async def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs) -> None:
        if run_id not in self._calls:
            return
        # Responses SDK는 스키마 검증 중 실패하면 end 전에 예외를 낸다.
        # LangChain이 첨부한 수신 HTTP 응답에서 숫자만 읽고 원문/예외는 보관하지 않는다.
        try:
            response = getattr(error, "response", None)
            if response is not None and getattr(response, "status_code", None) == 200:
                body = response.json()
                if isinstance(body, dict) and body.get("object") == "response":
                    self._record_usage(run_id, body.get("usage"))
        except (AttributeError, TypeError, ValueError):
            pass
        finally:
            self._finish_generation(run_id, error_code(error))

    def _finish_generation(self, run_id: UUID, outcome: str) -> None:
        if self._tracing is None:
            return
        generation = self._generations.pop(run_id, None)
        if generation is None:
            return
        inputs, outputs = self._calls[run_id]
        self._tracing.update(
            generation,
            usage_details={key: value for key, value in (("input", inputs), ("output", outputs)) if value is not None},
            metadata={"usage_reported": inputs is not None and outputs is not None, "outcome": outcome},
            **({"level": "ERROR", "status_message": outcome} if outcome != "completed" else {}),
        )
        self._tracing.end_generation(generation)

    def finish(self, outcome: str) -> None:
        # 취소 등으로 callback 종료가 빠져도 열린 호출을 남기지 않는다. 사용량은 추정하지 않는다.
        for run_id in list(self._generations):
            self._finish_generation(run_id, outcome if outcome != "completed" else "incomplete")

    def _record_usage(self, run_id: UUID, usage: object) -> None:
        if not isinstance(usage, dict):
            return

        def tokens(name: str) -> int | None:
            value = usage.get(name)
            return value if type(value) is int and value >= 0 else None

        self._calls[run_id] = (tokens("input_tokens"), tokens("output_tokens"))

    def snapshot(self) -> dict[str, int | None]:
        inputs = [item[0] for item in self._calls.values()]
        outputs = [item[1] for item in self._calls.values()]
        observed_input = sum(value for value in inputs if value is not None)
        observed_output = sum(value for value in outputs if value is not None)
        return {
            "model_calls": len(self._calls),
            "input_tokens": None if None in inputs else observed_input,
            "output_tokens": None if None in outputs else observed_output,
            "observed_input_tokens": observed_input,
            "observed_output_tokens": observed_output,
            "usage_unknown_calls": sum(1 for item in self._calls.values() if None in item),
        }
