from pydantic import ValidationError

from app.support_program_evidence.agent import SupportProgramEvidenceAnswerAgent
from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.support_program_evidence.models import (
    SupportProgramEvidenceAnswerRequest,
    SupportProgramEvidenceAnswerResponse,
)


class SupportProgramEvidenceAnswerService:
    """Agent 인용이 요청한 근거 청크 집합을 벗어나지 않도록 검증한다."""

    def __init__(self, agent: SupportProgramEvidenceAnswerAgent) -> None:
        self._agent = agent

    async def answer(
        self,
        request: SupportProgramEvidenceAnswerRequest,
    ) -> SupportProgramEvidenceAnswerResponse:
        output = await self._agent.answer(request)
        try:
            answer = SupportProgramEvidenceAnswerResponse.model_validate(
                output.model_dump(by_alias=True)
            )
        except ValidationError as error:
            raise SupportProgramEvidenceError() from error
        eligible_chunk_ids = {chunk.id for chunk in request.chunks}
        if not set(answer.citation_chunk_ids).issubset(eligible_chunk_ids):
            raise SupportProgramEvidenceError()
        return answer
