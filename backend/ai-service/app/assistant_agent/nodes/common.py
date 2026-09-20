"""노드가 함께 쓰는 모델 호출 보조. 토큰 수만 세고 문장은 남기지 않는다."""

import json
from typing import Any, TypeVar

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from pydantic import BaseModel

from app.assistant_agent.errors import AssistantAgentError
from app.assistant_agent.models import SCHEMA_VERSION, AssistantAgentRequest


OutputT = TypeVar("OutputT", bound=BaseModel)


def usage_update(message: Any) -> dict[str, int]:
    """AIMessage의 usage_metadata에서 토큰 수를 읽는다. 없으면 0이다."""
    usage = getattr(message, "usage_metadata", None) or {}
    return {
        "model_calls": 1,
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
    }


async def structured_call(
    model: BaseChatModel, schema: type[OutputT], messages: list[BaseMessage],
) -> tuple[OutputT | None, dict[str, int]]:
    """구조화 출력 호출. 파싱 실패는 None으로 돌려 호출부가 재시도·강등을 정한다. 전송 오류는 그대로 올린다."""
    runnable = model.with_structured_output(schema, method="json_schema", strict=True, include_raw=True)
    result = await runnable.ainvoke(messages)
    if not isinstance(result, dict):
        raise AssistantAgentError("structured output must include the raw message")
    raw = result.get("raw")
    parsed = result.get("parsed")
    counts = usage_update(raw) if isinstance(raw, AIMessage) else {"model_calls": 1, "input_tokens": 0, "output_tokens": 0}
    if result.get("parsing_error") is not None or not isinstance(parsed, schema):
        return None, counts
    return parsed, counts


def request_payload(request: AssistantAgentRequest, step: str, **extra: Any) -> str:
    """모델에 보내는 사용자 메시지. principal(계정 번호·토큰)은 절대 넣지 않는다."""
    payload: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "step": step,
        "message": request.message,
        "history": [message.model_dump(by_alias=True) for message in request.history],
        "session": request.session.model_dump(by_alias=True),
        "context": request.context.model_dump(by_alias=True),
    }
    payload.update(extra)
    return json.dumps(payload, ensure_ascii=False)
