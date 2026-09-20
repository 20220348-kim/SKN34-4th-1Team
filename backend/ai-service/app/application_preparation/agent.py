import asyncio
import json

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langsmith import tracing_context
from openai import APITimeoutError

from app.application_preparation.discovery_prompt import DISCOVERY_INSTRUCTIONS, HWP_DISCOVERY_INSTRUCTIONS
from app.application_preparation.models import (
    DiscoverFormsRequest,
    FormDiscoverySelection,
    InterpretationSelection,
    InterpretRequest,
)
from app.application_preparation.prompt import INSTRUCTIONS
from app.application_preparation.draft_prompt import DRAFT_INSTRUCTIONS
from app.application_preparation.models import DraftRequest, DraftSelection
from app.application_preparation.document import DOCUMENT_INSTRUCTIONS, DocumentRequest, DocumentSelection


class ApplicationFormDiscoveryTimeoutError(TimeoutError):
    def __init__(self, stage: str):
        super().__init__("Application form discovery timed out")
        self.stage = stage


class ApplicationPreparationAgent:
    """Structured application calls with no tools or handoffs."""

    def __init__(self, *, model: ChatOpenAI, run_timeout_seconds: float, discovery_model_timeout_seconds: float = 210.0, discovery_run_timeout_seconds: float = 240.0):
        self._run_timeout_seconds = run_timeout_seconds
        self._model = model
        self.discovery_model_timeout_seconds = discovery_model_timeout_seconds
        self.discovery_run_timeout_seconds = discovery_run_timeout_seconds
        if not 0 < discovery_model_timeout_seconds < discovery_run_timeout_seconds:
            raise ValueError("Discovery model timeout must be less than run timeout")

    async def _invoke(self, selection_type, instructions, content, max_tokens, timeout_message, *, discovery=False, document=False):
        document_budget = discovery or document
        updates = {"max_tokens": max_tokens}
        structured = self._model.model_copy(update=updates).with_structured_output(
            selection_type, method="json_schema", strict=True, include_raw=True,
            **({"timeout": self.discovery_model_timeout_seconds} if document_budget else {}),
        )
        try:
            async with asyncio.timeout(self.discovery_run_timeout_seconds if document_budget else self._run_timeout_seconds):
                with tracing_context(enabled=False):
                    result = await structured.ainvoke(
                        [SystemMessage(content=instructions), HumanMessage(content=content)],
                    )
        except APITimeoutError as error:
            if document:
                from app.application_preparation.document_contract import DocumentError
                raise DocumentError("PLAN_TIMEOUT", reason="AI_MODEL_TIMEOUT") from error
            if discovery:
                raise ApplicationFormDiscoveryTimeoutError("AI_MODEL") from error
            raise TimeoutError(timeout_message) from error
        except TimeoutError as error:
            if document:
                from app.application_preparation.document_contract import DocumentError
                raise DocumentError("PLAN_TIMEOUT", reason="AI_RUN_TIMEOUT") from error
            if discovery:
                raise ApplicationFormDiscoveryTimeoutError("AI_RUN") from error
            raise TimeoutError(timeout_message) from error
        if (result["parsing_error"] is not None
                or result["raw"].response_metadata.get("status") != "completed"
                or not isinstance(result["parsed"], selection_type)):
            raise ValueError("invalid application preparation output")
        return selection_type.model_validate(result["parsed"].model_dump(by_alias=True))

    async def place_document(
        self,
        request: DocumentRequest,
        excluded_target_ids: set[str] | None = None,
        rejected_output: DocumentSelection | None = None,
    ) -> DocumentSelection:
        prompt: dict = request.model_dump(exclude={"pageImages"})
        content = [{"type": "text", "text": json.dumps(prompt, ensure_ascii=False)}]
        if not request.facts:
            classification = {
                "classificationOnly": {
                    "validExampleTargetIds": [target.id for target in request.targets if target.exampleText.strip()],
                    "instruction": (
                        "Return no placements and no unmapped facts. Partition every validExampleTargetId exactly "
                        "once between clearExampleTargetIds and preserveExampleTargetIds. Never add another ID."
                    ),
                },
            }
            content.append({"type": "text", "text": json.dumps(classification, ensure_ascii=False)})
        if excluded_target_ids is not None:
            repair = {
                "repair": {
                    "rejectedSelection": rejected_output.model_dump() if rejected_output is not None else None,
                    "excludedPlacementTargetIds": sorted(excluded_target_ids),
                    "validExampleTargetIds": [target.id for target in request.targets if target.exampleText.strip()],
                    "instruction": (
                        "Return a complete selection for the supplied repair facts. Never place an answer in an "
                        "excludedPlacementTargetId. Use a distinct remaining target for each fact or mark it "
                        "unmapped. Independently partition every validExampleTargetId exactly once between the "
                        "clear and preserve lists, and never add another example ID."
                    ),
                },
            }
            content.append({"type": "text", "text": json.dumps(repair, ensure_ascii=False)})
        content.extend({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{page}", "detail": "high"}} for page in request.pageImages)
        return await self._invoke(
            DocumentSelection, DOCUMENT_INSTRUCTIONS, content, 10000, "Document placement timed out",
        )

    async def draft(self, request: DraftRequest) -> DraftSelection:
        return await self._invoke(
            DraftSelection, DRAFT_INSTRUCTIONS, json.dumps(request.model_dump(), ensure_ascii=False),
            5000, "Application draft agent timed out",
        )

    async def plan_document(self, request, document):
        import re
        from typing import Annotated
        from pydantic import Field, create_model
        from app.application_preparation.document_contract import DocumentError, EditOperation, PlanSelection
        from app.application_preparation.document_pipeline import PLAN_INSTRUCTIONS

        fact_ids = {fact.id for fact in request.facts}
        bindings = [binding.model_dump() for binding in request.bindings if binding.factId in fact_ids]
        planning_document = document.model_dump(exclude={"auxiliaryText"})
        if request.scopeTargetIds:
            allowed = set(request.scopeTargetIds)
            if not allowed <= {target.targetId for target in document.targets}:
                raise DocumentError("MAPPING_FAILED", reason="INVALID_SAVED_SCOPE")
            # Keep the full inspected map for verification; expose only the saved form to planning.
            planning_document["targets"] = [target for target in planning_document["targets"] if target["targetId"] in allowed]
        for target in planning_document["targets"]:
            target["currentTextLength"] = len(target["currentText"])
        ids = [t["targetId"] for t in planning_document["targets"] if t["editable"]]
        if not ids:
            raise DocumentError("MAPPING_FAILED", reason="NO_EDITABLE_TARGETS")
        native_id = Annotated[str, Field(pattern="^(?:" + "|".join(re.escape(key) for key in ids) + ")$")]
        fact_id = Annotated[str, Field(pattern="^(?:" + "|".join(re.escape(key) for key in sorted(fact_ids)) + ")$")]
        operation_type = create_model("BoundEditOperation", __base__=EditOperation,
            targetId=(native_id, ...), valueRef=(fact_id | None, ...),
            **({"box": (type(None), ...)} if all(t["kind"] != "PDF_PAGE" for t in planning_document["targets"]) else {}))
        selection_type = create_model("BoundDocumentPlan", __base__=PlanSelection,
            operations=(list[operation_type], Field(max_length=600)),
            scopeTargetIds=(list[native_id], Field(max_length=3000)),
            unresolvedTargets=(list[fact_id], Field(max_length=200, description="Only IDs of supplied facts that cannot be placed. Never include unprovided consent, signature, date or optional questions, or free-text explanations.")))
        content = [{"type": "text", "text": json.dumps({
            "scope": request.scope, "facts": [f.model_dump() for f in request.facts],
            "bindings": bindings, "scopeTargetIds": request.scopeTargetIds,
            "documentMap": planning_document,
        }, ensure_ascii=False)}]
        content.extend({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{page}", "detail": "high"}} for page in request.pageImages)
        result = await self._invoke(selection_type, PLAN_INSTRUCTIONS, content, 16000, "Document plan timed out", document=True)
        selection = PlanSelection.model_validate(result.model_dump())
        selection.scopeTargetIds = list(dict.fromkeys(selection.scopeTargetIds))
        return selection

    async def map_document(self, request, document, *, rejected_output=None, rejection_reason=None):
        import re
        from typing import Annotated
        from pydantic import Field, create_model
        from app.application_preparation.document import DocumentPlacement, DocumentBox
        from app.application_preparation.document_contract import DocumentError, MappingSelection, mapping_label_matches
        from app.application_preparation.models import Contract
        from app.application_preparation.document_pipeline import MAPPING_INSTRUCTIONS
        # A cell and its paragraphs describe the same text. Offer the leaf
        # addresses only, while retaining read-only labels as visual context.
        parents = {t.nativeLocator.get("parent") for t in document.targets}
        targets = [t for t in document.targets if t.targetId not in parents]
        ids = [t.targetId for t in targets if t.editable and t.kind not in {"PDF_TEXT", "PDF_PAGE"} and t.nativeLocator.get("bindingEligible", True)]
        if not ids:
            raise DocumentError("MAPPING_FAILED", reason="NO_EDITABLE_TARGETS")
        native_id = Annotated[str, Field(pattern="^(?:" + "|".join(re.escape(key) for key in ids) + ")$")]
        scope_ids = [t.targetId for t in targets if t.editable]
        scope_id = Annotated[str, Field(pattern="^(?:" + "|".join(re.escape(key) for key in scope_ids) + ")$")]
        field_candidates = {field.id: [target.targetId for target in targets
            if target.targetId in ids and target.nativeLocator.get("fieldLabels") and mapping_label_matches(field.label, target, field.guidance)]
            for field in request.fields}
        field_ids = [field.id for field in request.fields]
        field_id = Annotated[str, Field(pattern="^(?:" + "|".join(re.escape(key) for key in field_ids) + ")$")]
        binding_type = create_model("NativeMappingBinding", __base__=DocumentPlacement,
            factId=(field_id, ...), targetId=(native_id, ...), box=(type(None), ...))
        selection_type = create_model("NativeMappingSelection", __base__=MappingSelection,
            bindings=(list[binding_type], Field(max_length=600)),
            unmappedFieldIds=(list[field_id], Field(max_length=200,
                description="Each supplied field ID must occur in bindings OR here, never both. No descriptions or target IDs.")),
            scopeTargetIds=(list[scope_id], Field(max_length=3000)))
        if request.format == "hwpx":
            assignment_fields = {}
            value_types = {}
            for index, field in enumerate(request.fields):
                choices = tuple(field_candidates[field.id] or ids)
                if choices not in value_types:
                    choice_id = Annotated[str, Field(pattern="^(?:" + "|".join(re.escape(key) for key in choices) + ")$")]
                    value_types[choices] = create_model(f"FieldTarget{len(value_types)}", __base__=Contract, targetId=(choice_id | None, ...))
                value_type = value_types[choices]
                assignment_fields[f"field_{index}"] = (value_type, Field(alias=field.id))
            assignments_type = create_model("QuestionAssignments", __base__=Contract, **assignment_fields)
            scope_type = create_model("NativeScope", __base__=Contract,
                **{f"target_{index}": (bool, Field(alias=target_id)) for index, target_id in enumerate(scope_ids)})
            selection_type = create_model("HwpxMappingSelection", __base__=Contract,
                assignments=(assignments_type, ...), scope=(scope_type, ...))
        mapping_document = document.model_dump(exclude={"targets", "auxiliaryText"})
        # Core's HWP context contains table/field evidence not repeated in its locator.
        excluded = set() if request.format == "hwp" else {"context"}
        mapping_document["targets"] = [t.model_dump(exclude=excluded, exclude_none=True) for t in targets]
        for target in mapping_document["targets"]:
            locator = target["nativeLocator"]
            if locator.get("geometryVerified") is False:
                # Upstream paragraph estimates are not suitable for locating blank inputs.
                target["nativeLocator"] = {"page": locator["page"], "geometryVerified": False}
        content = [{"type": "text", "text": json.dumps({"scope": request.scope,
            "fields": [f.model_dump() for f in request.fields], "fieldCandidates": field_candidates,
            "documentMap": mapping_document}, ensure_ascii=False)}]
        if rejected_output is not None:
            by_id = {t.targetId: t for t in document.targets}
            overlaps = [{"fieldId": b.factId, "targetId": b.targetId, "printedWords": [
                region for region in by_id[b.targetId].nativeLocator.get("printedTextRegions", [])
                if b.box.overlaps(DocumentBox.model_validate(region["box"]))]}
                for b in rejected_output.bindings if b.box is not None and b.targetId in by_id]
            content.append({"type": "text", "text": json.dumps({"repair": {
                "reason": rejection_reason, "rejectedSelection": rejected_output.model_dump(),
                "labelConflicts": [{"fieldId": binding.factId, "targetId": binding.targetId,
                    "candidateTargetIds": field_candidates.get(binding.factId, [])}
                    for binding in rejected_output.bindings if binding.targetId in by_id and
                    (field_candidates.get(binding.factId) and binding.targetId not in field_candidates[binding.factId]
                     or any(field.id == binding.factId and not mapping_label_matches(field.label, by_id[binding.targetId], field.guidance) for field in request.fields))],
                "printedWordIntersections": overlaps,
                "targetConflicts": [{"targetId": target_id, "fieldIds": [binding.factId for binding in rejected_output.bindings if binding.targetId == target_id]}
                    for target_id in sorted({binding.targetId for binding in rejected_output.bindings})
                    if len([binding for binding in rejected_output.bindings if binding.targetId == target_id]) > 1],
                "instruction": "Correct the complete mapping once using only supplied field IDs and native input targets. Every field ID must be bound OR unmapped, never both; omit no fields. Match table/row/column evidence and Hangeul formFields/labelSearch to each question. Ambiguous label searches require table context. Never use a table's first column for a whole-table question, invent coordinates or targets, or cover printed words."
            }}, ensure_ascii=False)})
        content.extend({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{page}", "detail": "high"}} for page in request.pageImages)
        output_instructions = ("\nReturn assignments keyed by every supplied question ID. Each property's targetId is ONE native input ID; use null only when unbound. Each question addresses one input slot; never copy its value into several repeated rows. Never assign a physical target to two different questions. In scope, mark each supplied target ID true only if it belongs to the selected form, including its examples; otherwise false. This keyed object replaces scopeTargetIds and cannot repeat a target. The rejectedSelection, if present, is diagnostic data in normalized server format; return the assignments and scope schema instead."
                               if request.format == "hwpx" else "\nReturn bindings with factId equal to the supplied question ID, and list only unbound question IDs in unmappedFieldIds.")
        result = await self._invoke(selection_type, MAPPING_INSTRUCTIONS + output_instructions, content, 16000, "Document mapping timed out", document=True)
        if request.format == "hwpx":
            assignments = result.model_dump(by_alias=True)["assignments"]
            selection = MappingSelection(bindings=[DocumentPlacement(factId=field_id, targetId=target_id, box=None)
                for field_id, assignment in assignments.items() if (target_id := assignment["targetId"]) is not None],
                unmappedFieldIds=[field_id for field_id, assignment in assignments.items() if assignment["targetId"] is None],
                scopeTargetIds=[target_id for target_id, included in result.model_dump(by_alias=True)["scope"].items() if included])
        else:
            selection = MappingSelection.model_validate(result.model_dump())
        # Scope has set semantics; repeated identical IDs do not expand it.
        selection.scopeTargetIds = list(dict.fromkeys(selection.scopeTargetIds))
        selection.unmappedFieldIds = list(dict.fromkeys(selection.unmappedFieldIds))
        return selection

    async def interpret(self, request: InterpretRequest) -> InterpretationSelection:
        return await self._invoke(
            InterpretationSelection, INSTRUCTIONS, json.dumps(request.model_dump(), ensure_ascii=False),
            2500, "Application preparation agent timed out",
        )

    async def discover(self, request: DiscoverFormsRequest, *, native_layouts=None) -> FormDiscoverySelection:
        hwp_only = all(document.format == "HWP" for document in request.documents)
        content = request.model_dump(exclude={"documents": {"__all__": {"sourceBase64", "sourceSha256"}}})
        for document in content["documents"]:
            if native_layouts and document["documentIndex"] in native_layouts:
                document["nativeLayout"] = native_layouts[document["documentIndex"]]
        return await self._invoke(
            FormDiscoverySelection, HWP_DISCOVERY_INSTRUCTIONS if hwp_only else DISCOVERY_INSTRUCTIONS,
            json.dumps(content, ensure_ascii=False),
            5000 if hwp_only else 16000, "Application form discovery agent timed out", discovery=True,
        )
