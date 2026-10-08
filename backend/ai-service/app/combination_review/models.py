from itertools import combinations
import re
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

STAGES = {"APPLICATION", "SELECTION", "COMMITMENT", "AGREEMENT", "EXECUTION", "FUNDING"}
Stage = Literal["APPLICATION", "SELECTION", "COMMITMENT", "AGREEMENT", "EXECUTION", "FUNDING"]
Judgment = Literal["RESTRICTION_APPLIES", "PERMISSION_IN_SCOPE", "NEEDS_FACTS", "INSUFFICIENT_EVIDENCE", "CONFLICTING_EVIDENCE"]
Answer = Literal["YES", "NO", "UNKNOWN"]
CONTRACT_VERSION = "combination-review-v2"


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Participation(Contract):
    applicationSubmitted: Answer
    selected: Answer
    commitmentSubmitted: Answer
    agreementSigned: Answer
    executionStatus: Literal["UNKNOWN", "NOT_STARTED", "IN_PROGRESS", "COMPLETED", "STOPPED"]
    fundingReceived: Answer


class Program(Contract):
    sourceCode: str = Field(pattern=r"^[A-Z][A-Z0-9_]{0,63}$")
    sourceProgramId: str = Field(min_length=1, max_length=255)
    subProgramId: str | None = Field(max_length=255)
    participation: Participation


class EvidenceBlock(Contract):
    id: str = Field(pattern=r"^E[0-9]{1,4}$")
    programIndex: int = Field(ge=0, le=1)
    documentHash: str = Field(pattern=r"^[0-9a-f]{64}$")
    locator: str = Field(min_length=1, max_length=160)
    text: str = Field(min_length=1, max_length=4000)


class AnalyzeRequest(Contract):
    contractVersion: Literal["combination-review-v2"]
    programs: list[Program] = Field(min_length=2, max_length=2)
    asOfDate: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    additionalFacts: str = Field(max_length=8000)
    evidence: list[EvidenceBlock] = Field(min_length=1, max_length=512)
    coverageWarnings: list[str] = Field(max_length=40)

    @model_validator(mode="after")
    def valid_context(self) -> Self:
        _check_context(self)
        return self


def _check_context(request: "AnalyzeRequest | AnalyzeRequestV3") -> None:
    """Input rules shared by v2 and v3: distinct programs, evidence for every program and the size limits."""
    identities = [(p.sourceCode, p.sourceProgramId, p.subProgramId) for p in request.programs]
    if len(set(identities)) != len(identities):
        raise ValueError("duplicate programs")
    if len({e.id for e in request.evidence}) != len(request.evidence):
        raise ValueError("duplicate evidence")
    if any(e.programIndex >= len(request.programs) for e in request.evidence):
        raise ValueError("invalid program index")
    if {e.programIndex for e in request.evidence} != set(range(len(request.programs))):
        raise ValueError("missing program evidence")
    if sum(len(e.text) for e in request.evidence) > 120_000 or any(len(w) > 500 for w in request.coverageWarnings):
        raise ValueError("context limit exceeded")


MAX_CITATION_OPTIONS = 2048


class CitationSelection(Contract):
    citationOptionIndex: int = Field(ge=0, le=MAX_CITATION_OPTIONS - 1)


class CitationOption(Contract):
    evidenceIndex: int = Field(ge=0, le=511)
    heading: str = Field(max_length=60)
    quote: str = Field(min_length=4, max_length=800)


Question = Annotated[str, Field(min_length=1, max_length=300)]
Limitation = Annotated[str, Field(min_length=1, max_length=500)]


class StageSelectionBase(Contract):
    stage: Stage
    scope: str = Field(min_length=1, max_length=500)
    explanation: str = Field(min_length=1, max_length=1000)
    questions: list[Question] = Field(max_length=5)


class DefinitiveStageSelection(StageSelectionBase):
    judgment: Literal["RESTRICTION_APPLIES", "PERMISSION_IN_SCOPE"]
    requiresInstitutionConfirmation: Literal[False]
    citations: list[CitationSelection] = Field(min_length=1, max_length=8)


