import json
import re
import tiktoken

from app.combination_review.agent import CombinationReviewAgent
from app.combination_review.models import (
    AnalysisSelection, AnalysisSelectionV3, AnalyzeRequest, AnalyzeRequestV3, CONTRACT_VERSION, CONTRACT_VERSION_V3,
    CitationOption, MAX_CITATION_OPTIONS, build_citation_options, validate_answers, validate_selection,
)
from app.combination_review.prompt import PROMPT_VERSION, PROMPT_VERSION_V3

_PROMPT_VERSIONS = {CONTRACT_VERSION: PROMPT_VERSION, CONTRACT_VERSION_V3: PROMPT_VERSION_V3}


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

    def configuration(self, contract_version: str = CONTRACT_VERSION) -> dict:
        return {
            "contractVersion": contract_version, "model": self.model_name,
            "promptVersion": _PROMPT_VERSIONS[contract_version],
        }

    async def analyze(self, request: AnalyzeRequest | AnalyzeRequestV3) -> dict:
        try:
            # Reject oversized input rather than dropping definitions, exceptions or appendices.
            # cl100k_base is already bundled by the service image; no runtime tokenizer download.
            if len(tiktoken.get_encoding("cl100k_base").encode(json.dumps(request.model_dump(), ensure_ascii=False), disallowed_special=())) > 100_000:
                raise CombinationReviewError("CONTEXT_TOO_LARGE")
            citation_options = build_citation_options(request)
            if len(citation_options) > MAX_CITATION_OPTIONS:
                raise CombinationReviewError("CONTEXT_TOO_LARGE")
            output = await self.agent.analyze(request)
            if request.contractVersion == CONTRACT_VERSION_V3:
                validate_answers(request, output, citation_options)
                result = _answers_result(request, output, citation_options)
            else:
                validate_selection(request, output, citation_options)
                result = _stages_result(request, output, citation_options)
            return {**self.configuration(request.contractVersion), **result}
        except CombinationReviewError:
            raise
        except TimeoutError as error:
            raise CombinationReviewError("COMBINATION_REVIEW_TIMEOUT") from error
        except Exception as error:
            raise CombinationReviewError("COMBINATION_REVIEW_FAILED") from error


def _restore_citations(citations: list[dict], request: AnalyzeRequest | AnalyzeRequestV3,
                       citation_options: list[CitationOption]) -> None:
    """Replace each selected option index with the evidence ID and exact source quote Core checks."""
    for citation in citations:
        option = citation_options[citation.pop("citationOptionIndex")]
        citation["evidenceId"] = request.evidence[option.evidenceIndex].id
        citation["quote"] = option.quote


def _stages_result(request: AnalyzeRequest, output: AnalysisSelection, citation_options: list[CitationOption]) -> dict:
    result = output.model_dump()
    result["summary"] = _without_citation_markup(result["summary"])
    result["limitations"] = [_without_citation_markup(item) for item in result["limitations"]]
    for pair in result["pairs"]:
        for stage in pair["stages"]:
            for field in ("scope", "explanation"):
                stage[field] = _without_citation_markup(stage[field])
            stage["questions"] = [_without_citation_markup(question) for question in stage["questions"]]
            _restore_citations(stage["citations"], request, citation_options)
    return result


def _answers_result(request: AnalyzeRequestV3, output: AnalysisSelectionV3, citation_options: list[CitationOption]) -> dict:
    result = output.model_dump()
    result["summary"] = _without_citation_markup(result["summary"])
    result["limitations"] = [_without_citation_markup(item) for item in result["limitations"]]
    for pair in result["pairs"]:
        for answer in pair["answers"]:
            for field in ("explanation", "institutionQuestion"):
                answer[field] = _without_citation_markup(answer[field])
            _restore_citations(answer["citations"], request, citation_options)
            for condition in answer["conditions"]:
                condition["condition"] = _without_citation_markup(condition["condition"])
                _restore_citations(condition["citations"], request, citation_options)
            for consequence in answer["consequences"]:
                consequence["action"] = _without_citation_markup(consequence["action"])
                _restore_citations(consequence["citations"], request, citation_options)
    return result
