import json
import re
import tiktoken

from app.combination_review.agent import CombinationReviewAgent
from app.combination_review.models import (
    AnalyzeRequest, CONTRACT_VERSION, MAX_CITATION_OPTIONS, build_citation_options, validate_selection,
)
from app.combination_review.prompt import PROMPT_VERSION


class CombinationReviewError(RuntimeError):
    pass


# The model sometimes writes its internal citation marker (private-use brackets around "cite") inside
# user-visible sentences. Evidence is carried only by citations, so the marker text is removed.
_CITATION_MARKUP = re.compile(r"\s*" + chr(0xE200) + "cite" + chr(0xE202) + "[^" + chr(0xE201) + "]*" + chr(0xE201))


def _without_citation_markup(text: str) -> str:
    return _CITATION_MARKUP.sub("", text).strip()


class CombinationReviewService:
    def __init__(self, agent: CombinationReviewAgent, model_name: str):
        self.agent = agent
        self.model_name = model_name

    def configuration(self) -> dict:
        return {"contractVersion": CONTRACT_VERSION, "model": self.model_name, "promptVersion": PROMPT_VERSION}

    async def analyze(self, request: AnalyzeRequest) -> dict:
        try:
            # Reject oversized input rather than dropping definitions, exceptions or appendices.
            # cl100k_base is already bundled by the service image; no runtime tokenizer download.
            if len(tiktoken.get_encoding("cl100k_base").encode(json.dumps(request.model_dump(), ensure_ascii=False), disallowed_special=())) > 100_000:
                raise CombinationReviewError("CONTEXT_TOO_LARGE")
            citation_options = build_citation_options(request)
            if len(citation_options) > MAX_CITATION_OPTIONS:
                raise CombinationReviewError("CONTEXT_TOO_LARGE")
            output = await self.agent.analyze(request)
            validate_selection(request, output, citation_options)
            result = output.model_dump()
            result["summary"] = _without_citation_markup(result["summary"])
            result["limitations"] = [_without_citation_markup(item) for item in result["limitations"]]
            for pair in result["pairs"]:
                for stage in pair["stages"]:
                    for field in ("scope", "explanation"):
                        stage[field] = _without_citation_markup(stage[field])
                    stage["questions"] = [_without_citation_markup(question) for question in stage["questions"]]
                    for citation in stage["citations"]:
                        option = citation_options[citation.pop("citationOptionIndex")]
                        citation["evidenceId"] = request.evidence[option.evidenceIndex].id
                        citation["quote"] = option.quote
            return {**self.configuration(), **result}
        except CombinationReviewError:
            raise
        except TimeoutError as error:
            raise CombinationReviewError("COMBINATION_REVIEW_TIMEOUT") from error
        except Exception as error:
            raise CombinationReviewError("COMBINATION_REVIEW_FAILED") from error
