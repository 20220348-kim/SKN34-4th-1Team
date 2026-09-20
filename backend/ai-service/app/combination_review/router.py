import logging
from time import perf_counter
from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException, Request, status
from app.combination_review.models import AnalyzeRequest
from app.combination_review.service import CombinationReviewError, CombinationReviewService

router = APIRouter(prefix="/internal/v1/combination-reviews", tags=["internal"])
logger = logging.getLogger(__name__)

_SAFE_FAILURE_REASONS = {
    "invalid combination review output": "structured_output_type",
    "missing or duplicate pair": "pair_set",
    "invalid limitation": "limitation",
    "out-of-range citation option": "citation_option_range",
    "citation option belongs to another pair": "citation_option_pair",
}


def get_service(request: Request) -> CombinationReviewService:
    return request.app.state.container.combination_review_service


@router.get("/configuration")
async def configuration(service: Annotated[CombinationReviewService, Depends(get_service)]):
    return service.configuration()


@router.post("/analyze")
async def analyze(payload: AnalyzeRequest, service: Annotated[CombinationReviewService, Depends(get_service)]):
    started = perf_counter()
    try:
        return await service.analyze(payload)
    except CombinationReviewError as error:
        code = str(error)
        timed_out = code == "COMBINATION_REVIEW_TIMEOUT"
        logger.warning(
            "combination_review_failed failure_kind=%s failure_reason=%s error_type=%s program_count=%d evidence_count=%d elapsed_ms=%d",
            "timeout" if timed_out else "execution",
            _safe_failure_reason(error),
            type(error.__cause__ or error).__name__,
            len(payload.programs),
            len(payload.evidence),
            round((perf_counter() - started) * 1_000),
        )
        response_status = (
            status.HTTP_422_UNPROCESSABLE_CONTENT if code == "CONTEXT_TOO_LARGE"
            else status.HTTP_504_GATEWAY_TIMEOUT if timed_out
            else status.HTTP_503_SERVICE_UNAVAILABLE
        )
        raise HTTPException(status_code=response_status, detail={"code": code}) from error


def _safe_failure_reason(error: CombinationReviewError) -> str:
    cause = error.__cause__
    if cause is None:
        return "input_limit" if str(error) == "CONTEXT_TOO_LARGE" else "unclassified"
    return _SAFE_FAILURE_REASONS.get(str(cause), "upstream_or_schema")
