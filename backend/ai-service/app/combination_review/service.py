import json
import tiktoken

from app.combination_review.agent import CombinationReviewAgent
from app.combination_review.models import AnalyzeRequest, CONTRACT_VERSION, build_citation_options, validate_selection
from app.combination_review.prompt import PROMPT_VERSION


class CombinationReviewError(RuntimeError):
    pass


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
            output = await self.agent.analyze(request)
            validate_selection(request, output, citation_options)
            result = output.model_dump()
            for pair in result["pairs"]:
                for stage in pair["stages"]:
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
