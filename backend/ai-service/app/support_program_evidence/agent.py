import asyncio
import logging
from time import perf_counter

from langchain_openai import ChatOpenAI
from openai import OpenAIError

from app.support_program_llm import (
    get_support_program_usage_details,
    invoke_support_program_model,
    validate_support_program_output,
)

from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.support_program_evidence.models import (
    SupportProgramEvidenceAnswerOutput,
    SupportProgramEvidenceAnswerRequest,
    SupportProgramEvidenceAnswerSelection,
)
from app.support_program_evidence.prompt import (
    SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS,
)


logger = logging.getLogger(__name__)


class SupportProgramEvidenceAnswerAgent:
    """한 번의 structured LLM 호출로 상세 공고 근거 답변을 생성한다."""

    def __init__(
        self,
        *,
        model: ChatOpenAI,
        model_timeout_seconds: float,
        run_timeout_seconds: float,
    ) -> None:
        self._run_timeout_seconds = run_timeout_seconds
        self._model_timeout_seconds = model_timeout_seconds
        self._model = model.bind(
            max_tokens=2_000, store=False,
            reasoning={"effort": "none"},
            timeout=model_timeout_seconds,
        )

    async def answer(
        self,
        request: SupportProgramEvidenceAnswerRequest,
    ) -> SupportProgramEvidenceAnswerOutput:
        started_at = perf_counter()
        model_finished_at = None
        usage = None
        outcome = "failed"
        payload = {
            "question": request.question,
            "chunks": [
                {"index": index, **chunk.model_dump(by_alias=True, exclude={"id"})}
                for index, chunk in enumerate(request.chunks)
            ],
        }
        try:
            async with asyncio.timeout(self._run_timeout_seconds):
                result = await invoke_support_program_model(
                    self._model, instructions=SUPPORT_PROGRAM_EVIDENCE_ANSWER_INSTRUCTIONS, payload=payload,
                    output_type=SupportProgramEvidenceAnswerSelection, timeout_seconds=self._model_timeout_seconds,
                )
            model_finished_at = perf_counter()
            usage = result.usage_metadata
            selection = validate_support_program_output(result, SupportProgramEvidenceAnswerSelection)
            if any(index >= len(request.chunks) for index in selection.citation_chunk_indexes):
                raise SupportProgramEvidenceError()
            answer = SupportProgramEvidenceAnswerOutput(
                answer=selection.answer,
                answerStatus=selection.answer_status,
                citationChunkIds=[request.chunks[index].id for index in selection.citation_chunk_indexes],
            )
            outcome = "completed"
            return answer
        except (OpenAIError, ValueError, TimeoutError) as error:
            raise SupportProgramEvidenceError() from error
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        finally:
            finished_at = perf_counter()
            usage_reported = usage is not None
            cached_input_tokens, reasoning_tokens = get_support_program_usage_details(usage)
            logger.info(
                "support_program_evidence_answer_run outcome=%s model_ms=%d validation_ms=%d elapsed_ms=%d "
                "usage_reported=%s input_tokens=%s output_tokens=%s cached_input_tokens=%s reasoning_tokens=%s",
                outcome, round(((model_finished_at or finished_at) - started_at) * 1000),
                round((finished_at - model_finished_at) * 1000) if model_finished_at is not None else 0,
                round((finished_at - started_at) * 1000), usage_reported,
                usage.get("input_tokens") if usage_reported else None,
                usage.get("output_tokens") if usage_reported else None,
                cached_input_tokens,
                reasoning_tokens,
            )
