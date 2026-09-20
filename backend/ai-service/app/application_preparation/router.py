import logging
from time import perf_counter
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.application_preparation.models import DiscoverFormsRequest, FormDiscoveryValidationError, InterpretRequest
from app.application_preparation.service import ApplicationPreparationError, ApplicationPreparationService
from app.application_preparation.models import DraftRequest
from app.application_preparation.document import DocumentRequest

router = APIRouter(prefix="/internal/v1/application-preparations", tags=["internal"])
logger = logging.getLogger(__name__)


def get_service(request: Request) -> ApplicationPreparationService:
    return request.app.state.container.application_preparation_service



@router.get("/document/configuration")
async def document_configuration():
    from app.application_preparation.document_contract import CONTRACT, PIPELINE_VERSION
    return {"contractVersion": CONTRACT, "pipelineVersion": PIPELINE_VERSION}


@router.post("/document/generate")
@router.post("/document/map")
async def generate_document_file(request: Request, service: Annotated[ApplicationPreparationService, Depends(get_service)]):
    import hmac
    import json
    import os
    from pydantic import ValidationError
    from app.application_preparation.document_contract import DocumentError, GenerateDocumentRequest, MapDocumentRequest
    from app.application_preparation.document_pipeline import generate_document, map_document

    token = os.getenv("DOCUMENT_INTERNAL_TOKEN", "")
    if len(token) < 32:
        raise HTTPException(503, detail={"code": "APPLICATION_DOCUMENT_MCP_NOT_READY"})
    if not hmac.compare_digest(request.headers.get("authorization", ""), "Bearer " + token):
        raise HTTPException(401, detail={"code": "UNAUTHORIZED"})
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 80 * 1024 * 1024:
            raise HTTPException(413, detail={"code": "APPLICATION_DOCUMENT_LIMIT_EXCEEDED"})
    try:
        mapping = request.url.path.endswith("/map")
        payload = (MapDocumentRequest if mapping else GenerateDocumentRequest).model_validate(json.loads(body))
        import asyncio
        async with asyncio.timeout(240):
            return await map_document(payload, service.agent) if mapping else await generate_document(payload, service.agent)
    except (ValidationError, ValueError):
        raise HTTPException(422, detail={"code": "APPLICATION_DOCUMENT_VALIDATION_FAILED"}) from None
    except DocumentError as error:
        logger.warning("application_document_rejected mode=%s code=%s reason=%s",
                       "map" if mapping else "generate", error.code, error.reason)
        raise HTTPException(503, detail={"code": error.code}) from None
    except TimeoutError:
        # Mapping is read-only; an expired mapping request cannot leave an unknown file write.
        code = "APPLICATION_DOCUMENT_PLAN_TIMEOUT" if mapping else "APPLICATION_DOCUMENT_OUTCOME_UNKNOWN"
        logger.warning("application_document_rejected mode=%s code=%s reason=REQUEST_DEADLINE",
                       "map" if mapping else "generate", code)
        raise HTTPException(504, detail={"code": code}) from None
    except Exception as error:
        logger.warning("application_document_failed type=%s", type(error).__name__)
        raise HTTPException(503, detail={"code": "APPLICATION_DOCUMENT_VALIDATION_FAILED"}) from None




@router.post("/document")
async def place_document(payload: DocumentRequest, service: Annotated[ApplicationPreparationService, Depends(get_service)]):
    try:
        return await service.place_document(payload)
    except ApplicationPreparationError as error:
        raise HTTPException(status_code=504 if str(error) == "APPLICATION_PREPARATION_TIMEOUT" else 503,
                            detail={"code": str(error)}) from error


@router.get("/draft/configuration")
async def draft_configuration(service: Annotated[ApplicationPreparationService, Depends(get_service)]):
    return service.draft_configuration()


@router.post("/draft")
async def draft(payload: DraftRequest, service: Annotated[ApplicationPreparationService, Depends(get_service)]):
    try:
        return await service.draft(payload)
    except ApplicationPreparationError as error:
        timed_out = str(error) == "APPLICATION_PREPARATION_TIMEOUT"
        logger.warning("application_draft_failed error_type=%s", type(error.__cause__ or error).__name__)
        raise HTTPException(
            status_code=504 if timed_out else 503, detail={"code": str(error)},
        ) from error


@router.get("/configuration")
async def configuration(service: Annotated[ApplicationPreparationService, Depends(get_service)]):
    return service.configuration()


@router.get("/discovery/configuration")
async def discovery_configuration(service: Annotated[ApplicationPreparationService, Depends(get_service)]):
    return service.discovery_configuration()


@router.post("/discovery")
async def discover(payload: DiscoverFormsRequest, service: Annotated[ApplicationPreparationService, Depends(get_service)]):
    try:
        return await service.discover(payload)
    except ApplicationPreparationError as error:
        timed_out = str(error) == "APPLICATION_PREPARATION_TIMEOUT"
        cause = error.__cause__
        validation_failed = isinstance(cause, FormDiscoveryValidationError)
        logger.warning(
            "application_form_discovery_failed failure_kind=%s error_type=%s validation_reason=%s validation_path=%s "
            "code_point_count=%s item_count=%s forbidden_character_count=%s document_count=%d block_count=%d",
            "timeout" if timed_out else "execution",
            type(cause or error).__name__,
            cause.reason if isinstance(cause, FormDiscoveryValidationError) else "NONE",
            cause.path if isinstance(cause, FormDiscoveryValidationError) else "NONE",
            cause.code_point_count if isinstance(cause, FormDiscoveryValidationError) else None,
            cause.item_count if isinstance(cause, FormDiscoveryValidationError) else None,
            cause.forbidden_character_count if isinstance(cause, FormDiscoveryValidationError) else None,
            len(payload.documents),
            sum(len(document.blocks) for document in payload.documents),
        )
        raise HTTPException(
            status_code=(status.HTTP_422_UNPROCESSABLE_CONTENT if validation_failed
                         else status.HTTP_504_GATEWAY_TIMEOUT if timed_out else status.HTTP_503_SERVICE_UNAVAILABLE),
            detail={"code": "APPLICATION_FORM_AI_INVALID_RESPONSE" if validation_failed else str(error),
                    **({"timeoutStage": getattr(cause, "stage", "AI_UNKNOWN")} if timed_out else {})},
        ) from error


@router.post("/interpret")
async def interpret(payload: InterpretRequest, service: Annotated[ApplicationPreparationService, Depends(get_service)]):
    started = perf_counter()
    try:
        return await service.interpret(payload)
    except ApplicationPreparationError as error:
        timed_out = str(error) == "APPLICATION_PREPARATION_TIMEOUT"
        logger.warning(
            "application_preparation_failed failure_kind=%s error_type=%s section_key=%s elapsed_ms=%d",
            "timeout" if timed_out else "execution",
            type(error.__cause__ or error).__name__,
            payload.sectionKey,
            round((perf_counter() - started) * 1_000),
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT if timed_out else status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": str(error)},
        ) from error