class NeedsFactsStageSelection(StageSelectionBase):
    judgment: Literal["NEEDS_FACTS"]
    questions: list[Question] = Field(min_length=1, max_length=5)
    requiresInstitutionConfirmation: bool
    citations: list[CitationSelection] = Field(max_length=8)


class DeferredStageSelection(StageSelectionBase):
    judgment: Literal["INSUFFICIENT_EVIDENCE", "CONFLICTING_EVIDENCE"]
    requiresInstitutionConfirmation: bool
    citations: list[CitationSelection] = Field(max_length=8)


StageSelection = Annotated[
    DefinitiveStageSelection | NeedsFactsStageSelection | DeferredStageSelection,
    Field(discriminator="judgment"),
]


class PairSelection(Contract):
    firstProgramIndex: Literal[0]
    secondProgramIndex: Literal[1]
    stages: list[StageSelection] = Field(min_length=6, max_length=6)

class AnalysisSelection(Contract):
    summary: str = Field(min_length=1, max_length=1200)
    pairs: list[PairSelection] = Field(min_length=1, max_length=1)
    limitations: list[Limitation] = Field(min_length=1, max_length=12)


def build_citation_options(request: "AnalyzeRequest | AnalyzeRequestV3") -> list[CitationOption]:
    return [
        CitationOption(evidenceIndex=evidence_index, heading=heading, quote=quote)
        for evidence_index, evidence in enumerate(request.evidence)
        for heading, quote in _split_exact_quotes(evidence.text)
    ]


def validate_selection(
    request: AnalyzeRequest,
    output: AnalysisSelection,
    citation_options: list[CitationOption],
) -> None:
    expected = set(combinations(range(len(request.programs)), 2))
    actual = [(p.firstProgramIndex, p.secondProgramIndex) for p in output.pairs]
    if len(actual) != len(expected) or set(actual) != expected:
        raise ValueError("missing or duplicate pair")
    if any(not item.strip() or len(item) > 500 for item in output.limitations):
        raise ValueError("invalid limitation")
    for pair in output.pairs:
        if pair.firstProgramIndex >= pair.secondProgramIndex or {stage.stage for stage in pair.stages} != STAGES:
            raise ValueError("invalid pair/stages")
        for stage in pair.stages:
            if any(not question.strip() for question in stage.questions):
                raise ValueError("invalid question")
            _check_citations(request, pair, stage.citations, citation_options)


def _check_citations(
    request: "AnalyzeRequest | AnalyzeRequestV3",
    pair: "PairSelection | PairSelectionV3",
    citations: list[CitationSelection],
    citation_options: list[CitationOption],
) -> None:
    for citation in citations:
        if citation.citationOptionIndex >= len(citation_options):
            raise ValueError("out-of-range citation option")
        selected = request.evidence[citation_options[citation.citationOptionIndex].evidenceIndex]
        if selected.programIndex not in {pair.firstProgramIndex, pair.secondProgramIndex}:
            raise ValueError("citation option belongs to another pair")


# --- combination-review-v3: three questions, five verdicts and optional user facts ---
# v2 above keeps serving Core until its default contract becomes v3; then the v2 analysis path is removed.

CONTRACT_VERSION_V3 = "combination-review-v3"
QUESTIONS = ("APPLY", "CONCURRENT", "SAME_SUBJECT")
ReviewQuestion = Literal["APPLY", "CONCURRENT", "SAME_SUBJECT"]
Moment = Literal["EVALUATION", "SELECTION", "AGREEMENT", "EXECUTION", "SETTLEMENT", "AFTER"]


class ProgramV3(Contract):
    sourceCode: str = Field(pattern=r"^[A-Z][A-Z0-9_]{0,63}$")
    sourceProgramId: str = Field(min_length=1, max_length=255)
    subProgramId: str | None = Field(max_length=255)
    status: Literal["UNKNOWN", "NOT_APPLIED", "APPLIED", "ACTIVE", "FINISHED"]


class Relation(Contract):
    sameProject: Answer
    sameCost: Answer


