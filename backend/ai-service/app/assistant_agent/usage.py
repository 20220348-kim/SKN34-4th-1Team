"""요청 안의 채팅 모델 호출·관측 토큰만 보존한다. 본문·예외·자격증명은 저장하지 않는다."""

from uuid import UUID

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.outputs import LLMResult


class AssistantModelUsage(AsyncCallbackHandler):
    # 요청마다 한 개를 만들며, 병렬 map도 같은 이벤트 루프에서 대기 없이 집계한다.
    run_inline = True

    def __init__(self) -> None:
        self._calls: dict[UUID, tuple[int | None, int | None]] = {}

    async def on_chat_model_start(self, serialized, messages, *, run_id: UUID, **kwargs) -> None:
        # 전송·응답 여부는 아직 모른다. 오류/취소로 end가 오지 않아도 미확인으로 남는다.
        self._calls.setdefault(run_id, (None, None))

    async def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs) -> None:
        if run_id not in self._calls:
            return
        # 현재 경로는 요청당 한 응답이다. 누락·뜻밖의 응답을 0으로 추정하지 않는다.
        if len(response.generations) != 1 or len(response.generations[0]) != 1:
            return
        message = getattr(response.generations[0][0], "message", None)
        self._record_usage(run_id, getattr(message, "usage_metadata", None))

    async def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs) -> None:
        if run_id not in self._calls:
            return
        # Responses SDK는 스키마 검증 중 실패하면 end 전에 예외를 낸다.
        # LangChain이 첨부한 수신 HTTP 응답에서 숫자만 읽고 원문/예외는 보관하지 않는다.
        response = getattr(error, "response", None)
        if response is None or getattr(response, "status_code", None) != 200:
            return
        try:
            body = response.json()
        except (AttributeError, TypeError, ValueError):
            return
        if isinstance(body, dict) and body.get("object") == "response":
            self._record_usage(run_id, body.get("usage"))

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
