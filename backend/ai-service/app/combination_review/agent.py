import asyncio
import json

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langsmith import tracing_context
from openai import APITimeoutError
from app.combination_review.models import AnalysisSelection, AnalyzeRequest, build_citation_options
from app.combination_review.prompt import INSTRUCTIONS


class CombinationReviewAgent:
    """Single structured call, no tools, handoffs, retries or rule fallback."""
    def __init__(self, *, model: ChatOpenAI, run_timeout_seconds: float):
        self._run_timeout_seconds = run_timeout_seconds
        schema = AnalysisSelection.model_json_schema()
        # The judgment literals are disjoint: anyOf preserves this union while
        # avoiding the nested oneOf/discriminator unsupported by Responses schemas.
        stages = schema["$defs"]["PairSelection"]["properties"]["stages"]["items"]
        stages["anyOf"] = stages.pop("oneOf")
        stages.pop("discriminator")
        self._structured_model = model.with_structured_output(
            schema, method="json_schema", strict=True, include_raw=True,
        )

    async def analyze(self, request: AnalyzeRequest) -> AnalysisSelection:
        payload = request.model_dump(exclude={"evidence"})
        payload["citationOptions"] = [
            {
                "citationOptionIndex": index,
                "programIndex": request.evidence[option.evidenceIndex].programIndex,
                "locator": request.evidence[option.evidenceIndex].locator,
                "quote": option.quote,
            }
            for index, option in enumerate(build_citation_options(request))
        ]
        try:
            async with asyncio.timeout(self._run_timeout_seconds):
                with tracing_context(enabled=False):
                    result = await self._structured_model.ainvoke([
                        SystemMessage(content=INSTRUCTIONS),
                        HumanMessage(content=json.dumps(payload, ensure_ascii=False)),
                    ])
        except (APITimeoutError, TimeoutError) as error:
            raise TimeoutError("Combination review agent timed out") from error
        if (result["parsing_error"] is not None
                or result["raw"].response_metadata.get("status") != "completed"
                or result["parsed"] is None):
            raise ValueError("invalid combination review output")
        return AnalysisSelection.model_validate(result["parsed"])