class AnalyzeRequestV3(Contract):
    contractVersion: Literal["combination-review-v3"]
    programs: list[ProgramV3] = Field(min_length=2, max_length=2)
    relation: Relation
    asOfDate: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    additionalFacts: str = Field(max_length=8000)
    evidence: list[EvidenceBlock] = Field(min_length=1, max_length=512)
    coverageWarnings: list[str] = Field(max_length=40)

    @model_validator(mode="after")
    def valid_context(self) -> Self:
        _check_context(self)
        return self


class ConditionSelection(Contract):
    condition: str = Field(min_length=1, max_length=200)
    result: Literal["ALLOWED", "NOT_ALLOWED"]
    citations: list[CitationSelection] = Field(max_length=8)


class ConsequenceSelection(Contract):
    moment: Moment
    action: str = Field(min_length=1, max_length=200)
    # A consequence is written only from cited penalty text, so it always carries its own citation.
    citations: list[CitationSelection] = Field(min_length=1, max_length=8)


class AnswerSelectionBase(Contract):
    # The model writes the explanation before it commits to a verdict, as v2 writes it before the judgment.
    question: ReviewQuestion
    explanation: str = Field(min_length=1, max_length=600)
    verdict: str
    conditions: list[ConditionSelection] = Field(max_length=0)
    consequences: list[ConsequenceSelection] = Field(max_length=4)
    institutionQuestion: str = Field(max_length=300)
    citations: list[CitationSelection] = Field(max_length=8)


class DefinitiveAnswerSelection(AnswerSelectionBase):
    verdict: Literal["ALLOWED", "NOT_ALLOWED"]
    citations: list[CitationSelection] = Field(min_length=1, max_length=8)


class ConditionalAnswerSelection(AnswerSelectionBase):
    verdict: Literal["CONDITIONAL"]
    conditions: list[ConditionSelection] = Field(min_length=1, max_length=4)


class NoRuleAnswerSelection(AnswerSelectionBase):
    verdict: Literal["NO_RULE"]


class AskInstitutionAnswerSelection(AnswerSelectionBase):
    verdict: Literal["ASK_INSTITUTION"]
    institutionQuestion: str = Field(min_length=1, max_length=300)
    citations: list[CitationSelection] = Field(min_length=1, max_length=8)


AnswerSelection = Annotated[
    DefinitiveAnswerSelection | ConditionalAnswerSelection | NoRuleAnswerSelection | AskInstitutionAnswerSelection,
    Field(discriminator="verdict"),
]


class PairSelectionV3(Contract):
    firstProgramIndex: Literal[0]
    secondProgramIndex: Literal[1]
    answers: list[AnswerSelection] = Field(min_length=3, max_length=3)


class AnalysisSelectionV3(Contract):
    summary: str = Field(min_length=1, max_length=1200)
    pairs: list[PairSelectionV3] = Field(min_length=1, max_length=1)
    limitations: list[Limitation] = Field(min_length=1, max_length=12)


def validate_answers(
    request: AnalyzeRequestV3,
    output: AnalysisSelectionV3,
    citation_options: list[CitationOption],
) -> None:
    """Rules the v3 schema cannot express: pair set, question order, non-blank text, CONDITIONAL citation and citations."""
    expected = set(combinations(range(len(request.programs)), 2))
    actual = [(p.firstProgramIndex, p.secondProgramIndex) for p in output.pairs]
    if len(actual) != len(expected) or set(actual) != expected:
        raise ValueError("missing or duplicate pair")
    if any(not item.strip() for item in output.limitations):
        raise ValueError("invalid limitation")
    if not output.summary.strip():
        raise ValueError("blank answer text")
    for pair in output.pairs:
        if tuple(answer.question for answer in pair.answers) != QUESTIONS:
            raise ValueError("invalid answer order")
        for answer in pair.answers:
            texts = [answer.explanation, *(item.condition for item in answer.conditions),
                     *(item.action for item in answer.consequences)]
            if answer.verdict == "ASK_INSTITUTION":
                texts.append(answer.institutionQuestion)
            if any(not text.strip() for text in texts):
                raise ValueError("blank answer text")
            if answer.verdict == "CONDITIONAL" and not answer.citations and not any(
                item.citations for item in answer.conditions
            ):
                raise ValueError("uncited answer")
            for citations in [answer.citations, *(item.citations for item in answer.conditions),
                              *(item.citations for item in answer.consequences)]:
                _check_citations(request, pair, citations, citation_options)


