from typing import Annotated
import logging
from time import perf_counter

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.support_program_conversation.errors import (
    SupportProgramConversationError, SupportProgramConversationTimeoutError,
)
from app.support_program_conversation.models import SupportProgramConversationRequest, SupportProgramConversationResponse
from app.support_program_conversation.service import SupportProgramConversationService


router = APIRouter(prefix="/internal/v1/support-program-conversation", tags=["internal"])
logger = logging.getLogger(__name__)


def get_support_program_conversation_service(request: Request) -> SupportProgramConversationService:
    return request.app.state.container.support_program_conversation_service


@router.post("/interpret", response_model=SupportProgramConversationResponse, summary="확인 전 검색 조건 변경 해석")
async def interpret_support_program_conversation(
    payload: SupportProgramConversationRequest,
    service: Annotated[SupportProgramConversationService, Depends(get_support_program_conversation_service)],
) -> SupportProgramConversationResponse:
    started = perf_counter()
    try:
        return await service.interpret(payload)
    except SupportProgramConversationError as error:
        timed_out = isinstance(error, SupportProgramConversationTimeoutError)
        # Only failure kind, exception class and elapsed time; never request/model text or a traceback.
        logger.warning(
            "support_program_conversation_failed failure_kind=%s error_type=%s elapsed_ms=%d",
            "timeout" if timed_out else "execution",
            type(error.__cause__ or error).__name__,
            round((perf_counter() - started) * 1_000),
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT if timed_out else status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Support program conversation interpretation timed out." if timed_out
            else "Support program conversation interpretation is temporarily unavailable.",
        ) from error
