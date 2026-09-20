from pydantic import ValidationError

from app.support_program_conversation.agent import SupportProgramConversationAgent
from app.support_program_conversation.errors import SupportProgramConversationError
from app.support_program_conversation.models import (
    SCHEMA_VERSION, ConversationContext, SupportProgramConversationOutput,
    SupportProgramConversationRequest, SupportProgramConversationResponse,
)


class SupportProgramConversationService:
    """변경 근거와 초안 병합 또는 조건을 바꾸지 않는 설명 응답을 검증한다."""

    def __init__(self, agent: SupportProgramConversationAgent) -> None:
        self._agent = agent

    async def interpret(self, request: SupportProgramConversationRequest) -> SupportProgramConversationResponse:
        output = await self._agent.interpret(request)
        try:
            if not isinstance(output, SupportProgramConversationOutput):
                raise SupportProgramConversationError()
            output = SupportProgramConversationOutput.model_validate(output.model_dump(by_alias=True))
            if any(update.evidence not in request.message for update in output.updates):
                raise SupportProgramConversationError()
            merged = self._merge_context(request, output)
            if output.status == "READY" and merged.query is None:
                raise SupportProgramConversationError()
            return SupportProgramConversationResponse(
                schemaVersion=SCHEMA_VERSION, **output.model_dump(by_alias=True),
            )
        except (ValidationError, ValueError) as error:
            raise SupportProgramConversationError() from error

    def _merge_context(
        self, request: SupportProgramConversationRequest, output: SupportProgramConversationOutput,
    ) -> ConversationContext:
        base = (
            request.pending_clarification.draft_context if request.pending_clarification
            else request.pending_proposal if request.pending_proposal is not None
            else request.context
        )
        values = base.model_dump(by_alias=True)
        condition_fields = {
            "REGION": "region", "INDUSTRY": "industry",
            "ESTABLISHED_ON": "establishedOn", "FOUNDED_YEAR": "foundedYear", "SUPPORT_PURPOSE": "supportPurpose",
        }
        for update in output.updates:
            if update.field == "ACCEPTING_ONLY":
                values["acceptingOnly"] = update.operation == "CLEAR" or update.value == "true"
            elif update.field == "QUERY":
                values["query"] = update.value
            else:
                value = int(update.value) if update.field == "FOUNDED_YEAR" and update.value is not None else update.value
                values["companyConditions"][condition_fields[update.field]] = value
                if update.field == "FOUNDED_YEAR":
                    values["companyConditions"]["establishedOn"] = None
                elif update.field == "ESTABLISHED_ON":
                    values["companyConditions"].pop("foundedYear", None)
        merged = ConversationContext.model_validate(values)
        merged.validate_reference_date(request.reference_date)
        return merged