# A level-1/2 bullet, number or heading starts an item; level-3 bullets (-, ·), notes (※, *) and unmarked lines continue it.
_ITEM_START = re.compile(
    r"[□▢■❏☑◦○〇❍●•⦁∘￭▸▶♣➡↓☞➜⇨]|[①-⑳❶-❿➀-➓㉑-㉟]|[0-9]{1,2}(?:\.(?![0-9])|\))"
    r"|[가나다라마바사아자차카타파하](?:\.(?=\s)|\))|\([0-9]{1,2}\)|[ㅇᄋoOｏ](?=\s)|제\s?[0-9]+\s?[장조]|[Ⅰ-Ⅹ]"
)
_HEADING = re.compile(r"[□▢■❏]|[0-9]{1,2}\.(?![0-9])\s*\S.{0,28}$|[Ⅰ-Ⅹ]|제\s?[0-9]+\s?장")
_SENTENCE_END = re.compile(r"(?:다|함|음|임|됨|요|시오|것)[.)\]」』]?$|[.!?。]$")


def _split_exact_quotes(text: str) -> list[tuple[str, str]]:
    """Split one evidence block into (heading, quote) item units whose quotes are exact substrings covering the text.

    The heading is the nearest heading line seen so far, given to the model as context and never added to the quote.
    It is left empty when the quote already starts with it, so the same line is not sent twice.
    """
    units: list[list] = []  # [start, end, heading] of contiguous raw line ranges
    heading = previous_line = ""
    offset = 0
    for line in text.split("\n"):
        start, end = offset, offset + len(line)
        offset = end + 1
        value = line.strip()
        if not value:
            continue
        if _HEADING.match(value):
            heading = value[:60]
        # Past 400 characters, a new unit starts after a line that ends a sentence.
        if (not units or _ITEM_START.match(value)
                or (end - units[-1][0] > 400 and _SENTENCE_END.search(previous_line))):
            units.append([start, end, heading])
        else:
            units[-1][1] = end
        previous_line = value
    merged: list[list] = []
    for unit in units:
        # A unit under 40 characters joins the next one within 400; one too short to cite on its own always joins.
        previous = merged[-1] if merged else None
        size = len(text[previous[0]:previous[1]].strip()) if previous else 0
        if previous and (size < 4 or (size < 40 and unit[1] - previous[0] <= 400)):
            previous[1] = unit[1]
        else:
            merged.append(unit)
    if len(merged) > 1 and len(text[merged[-1][0]:merged[-1][1]].strip()) < 4:
        last = merged.pop()
        merged[-1][1] = last[1]
    return [
        ("" if quote.startswith(heading) else heading, quote)
        for start, end, heading in merged
        for quote in _split_long_unit(text, start, end)
        if len(quote) >= 4
    ]


def _split_long_unit(text: str, start: int, end: int) -> list[str]:
    """Keep a unit of up to 800 characters whole; cut a longer one at a newline or space without a tail too short to cite."""
    quotes: list[str] = []
    end = start + len(text[start:end].rstrip())
    while start < end:
        while text[start].isspace():
            start += 1
        stop = min(start + 800, end)
        while len(text[start:stop].encode("utf-16-le")) > 1600:  # Core counts 800 UTF-16 code units.
            stop -= 1
        if stop < end:
            limit = end - 4
            while text[limit].isspace():
                limit -= 1
            stop = max(min(stop, limit), start + 1)
            boundary = max(text.rfind("\n", start + 200, stop), text.rfind(" ", start + 200, stop))
            if boundary > start:
                stop = boundary
        quotes.append(text[start:stop].strip())
        start = stop
    return quotes
