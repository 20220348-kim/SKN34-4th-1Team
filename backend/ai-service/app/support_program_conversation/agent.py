import asyncio
import logging
from time import perf_counter

from langchain_openai import ChatOpenAI
from openai import APITimeoutError, OpenAIError

from app.support_program_llm import (
    get_support_program_usage_details,
    invoke_support_program_model,
    validate_support_program_output,
)

from app.support_program_conversation.errors import (
    SupportProgramConversationError, SupportProgramConversationTimeoutError,
)
from app.support_program_conversation.models import (
    SupportProgramConversationOutput, SupportProgramConversationRequest,
)
from app.support_program_conversation.prompt import SUPPORT_PROGRAM_CONVERSATION_INSTRUCTIONS


logger = logging.getLogger(__name__)


class SupportProgramConversationAgent:
    """한 번의 structured LLM 호출로 조건 변경을 제안하거나 검색 대화에 답한다."""

    def __init__(self, *, model: ChatOpenAI, model_timeout_seconds: float, run_timeout_seconds: float) -> None:
        self._run_timeout_seconds = run_timeout_seconds
        self._model_timeout_seconds = model_timeout_seconds
        self._model = model.bind(
            max_tokens=2_000, store=False,
            reasoning={"effort": "none"},
            timeout=model_timeout_seconds,
        )

    async def interpret(self, request: SupportProgramConversationRequest) -> SupportProgramConversationOutput:
        started_at = perf_counter()
        model_finished_at = None
        usage = None
        outcome = "failed"
        try:
            async with asyncio.timeout(self._run_timeout_seconds):
                result = await invoke_support_program_model(
                    self._model, instructions=SUPPORT_PROGRAM_CONVERSATION_INSTRUCTIONS, payload=request.model_dump(by_alias=True),
                    output_type=SupportProgramConversationOutput, timeout_seconds=self._model_timeout_seconds,
                )
            model_finished_at = perf_counter()
            usage = result.usage_metadata
            output = validate_support_program_output(result, SupportProgramConversationOutput)
            outcome = "completed"
            return output
        except (APITimeoutError, TimeoutError) as error:
            raise SupportProgramConversationTimeoutError() from error
        except (OpenAIError, ValueError) as error:
            raise SupportProgramConversationError() from error
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        finally:
            finished_at = perf_counter()
            usage_reported = usage is not None
            cached_input_tokens, reasoning_tokens = get_support_program_usage_details(usage)
            logger.info(
                "support_program_conversation_run outcome=%s model_ms=%d validation_ms=%d elapsed_ms=%d "
                "usage_reported=%s input_tokens=%s output_tokens=%s cached_input_tokens=%s reasoning_tokens=%s",
                outcome, round(((model_finished_at or finished_at) - started_at) * 1000),
                round((finished_at - model_finished_at) * 1000) if model_finished_at is not None else 0,
                round((finished_at - started_at) * 1000), usage_reported,
                usage.get("input_tokens") if usage_reported else None,
                usage.get("output_tokens") if usage_reported else None,
                cached_input_tokens,
                reasoning_tokens,
            )
