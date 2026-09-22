from pydantic import ValidationError

from app.support_program_conversation.agent import SupportProgramConversationAgent
from app.support_program_conversation.errors import SupportProgramConversationError
from app.support_program_conversation.models import (
    SCHEMA_VERSION, ConversationContext, SupportProgramConversationOutput,
    SupportProgramConversationRequest, SupportProgramConversationResponse,
)


_ANSWERS = {
    "SEARCH_HELP": "지원사업을 찾으실 수 있도록 검색 조건을 정리해 드립니다. 필요한 지원 내용이나 목적을 알려 주세요.",
    "OUT_OF_SCOPE": "이 대화에서는 지원사업 검색과 검색 조건 안내만 도와드릴 수 있습니다. 찾으시는 지원사업이나 필요한 지원 내용을 알려 주세요.",
    "CANCEL_GUIDANCE": "현재 제안을 취소하려면 화면의 취소를 선택해 주세요. 조건을 바꾸려면 변경할 내용을 알려 주세요.",
}
_CLARIFICATION_QUESTIONS = {
    "QUERY": "어떤 지원사업을 찾으시나요? 필요한 지원 내용이나 목적을 알려 주세요.",
    "REGION": "검색할 지역을 하나로 정해 알려 주세요.",
    "INDUSTRY": "검색에 적용할 업종을 알려 주세요.",
    "ESTABLISHMENT": "설립연도 또는 정확한 설립일을 알려 주세요.",
    "SUPPORT_PURPOSE": "원하시는 지원 목적이나 지원 형태를 알려 주세요.",
    "ACCEPTING_ONLY": "접수 중인 공고만 찾을지, 접수 상태와 관계없이 찾을지 알려 주세요.",
    "CHANGE_TARGET": "어떤 검색 조건을 어떻게 바꾸실지 알려 주세요.",
}


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
            # 안내문에 모델·사용자 문자열을 넣지 않는다. 숫자는 검증된 마지막 검색 건수만 사용한다.
            answer = None
            question = None
            if output.status == "ANSWERED":
                if output.answer_kind == "RESULT_SUMMARY":
                    if request.last_search is None:
                        answer = "아직 완료된 검색 결과가 없어 결과를 설명드릴 수 없습니다. 검색을 완료하신 뒤 다시 확인해 주세요."
                    else:
                        count = request.last_search.result_count
                        answer = f"직전에 완료된 검색에서 반환된 공고는 {count}건입니다. "
                        answer += (
                            "현재 정보만으로 결과가 없는 원인을 단정할 수 없습니다. 원하시면 검색어, 지역 또는 접수 상태 조건을 조정해 주세요."
                            if count == 0 else "공고별 상세 내용과 신청 조건은 검색 결과에서 확인해 주세요."
                        )
                else:
                    answer = _ANSWERS[output.answer_kind]
            elif output.status == "CLARIFICATION_REQUIRED":
                question = _CLARIFICATION_QUESTIONS[output.clarification_kind]
            return SupportProgramConversationResponse(
                schemaVersion=SCHEMA_VERSION, status=output.status, updates=output.updates,
                answer=answer, clarificationQuestion=question,
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
