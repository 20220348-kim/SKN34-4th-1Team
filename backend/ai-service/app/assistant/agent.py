import asyncio
import json
import logging
from time import perf_counter

from agents import (
    Agent, MaxTurnsExceeded, Model, ModelBehaviorError, ModelRefusalError,
    ModelSettings, ModelTimeoutError, RunConfig, Runner,
)
from openai import APITimeoutError, OpenAIError
from openai.types.shared import Reasoning
from pydantic import ValidationError

from app.assistant.errors import AssistantAnswerError, AssistantAnswerTimeoutError
from app.assistant.models import AssistantAnswerOutput, AssistantAnswerRequest
from app.assistant.prompt import ASSISTANT_INSTRUCTIONS


logger = logging.getLogger(__name__)


class AssistantAgent:
    """한 번의 structured LLM 호출로 도우미 자유 질문의 의도를 고르고 그 의도의 필드를 채운다."""

    def __init__(
        self, *, model: Model, model_timeout_seconds: float, run_timeout_seconds: float,
        reasoning_effort: str = "low",
    ) -> None:
        self._run_timeout_seconds = run_timeout_seconds
        self._agent: Agent[None] = Agent(
            name="GovBiz Assistant",
            instructions=ASSISTANT_INSTRUCTIONS,
            model=model,
            output_type=AssistantAnswerOutput,
            model_settings=ModelSettings(
                max_tokens=1_200, reasoning=Reasoning(effort=reasoning_effort), store=False,
                timeout=model_timeout_seconds,
                # Keep the per-request HTTP deadline aligned without mutating the shared client.
                extra_args={"timeout": model_timeout_seconds},
            ),
        )
        self._run_config = RunConfig(
            workflow_name="GovBiz assistant answer",
            tracing_disabled=True, trace_include_sensitive_data=False,
        )

    async def answer(self, request: AssistantAnswerRequest) -> AssistantAnswerOutput:
        started_at = perf_counter()
        model_finished_at = None
        usage = None
        outcome = "failed"
        try:
            async with asyncio.timeout(self._run_timeout_seconds):
                result = await Runner.run(
                    self._agent, json.dumps(request.model_dump(by_alias=True), ensure_ascii=False),
                    max_turns=1, run_config=self._run_config,
                )
            model_finished_at = perf_counter()
            usage = getattr(getattr(result, "context_wrapper", None), "usage", None)
            if not isinstance(result.final_output, AssistantAnswerOutput):
                raise AssistantAnswerError()
            output = AssistantAnswerOutput.model_validate(result.final_output.model_dump(by_alias=True))
            outcome = "completed"
            return output
        except (ModelTimeoutError, APITimeoutError, TimeoutError) as error:
            raise AssistantAnswerTimeoutError() from error
        except (
            MaxTurnsExceeded, ModelBehaviorError, ModelRefusalError,
            OpenAIError, ValidationError,
        ) as error:
            raise AssistantAnswerError() from error
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        finally:
            finished_at = perf_counter()
            usage_reported = usage is not None and bool(usage.request_usage_entries)
            # Only timing, outcome and token counts; never the message, history or answer text.
            logger.info(
                "assistant_answer_run outcome=%s model_ms=%d validation_ms=%d elapsed_ms=%d "
                "usage_reported=%s input_tokens=%s output_tokens=%s cached_input_tokens=%s reasoning_tokens=%s",
                outcome, round(((model_finished_at or finished_at) - started_at) * 1000),
                round((finished_at - model_finished_at) * 1000) if model_finished_at is not None else 0,
                round((finished_at - started_at) * 1000), usage_reported,
                usage.input_tokens if usage_reported else None,
                usage.output_tokens if usage_reported else None,
                usage.input_tokens_details.cached_tokens if usage_reported else None,
                usage.output_tokens_details.reasoning_tokens if usage_reported else None,
            )
