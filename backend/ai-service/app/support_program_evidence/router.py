from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.support_program_evidence.answer_service import (
    SupportProgramEvidenceAnswerService,
)
from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.support_program_evidence.models import (
    SupportProgramEvidenceAnswerRequest,
    SupportProgramEvidenceAnswerResponse,
    SupportProgramEvidenceBatchRequest,
    SupportProgramEvidenceBatchResponse,
    SupportProgramEvidenceSearchRequest,
    SupportProgramEvidenceSearchResponse,
)
from app.support_program_evidence.service import SupportProgramEvidenceService
from app.tracing import remote_parent


router = APIRouter(prefix="/internal/v1/support-program-evidence", tags=["internal"])


def get_support_program_evidence_service(request: Request) -> SupportProgramEvidenceService:
    service = request.app.state.container.support_program_evidence_service
    if service is None:
        raise RuntimeError("support program evidence service is not configured")
    return service


def get_support_program_evidence_answer_service(
    request: Request,
) -> SupportProgramEvidenceAnswerService:
    service = request.app.state.container.support_program_evidence_answer_service
    if service is None:
        raise RuntimeError("support program evidence answer service is not configured")
    return service


@router.put("/chunks", response_model=SupportProgramEvidenceBatchResponse)
async def index_chunks(
    payload: SupportProgramEvidenceBatchRequest,
    request: Request,
    service: Annotated[
        SupportProgramEvidenceService,
        Depends(get_support_program_evidence_service),
    ],
) -> SupportProgramEvidenceBatchResponse:
    try:
        return await service.index_chunks(payload, **remote_parent(request.headers.get("traceparent")))
    except SupportProgramEvidenceError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": error.code},
        ) from error


@router.post("/search", response_model=SupportProgramEvidenceSearchResponse)
async def search_evidence(
    payload: SupportProgramEvidenceSearchRequest,
    request: Request,
    service: Annotated[
        SupportProgramEvidenceService,
        Depends(get_support_program_evidence_service),
    ],
) -> SupportProgramEvidenceSearchResponse:
    try:
        return await service.search(payload, **remote_parent(request.headers.get("traceparent")))
    except SupportProgramEvidenceError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": error.code},
        ) from error


@router.post("/answers", response_model=SupportProgramEvidenceAnswerResponse)
async def answer_with_evidence(
    payload: SupportProgramEvidenceAnswerRequest,
    request: Request,
    service: Annotated[
        SupportProgramEvidenceAnswerService,
        Depends(get_support_program_evidence_answer_service),
    ],
) -> SupportProgramEvidenceAnswerResponse:
    try:
        return await service.answer(payload, **remote_parent(request.headers.get("traceparent")))
    except SupportProgramEvidenceError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": error.code},
        ) from error
