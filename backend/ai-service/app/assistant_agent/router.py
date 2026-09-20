import logging
from time import perf_counter
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.assistant.errors import AssistantAnswerError, AssistantAnswerTimeoutError
from app.assistant_agent.models import AssistantAgentRequest, AssistantAgentResponse
from app.assistant_agent.service import AssistantAgentService


router = APIRouter(prefix="/internal/v1/assistant", tags=["internal"])
logger = logging.getLogger(__name__)


def get_assistant_agent_service(request: Request) -> AssistantAgentService:
    service = request.app.state.container.assistant_agent_service
    if service is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Assistant agent is not configured.")
    return service


@router.post("/agent", response_model=AssistantAgentResponse, summary="도우미 도구 에이전트(의도 분류·도구 호출·답·카드)")
async def answer_with_agent(
    payload: AssistantAgentRequest,
    service: Annotated[AssistantAgentService, Depends(get_assistant_agent_service)],
) -> AssistantAgentResponse:
    started = perf_counter()
    try:
        return await service.answer(payload)
    except AssistantAnswerError as error:
        timed_out = isinstance(error, AssistantAnswerTimeoutError)
        # 실패 종류·예외 이름·시간만 남긴다. 질문·모델 문장·스택은 남기지 않는다.
        logger.warning(
            "assistant_agent_failed failure_kind=%s error_type=%s elapsed_ms=%d",
            "timeout" if timed_out else "execution",
            type(error.__cause__ or error).__name__,
            round((perf_counter() - started) * 1_000),
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT if timed_out else status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Assistant answer timed out." if timed_out else "Assistant answer is temporarily unavailable.",
        ) from error
