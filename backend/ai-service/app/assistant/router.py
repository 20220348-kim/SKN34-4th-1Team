from typing import Annotated
import logging
from time import perf_counter

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.assistant.errors import AssistantAnswerError, AssistantAnswerTimeoutError
from app.assistant.models import AssistantAnswerRequest, AssistantAnswerResponse
from app.assistant.service import AssistantService


router = APIRouter(prefix="/internal/v1/assistant", tags=["internal"])
logger = logging.getLogger(__name__)


def get_assistant_service(request: Request) -> AssistantService:
    return request.app.state.container.assistant_service


@router.post("/answers", response_model=AssistantAnswerResponse, summary="도우미 자유 질문 의도 분류와 답변")
async def answer_assistant_message(
    payload: AssistantAnswerRequest,
    service: Annotated[AssistantService, Depends(get_assistant_service)],
) -> AssistantAnswerResponse:
    started = perf_counter()
    try:
        return await service.answer(payload)
    except AssistantAnswerError as error:
        timed_out = isinstance(error, AssistantAnswerTimeoutError)
        # Only failure kind, exception class and elapsed time; never request/model text or a traceback.
        logger.warning(
            "assistant_answer_failed failure_kind=%s error_type=%s elapsed_ms=%d",
            "timeout" if timed_out else "execution",
            type(error.__cause__ or error).__name__,
            round((perf_counter() - started) * 1_000),
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT if timed_out else status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Assistant answer timed out." if timed_out else "Assistant answer is temporarily unavailable.",
        ) from error
