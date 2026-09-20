from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.support_program_index.models import (
    SupportProgramIndexBatchRequest,
    SupportProgramIndexBatchResponse,
    SupportProgramIndexPruneRequest,
    SupportProgramIndexPruneResponse,
    SupportProgramIndexSearchRequest,
    SupportProgramIndexSearchResponse,
)
from app.support_program_index.service import SupportProgramIndexError, SupportProgramIndexService


router = APIRouter(prefix="/internal/v1/support-program-index", tags=["internal"])


def get_support_program_index_service(request: Request) -> SupportProgramIndexService:
    return request.app.state.container.support_program_index_service


@router.put("/batch", response_model=SupportProgramIndexBatchResponse)
async def index_batch(
    payload: SupportProgramIndexBatchRequest,
    service: Annotated[SupportProgramIndexService, Depends(get_support_program_index_service)],
) -> SupportProgramIndexBatchResponse:
    try:
        return await service.index_batch(payload)
    except SupportProgramIndexError as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail={"code": error.code}) from error


@router.post("/prune", response_model=SupportProgramIndexPruneResponse)
async def prune_index(
    payload: SupportProgramIndexPruneRequest,
    service: Annotated[SupportProgramIndexService, Depends(get_support_program_index_service)],
) -> SupportProgramIndexPruneResponse:
    try:
        return await service.prune(payload)
    except SupportProgramIndexError as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail={"code": error.code}) from error


@router.post("/search", response_model=SupportProgramIndexSearchResponse)
async def search_index(
    payload: SupportProgramIndexSearchRequest,
    service: Annotated[SupportProgramIndexService, Depends(get_support_program_index_service)],
) -> SupportProgramIndexSearchResponse:
    try:
        return await service.search(payload)
    except SupportProgramIndexError as error:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT if error.code == "INDEX_TIMEOUT" else status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": error.code},
        ) from error
