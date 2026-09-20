from typing import Annotated
import logging
from time import perf_counter

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.support_program_ranking.errors import AgentExecutionError, AgentFailureCode, AgentTimeoutError
from app.support_program_ranking.models import (
    SupportProgramRankingRequest,
    SupportProgramRankingResponse,
)
from app.support_program_ranking.service import SupportProgramRankingService


router = APIRouter(prefix="/internal/v1", tags=["internal"])
logger = logging.getLogger(__name__)


def get_support_program_ranking_service(
    request: Request,
) -> SupportProgramRankingService:
    return request.app.state.container.support_program_ranking_service


@router.post(
    "/support-program-rankings/rank",
    response_model=SupportProgramRankingResponse,
    summary="지원사업 후보 LLM 점수화",
)
async def rank_support_programs(
    payload: SupportProgramRankingRequest,
    service: Annotated[
        SupportProgramRankingService,
        Depends(get_support_program_ranking_service),
    ],
) -> SupportProgramRankingResponse:
    started = perf_counter()
    try:
        return await service.rank(payload)
    except AgentExecutionError as error:
        timed_out = isinstance(error, AgentTimeoutError)
        reason_code = (
            error.reason_code if isinstance(error.reason_code, AgentFailureCode)
            else AgentFailureCode.EXECUTION_FAILED
        )
        # Allowlisted diagnostics only: no message, candidate text, conditions,
        # provider body, raw exception text, or traceback may enter this record.
        logger.warning(
            "support_program_ranking_failed failure_kind=%s reason_code=%s error_type=%s candidate_count=%d elapsed_ms=%d",
            "timeout" if timed_out else "execution",
            reason_code.value,
            type(error.__cause__ or error).__name__,
            len(payload.candidates),
            round((perf_counter() - started) * 1_000),
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT if timed_out else status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Support program ranking timed out." if timed_out else "Support program ranking is temporarily unavailable.",
        ) from error
