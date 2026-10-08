import asyncio
import json

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langsmith import tracing_context
from openai import APITimeoutError
from app.combination_review.models import (
    AnalysisSelection, AnalysisSelectionV3, AnalyzeRequest, AnalyzeRequestV3, CONTRACT_VERSION_V3,
    build_citation_options,
)
from app.combination_review.prompt import INSTRUCTIONS, INSTRUCTIONS_V3


def _responses_schema(selection: type[AnalysisSelection | AnalysisSelectionV3], pair: str, items: str) -> dict:
    schema = selection.model_json_schema()
    # The discriminator literals are disjoint: anyOf preserves this union while
    # avoiding the nested oneOf/discriminator unsupported by Responses schemas.
    union = schema["$defs"][pair]["properties"][items]["items"]
    union["anyOf"] = union.pop("oneOf")
    union.pop("discriminator")
    return schema


class CombinationReviewAgent:
    """Single structured call per request (v2 six stages or v3 three questions), no tools, handoffs, retries or rule fallback."""
    def __init__(self, *, model: ChatOpenAI, run_timeout_seconds: float):
        self._run_timeout_seconds = run_timeout_seconds
        self._structured_model = model.with_structured_output(
            _responses_schema(AnalysisSelection, "PairSelection", "stages"),
            method="json_schema", strict=True, include_raw=True,
        )
        self._structured_model_v3 = model.with_structured_output(
            _responses_schema(AnalysisSelectionV3, "PairSelectionV3", "answers"),
            method="json_schema", strict=True, include_raw=True,
        )

    async def analyze(self, request: AnalyzeRequest | AnalyzeRequestV3) -> AnalysisSelection | AnalysisSelectionV3:
        if request.contractVersion == CONTRACT_VERSION_V3:
            structured_model, instructions, selection = self._structured_model_v3, INSTRUCTIONS_V3, AnalysisSelectionV3
        else:
            structured_model, instructions, selection = self._structured_model, INSTRUCTIONS, AnalysisSelection
        payload = request.model_dump(exclude={"evidence"})
        payload["citationOptions"] = [
            {
                "citationOptionIndex": index,
                "programIndex": request.evidence[option.evidenceIndex].programIndex,
                "locator": request.evidence[option.evidenceIndex].locator,
                "heading": option.heading,
                "quote": option.quote,
            }
            for index, option in enumerate(build_citation_options(request))
        ]
        try:
            async with asyncio.timeout(self._run_timeout_seconds):
                with tracing_context(enabled=False):
                    result = await structured_model.ainvoke([
                        SystemMessage(content=instructions),
                        HumanMessage(content=json.dumps(payload, ensure_ascii=False)),
                    ])
        except (APITimeoutError, TimeoutError) as error:
            raise TimeoutError("Combination review agent timed out") from error
        if (result["parsing_error"] is not None
                or result["raw"].response_metadata.get("status") != "completed"
                or result["parsed"] is None):
            raise ValueError("invalid combination review output")
        return selection.model_validate(result["parsed"])
