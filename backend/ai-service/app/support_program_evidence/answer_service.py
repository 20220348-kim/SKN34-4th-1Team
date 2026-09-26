from pydantic import ValidationError
from uuid import uuid4

from app.support_program_evidence.agent import SupportProgramEvidenceAnswerAgent
from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.config import LangfuseSettings
from app.support_program_evidence.tracing import EvidenceTracing
from app.support_program_evidence.models import (
    SupportProgramEvidenceAnswerRequest,
    SupportProgramEvidenceAnswerResponse,
)


class SupportProgramEvidenceAnswerService:
    """Agent 인용이 요청한 근거 청크 집합을 벗어나지 않도록 검증한다."""

    def __init__(self, agent: SupportProgramEvidenceAnswerAgent, tracing: EvidenceTracing | None = None) -> None:
        self._agent = agent
        self._tracing = tracing or EvidenceTracing(LangfuseSettings())

    async def answer(
        self,
        request: SupportProgramEvidenceAnswerRequest,
        *,
        trace_id: str | None = None,
    ) -> SupportProgramEvidenceAnswerResponse:
        with self._tracing.observation("evidence.answer", trace_id=trace_id or uuid4().hex) as observation:
            self._tracing.update(observation, metadata={
                "chunk_ids": [chunk.id for chunk in request.chunks], "chunk_count": len(request.chunks),
            })
            answer = await self._answer(request)
            self._tracing.update(observation, metadata={
                "outcome": "completed", "answer_status": answer.answer_status.value,
                "validation_passed": True, "citation_count": len(answer.citation_chunk_ids),
            })
            return answer

    async def _answer(self, request: SupportProgramEvidenceAnswerRequest) -> SupportProgramEvidenceAnswerResponse:
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
