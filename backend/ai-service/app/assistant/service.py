from pydantic import ValidationError

from app.assistant.agent import AssistantAgent
from app.assistant.errors import AssistantAnswerError
from app.assistant.models import (
    SCHEMA_VERSION, AssistantAnswerOutput, AssistantAnswerRequest, AssistantAnswerResponse,
)


class AssistantService:
    """의도별 필드 계약과 인용이 요청의 도움말 항목만 가리키는지 검증한다."""

    def __init__(self, agent: AssistantAgent) -> None:
        self._agent = agent

    async def answer(self, request: AssistantAnswerRequest) -> AssistantAnswerResponse:
        output = await self._agent.answer(request)
        try:
            if not isinstance(output, AssistantAnswerOutput):
                raise AssistantAnswerError()
            output = AssistantAnswerOutput.model_validate(output.model_dump(by_alias=True))
            # A citation the client never sent is a fabricated source, not a help answer.
            if not set(output.citations) <= request.help_entry_ids():
                raise AssistantAnswerError()
            return AssistantAnswerResponse(schemaVersion=SCHEMA_VERSION, **output.model_dump(by_alias=True))
        except (ValidationError, ValueError) as error:
            raise AssistantAnswerError() from error
