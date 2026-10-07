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
        identities = [(p.sourceCode, p.sourceProgramId, p.subProgramId) for p in self.programs]
        if len(set(identities)) != len(identities):
            raise ValueError("duplicate programs")
        if len({e.id for e in self.evidence}) != len(self.evidence):
            raise ValueError("duplicate evidence")
        if any(e.programIndex >= len(self.programs) for e in self.evidence):
            raise ValueError("invalid program index")
        if {e.programIndex for e in self.evidence} != set(range(len(self.programs))):
            raise ValueError("missing program evidence")
        if sum(len(e.text) for e in self.evidence) > 120_000 or any(len(w) > 500 for w in self.coverageWarnings):
            raise ValueError("context limit exceeded")
        return self


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


def build_citation_options(request: AnalyzeRequest) -> list[CitationOption]:
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
            for citation in stage.citations:
                if citation.citationOptionIndex >= len(citation_options):
                    raise ValueError("out-of-range citation option")
                selected = request.evidence[citation_options[citation.citationOptionIndex].evidenceIndex]
                if selected.programIndex not in {pair.firstProgramIndex, pair.secondProgramIndex}:
                    raise ValueError("citation option belongs to another pair")


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
