import logging
from time import perf_counter

from app.application_preparation.agent import ApplicationPreparationAgent
from app.application_preparation.discovery_prompt import DISCOVERY_PROMPT_VERSION
from app.application_preparation.models import (
    CONTRACT_VERSION,
    DISCOVERY_CONTRACT_VERSION,
    DiscoverFormsRequest,
    FormDiscoverySelection,
    InterpretationSelection,
    InterpretRequest,
    validate_discovery,
    validate_selection,
)
from app.application_preparation.prompt import PROMPT_VERSION
from app.application_preparation.draft_prompt import DRAFT_PROMPT_VERSION
from app.application_preparation.models import DraftRequest, validate_draft
from app.application_preparation.document import (
    DocumentRequest,
    DocumentValidationError,
    validate_document,
    validate_example_classification,
    validate_placements,
)

logger = logging.getLogger(__name__)


class ApplicationPreparationError(RuntimeError):
    pass


class ApplicationPreparationService:
    def __init__(self, agent: ApplicationPreparationAgent, model_name: str):
        self.agent = agent
        self.model_name = model_name

    def configuration(self) -> dict:
        return {"contractVersion": CONTRACT_VERSION, "model": self.model_name, "promptVersion": PROMPT_VERSION}

    async def place_document(self, request: DocumentRequest) -> dict:
        started = perf_counter()
        stage = "model"
        try:
            output = await self.agent.place_document(request)
            stage = "validation"
            repair_example_classification: tuple[list[str], list[str]] | None = None
            try:
                validate_placements(request, output)
            except DocumentValidationError as error:
                if error.reason != "SHARED_ANSWER_TARGET":
                    raise
                assignments: dict[str, list[str]] = {}
                for placement in output.placements:
                    assignments.setdefault(placement.targetId, []).append(placement.factId)
                shared_target_ids = {target_id for target_id, fact_ids in assignments.items() if len(fact_ids) > 1}
                shared_fact_ids = {
                    fact_id for target_id in shared_target_ids for fact_id in assignments[target_id]
                }
                kept_shared_fact_ids = {
                    assignments[target_id][0] for target_id in shared_target_ids
                }
                repair_fact_ids = shared_fact_ids - kept_shared_fact_ids
                base_placements = [
                    placement for placement in output.placements if placement.factId not in repair_fact_ids
                ]
                excluded_target_ids = {placement.targetId for placement in base_placements}
                repair_request = request.model_copy(update={
                    "facts": [fact for fact in request.facts if fact.id in repair_fact_ids],
                })
                rejected_repair = output.model_copy(update={
                    "placements": [placement for placement in output.placements if placement.factId in repair_fact_ids],
                    "unmappedFactIds": [],
                })
                stage = "repair-model"
                repaired = await self.agent.place_document(repair_request, excluded_target_ids, rejected_repair)
                stage = "repair-validation"
                validate_placements(repair_request, repaired)
                if any(placement.targetId in excluded_target_ids for placement in repaired.placements):
                    raise DocumentValidationError("REPAIR_EXCLUDED_TARGET")
                try:
                    validate_example_classification(request, repaired)
                    repair_example_classification = (
                        repaired.clearExampleTargetIds,
                        repaired.preserveExampleTargetIds,
                    )
                except DocumentValidationError:
                    pass
                output = output.model_copy(update={
                    "placements": [*base_placements, *repaired.placements],
                    "unmappedFactIds": [*output.unmappedFactIds, *repaired.unmappedFactIds],
                })
            try:
                validate_example_classification(request, output)
                example_classification = (output.clearExampleTargetIds, output.preserveExampleTargetIds)
            except DocumentValidationError:
                if repair_example_classification is not None:
                    example_classification = repair_example_classification
                else:
                    stage = "example-classification-model"
                    classification_request = request.model_copy(update={"facts": []})
                    classification = await self.agent.place_document(classification_request)
                    stage = "example-classification-validation"
                    validate_document(classification_request, classification)
                    example_classification = (
                        classification.clearExampleTargetIds,
                        classification.preserveExampleTargetIds,
                    )
            output = output.model_copy(update={
                "clearExampleTargetIds": example_classification[0],
                "preserveExampleTargetIds": example_classification[1],
            })
            validate_document(request, output)
            return {"contractVersion": "application-document-v1", **output.model_dump()}
        except TimeoutError as error:
            logger.warning("application_document_failed stage=%s error_type=%s elapsed_ms=%d", stage, type(error).__name__, round((perf_counter() - started) * 1000))
            raise ApplicationPreparationError("APPLICATION_PREPARATION_TIMEOUT") from error
        except Exception as error:
            logger.warning(
                "application_document_failed stage=%s error_type=%s reason=%s fact_count=%d target_count=%d elapsed_ms=%d",
                stage, type(error).__name__, error.reason if isinstance(error, DocumentValidationError) else "NONE",
                len(request.facts), len(request.targets), round((perf_counter() - started) * 1000),
            )
            raise ApplicationPreparationError("APPLICATION_PREPARATION_FAILED") from error

    def draft_configuration(self) -> dict:
        return {"contractVersion": "application-preparation-draft-v1", "model": self.model_name, "promptVersion": DRAFT_PROMPT_VERSION}

    async def draft(self, request: DraftRequest) -> dict:
        try:
            output = await self.agent.draft(request)
            validate_draft(request, output)
            labels = {field.fieldKey: field.label for field in request.fieldOptions}
            unknown = [f"{labels[fact.fieldKey]}: 미정" for fact in request.currentFacts if fact.status == "UNKNOWN"]
            content = "\n\n".join([output.content.strip(), *unknown])
            return {
                **self.draft_configuration(), "preparationId": request.preparationId,
                "inputRevision": request.inputRevision, "formVersionId": request.formVersionId,
                "sectionKey": request.sectionKey, "content": content, "usedFieldKeys": output.usedFieldKeys,
            }
        except TimeoutError as error:
            raise ApplicationPreparationError("APPLICATION_PREPARATION_TIMEOUT") from error
        except Exception as error:
            raise ApplicationPreparationError("APPLICATION_PREPARATION_FAILED") from error

    def discovery_configuration(self) -> dict:
        return {
            "modelTimeoutSeconds": self.agent.discovery_model_timeout_seconds,
            "runTimeoutSeconds": self.agent.discovery_run_timeout_seconds,
            "contractVersion": DISCOVERY_CONTRACT_VERSION,
            "model": self.model_name,
            "promptVersion": DISCOVERY_PROMPT_VERSION,
        }

    async def interpret(self, request: InterpretRequest) -> dict:
        try:
            output: InterpretationSelection = await self.agent.interpret(request)
            validate_selection(request, output)
            return {
                **self.configuration(),
                "preparationId": request.preparationId,
                "inputRevision": request.inputRevision,
                "formVersionId": request.formVersionId,
                "sectionKey": request.sectionKey,
                **output.model_dump(),
            }
        except TimeoutError as error:
            raise ApplicationPreparationError("APPLICATION_PREPARATION_TIMEOUT") from error
        except Exception as error:
            raise ApplicationPreparationError("APPLICATION_PREPARATION_FAILED") from error

    async def discover(self, request: DiscoverFormsRequest) -> dict:
        started = perf_counter()
        timeout_stage = "NONE"
        try:
            if any(document.sourceBase64 is not None for document in request.documents):
                import asyncio
                from app.application_preparation.hwpx_form_analysis import discovery_layouts
                async with asyncio.timeout(self.agent.discovery_run_timeout_seconds):
                    layouts = await discovery_layouts(request)
                    output = await self.agent.discover(request, native_layouts=layouts)
            else:
                output = await self.agent.discover(request)
            validate_discovery(request, output)
            return {"contractVersion": DISCOVERY_CONTRACT_VERSION, "model": self.model_name,
                    "promptVersion": DISCOVERY_PROMPT_VERSION, **output.model_dump()}
        except TimeoutError as error:
            timeout_stage = getattr(error, "stage", "AI_UNKNOWN")
            raise ApplicationPreparationError("APPLICATION_PREPARATION_TIMEOUT") from error
        except Exception as error:
            raise ApplicationPreparationError("APPLICATION_PREPARATION_FAILED") from error

        finally:
            logger.info("application_form_discovery sourceCode=%s sourceProgramId=%s durationMs=%d timeoutStage=%s",
                        request.sourceCode, request.sourceProgramId, round((perf_counter() - started) * 1000), timeout_stage)
