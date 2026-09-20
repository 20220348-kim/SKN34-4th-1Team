import re
import unicodedata
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

CONTRACT_VERSION = "application-preparation-interpret-v1"
DISCOVERY_CONTRACT_VERSION = "application-form-discovery-v1"


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class FieldOption(Contract):
    fieldKey: str = Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")
    label: str = Field(min_length=1, max_length=100)
    guidance: str = Field(min_length=1, max_length=500)
    required: bool


class ConfirmedFact(Contract):
    fieldKey: str = Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")
    status: Literal["PROVIDED", "UNKNOWN"]
    value: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def status_matches_value(self) -> Self:
        if self.status == "PROVIDED" and (self.value is None or not self.value.strip()):
            raise ValueError("provided fact requires a value")
        if self.status == "UNKNOWN" and self.value is not None:
            raise ValueError("unknown fact cannot have a value")
        return self


class InterpretRequest(Contract):
    contractVersion: Literal["application-preparation-interpret-v1"]
    preparationId: int = Field(gt=0)
    inputRevision: int = Field(gt=0)
    formVersionId: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,159}$")
    sectionKey: str = Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")
    serviceField: Literal["GENERAL", "CONSULTING", "TECHNICAL_SUPPORT", "MARKETING"]
    userMessage: str = Field(min_length=1, max_length=4000)
    currentFacts: list[ConfirmedFact] = Field(max_length=20)
    fieldOptions: list[FieldOption] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def unique_allowed_fields(self) -> Self:
        keys = [item.fieldKey for item in self.fieldOptions]
        fact_keys = [item.fieldKey for item in self.currentFacts]
        if len(keys) != len(set(keys)) or len(fact_keys) != len(set(fact_keys)):
            raise ValueError("duplicate field key")
        if not set(fact_keys).issubset(keys):
            raise ValueError("current fact uses an unsupported field")
        return self


class FactSuggestion(Contract):
    fieldKey: str = Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")
    status: Literal["PROVIDED", "UNKNOWN"]
    value: str | None = Field(default=None, max_length=2000)
    evidenceQuote: str = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def status_matches_value(self) -> Self:
        if self.status == "PROVIDED" and (self.value is None or not self.value.strip()):
            raise ValueError("provided suggestion requires a value")
        if self.status == "UNKNOWN" and self.value is not None:
            raise ValueError("unknown suggestion cannot have a value")
        return self


class InterpretationSelection(Contract):
    suggestions: list[FactSuggestion] = Field(max_length=20)
    missingFields: list[str] = Field(max_length=20)
    nextQuestion: str | None = Field(default=None, max_length=300)


class DraftRequest(Contract):
    contractVersion: Literal["application-preparation-draft-v1"]
    preparationId: int = Field(gt=0)
    inputRevision: int = Field(gt=0)
    formVersionId: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,159}$")
    sectionKey: str = Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")
    serviceField: Literal["GENERAL", "CONSULTING", "TECHNICAL_SUPPORT", "MARKETING"]
    sectionTitle: str = Field(min_length=1, max_length=100)
    sectionDescription: str = Field(min_length=1, max_length=1000)
    currentFacts: list[ConfirmedFact] = Field(max_length=20)
    fieldOptions: list[FieldOption] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def confirmed_required_fields(self) -> Self:
        keys = [field.fieldKey for field in self.fieldOptions]
        facts = [fact.fieldKey for fact in self.currentFacts]
        if len(keys) != len(set(keys)) or len(facts) != len(set(facts)) or not set(facts).issubset(keys):
            raise ValueError("invalid draft fact keys")
        if any(field.required and field.fieldKey not in facts for field in self.fieldOptions):
            raise ValueError("required facts must be confirmed")
        return self


class DraftSelection(Contract):
    content: str = Field(min_length=1, max_length=10000)
    usedFieldKeys: list[str] = Field(max_length=20)


def validate_draft(request: DraftRequest, output: DraftSelection) -> None:
    provided = {fact.fieldKey for fact in request.currentFacts if fact.status == "PROVIDED"}
    if set(output.usedFieldKeys) != provided or len(output.usedFieldKeys) != len(provided):
        raise ValueError("draft references must match confirmed provided facts")
    if not output.content.strip() or any(unicodedata.category(char).startswith("C") and char not in "\n\t\r" for char in output.content):
        raise ValueError("invalid draft content")


class DiscoveryBlock(Contract):
    blockId: str = Field(pattern=r"^D[0-7]-B[0-9]{1,3}$")
    locator: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=3000)


class DiscoveryDocument(Contract):
    documentIndex: int = Field(ge=0, le=7)
    fileName: str = Field(min_length=1, max_length=300)
    format: Literal["PDF", "HWP", "HWPX"]
    blocks: list[DiscoveryBlock] = Field(min_length=1, max_length=256)
    sourceBase64: str | None = Field(default=None, min_length=1, max_length=44_739_244)
    sourceSha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def native_source_matches(self) -> Self:
        import base64
        import hashlib
        if (self.sourceBase64 is None) != (self.sourceSha256 is None):
            raise ValueError("source bytes and hash must be supplied together")
        if self.sourceBase64 is not None:
            data = base64.b64decode(self.sourceBase64, validate=True)
            if self.format != "HWPX" or not data.startswith(b"PK") or not 0 < len(data) <= 32 * 1024 * 1024:
                raise ValueError("unsupported native discovery source")
            if hashlib.sha256(data).hexdigest() != self.sourceSha256:
                raise ValueError("discovery source hash mismatch")
        return self


class DiscoverFormsRequest(Contract):
    contractVersion: Literal["application-form-discovery-v1"]
    sourceCode: Literal["BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE"]
    sourceProgramId: str = Field(min_length=1, max_length=255)
    programTitle: str = Field(min_length=1, max_length=300)
    documents: list[DiscoveryDocument] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def unique_documents_and_blocks(self) -> Self:
        if sum(len(document.sourceBase64 or "") for document in self.documents) > 44_739_244:
            raise ValueError("native discovery source total limit")
        if self.sourceCode == "BIZINFO":
            if re.fullmatch(r"PBLN_[0-9]{1,32}", self.sourceProgramId) is None:
                raise ValueError("invalid BIZINFO source program id")
        elif re.fullmatch(r"[1-9][0-9]{0,254}", self.sourceProgramId) is None:
            raise ValueError("invalid numeric source program id")
        indexes = [item.documentIndex for item in self.documents]
        if len(indexes) != len(set(indexes)):
            raise ValueError("duplicate document index")
        for document in self.documents:
            ids = [block.blockId for block in document.blocks]
            if len(ids) != len(set(ids)):
                raise ValueError("duplicate discovery block")
        return self


class DiscoveredFormField(Contract):
    fieldKey: str = Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")
    label: str = Field(min_length=1, max_length=100)
    guidance: str = Field(min_length=1, max_length=500)
    required: bool
    options: list[str] = Field(default_factory=list, max_length=30)
    evidenceBlockId: str = Field(pattern=r"^D[0-7]-B[0-9]{1,3}$")
    evidenceQuote: str = Field(min_length=1, max_length=300)


class DiscoveredFormSection(Contract):
    sectionKey: str = Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")
    title: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=1000)
    fields: list[DiscoveredFormField] = Field(min_length=1, max_length=20)


class DiscoveredForm(Contract):
    documentIndex: int = Field(ge=0, le=7)
    sections: list[DiscoveredFormSection] = Field(min_length=1, max_length=12)


class FormDiscoverySelection(Contract):
    forms: list[DiscoveredForm] = Field(max_length=4)


class FormDiscoveryValidationError(ValueError):
    def __init__(
        self,
        reason: str,
        *,
        path: str = "response",
        code_point_count: int | None = None,
        item_count: int | None = None,
        forbidden_character_count: int | None = None,
    ):
        super().__init__(reason)
        self.reason = reason
        self.path = path
        self.code_point_count = code_point_count
        self.item_count = item_count
        self.forbidden_character_count = forbidden_character_count


def _canonical_display_text(value: str, maximum: int, path: str) -> str:
    normalized = re.sub(r"[ \t\r\n]+", " ", value).strip(" ")
    if not normalized:
        raise FormDiscoveryValidationError("EMPTY_DISPLAY_TEXT", path=path, code_point_count=0)
    forbidden_count = sum(unicodedata.category(character).startswith("C") for character in normalized)
    if forbidden_count:
        raise FormDiscoveryValidationError(
            "FORBIDDEN_DISPLAY_CHARACTER",
            path=path,
            code_point_count=len(normalized),
            forbidden_character_count=forbidden_count,
        )
    if len(normalized) > maximum:
        raise FormDiscoveryValidationError(
            "DISPLAY_TEXT_TOO_LONG",
            path=path,
            code_point_count=len(normalized),
        )
    return normalized


def _source_spans(source: str, proposed: str, *, allow_layout_variants: bool = True) -> list[tuple[int, int]]:
    trimmed = proposed.strip()
    if not trimmed:
        return []

    exact = [match.span() for match in re.finditer(re.escape(trimmed), source)]
    if exact:
        return exact

    parts = re.split(r"\s+", trimmed)
    whitespace_tolerant = [
        match.span() for match in re.finditer(r"\s*".join(re.escape(part) for part in parts), source)
    ]
    if whitespace_tolerant:
        return whitespace_tolerant
    if not allow_layout_variants:
        return []

    # Official forms frequently split labels across table runs or use visually equivalent brackets and bullets.
    # Align only letters and numbers, then return the original source span so downstream evidence stays verbatim.
    source_key: list[str] = []
    source_indexes: list[int] = []
    for index, character in enumerate(source):
        for normalized in unicodedata.normalize("NFKC", character).casefold():
            if normalized.isalnum():
                source_key.append(normalized)
                source_indexes.append(index)
    proposed_key = "".join(
        normalized
        for character in trimmed
        for normalized in unicodedata.normalize("NFKC", character).casefold()
        if normalized.isalnum()
    )
    if len(proposed_key) < 2:
        return []

    joined_source = "".join(source_key)
    spans: list[tuple[int, int]] = []
    offset = 0
    while (found := joined_source.find(proposed_key, offset)) >= 0:
        spans.append((source_indexes[found], source_indexes[found + len(proposed_key) - 1] + 1))
        offset = found + 1
    return list(dict.fromkeys(spans))


def _canonical_source_quote(
    source: str,
    proposed: str,
    *,
    label: str | None = None,
    options: list[str] | None = None,
) -> str | None:
    proposed_spans = [
        span for span in _source_spans(source, proposed, allow_layout_variants=False)
        if span[1] - span[0] <= 300
    ]
    if proposed_spans:
        start, end = min(proposed_spans, key=lambda span: (span[1] - span[0], span[0]))
        return source[start:end]

    if label is not None:
        option_values = options or []
        option_spans = {option: _source_spans(source, option) for option in option_values}
        candidates: list[tuple[int, int]] = []
        for label_start, label_end in _source_spans(source, label):
            start, end = label_start, label_end
            for option in option_values:
                nearby = [
                    span for span in option_spans[option]
                    if max(end, span[1]) - min(start, span[0]) <= 300
                ]
                if not nearby:
                    break
                option_start, option_end = min(
                    nearby,
                    key=lambda span: (max(end, span[1]) - min(start, span[0]), span[0]),
                )
                start, end = min(start, option_start), max(end, option_end)
            else:
                if end - start <= 300:
                    candidates.append((start, end))
        if candidates:
            start, end = min(candidates, key=lambda span: (span[1] - span[0], span[0]))
            return source[start:end]

    relaxed_spans = [span for span in _source_spans(source, proposed) if span[1] - span[0] <= 300]
    if not relaxed_spans:
        return None
    start, end = min(relaxed_spans, key=lambda span: (span[1] - span[0], span[0]))
    return source[start:end]


def _unique_key(key: str, used: set[str]) -> str:
    if key not in used:
        used.add(key)
        return key
    suffix = 2
    while True:
        candidate = f"{key[: 63 - len(str(suffix))]}-{suffix}"
        if candidate not in used:
            used.add(candidate)
            return candidate
        suffix += 1


def validate_discovery(request: DiscoverFormsRequest, output: FormDiscoverySelection) -> None:
    documents = {item.documentIndex: item for item in request.documents}
    merged_forms: dict[int, DiscoveredForm] = {}
    for form_index, form in enumerate(output.forms):
        if form.documentIndex not in documents:
            raise FormDiscoveryValidationError("INVALID_DOCUMENT_INDEX", path=f"forms[{form_index}].documentIndex")
        existing = merged_forms.get(form.documentIndex)
        if existing is None:
            merged_forms[form.documentIndex] = form
        else:
            existing.sections.extend(form.sections)
            if len(existing.sections) > 12:
                raise FormDiscoveryValidationError(
                    "TOO_MANY_MERGED_SECTIONS",
                    path=f"forms[{form_index}].sections",
                    item_count=len(existing.sections),
                )
    output.forms = list(merged_forms.values())
    for form_index, form in enumerate(output.forms):
        section_keys: set[str] = set()
        blocks = {block.blockId: block for block in documents[form.documentIndex].blocks}
        for section_index, section in enumerate(form.sections):
            section_path = f"forms[{form_index}].sections[{section_index}]"
            section.sectionKey = _unique_key(section.sectionKey, section_keys)
            section.title = _canonical_display_text(section.title, 100, f"{section_path}.title")
            section.description = _canonical_display_text(section.description, 1000, f"{section_path}.description")
            field_keys: set[str] = set()
            for field_index, field in enumerate(section.fields):
                field_path = f"{section_path}.fields[{field_index}]"
                field.fieldKey = _unique_key(field.fieldKey, field_keys)
                block = blocks.get(field.evidenceBlockId)
                if block is None:
                    raise FormDiscoveryValidationError("UNKNOWN_EVIDENCE_BLOCK", path=f"{field_path}.evidenceBlockId")
                field.label = _canonical_display_text(field.label, 100, f"{field_path}.label")
                field.guidance = _canonical_display_text(field.guidance, 500, f"{field_path}.guidance")
                canonical_quote = _canonical_source_quote(
                    block.text,
                    field.evidenceQuote,
                    label=field.label,
                    options=field.options,
                )
                if canonical_quote is None:
                    raise FormDiscoveryValidationError(
                        "EVIDENCE_QUOTE_MISMATCH",
                        path=f"{field_path}.evidenceQuote",
                        code_point_count=len(field.evidenceQuote),
                    )
                field.evidenceQuote = canonical_quote
                canonical_options: list[str] = []
                for option in field.options:
                    if not option or len(option) > 100 or option != option.strip():
                        raise FormDiscoveryValidationError("CHOICE_OPTION_NOT_IN_SOURCE", path=f"{field_path}.options")
                    canonical_option = _canonical_source_quote(canonical_quote, option)
                    if canonical_option is None or len(canonical_option) > 100:
                        raise FormDiscoveryValidationError("CHOICE_OPTION_NOT_IN_SOURCE", path=f"{field_path}.options")
                    canonical_options.append(canonical_option)
                if len(canonical_options) != len(set(canonical_options)) or len(canonical_options) == 1:
                    raise FormDiscoveryValidationError("INVALID_CHOICE_OPTIONS", path=f"{field_path}.options")
                field.options = canonical_options


def validate_selection(request: InterpretRequest, output: InterpretationSelection) -> None:
    allowed = {item.fieldKey for item in request.fieldOptions}
    suggestion_keys = [item.fieldKey for item in output.suggestions]
    if len(suggestion_keys) != len(set(suggestion_keys)) or not set(suggestion_keys).issubset(allowed):
        raise ValueError("invalid suggestion fields")
    if len(output.missingFields) != len(set(output.missingFields)) or not set(output.missingFields).issubset(allowed):
        raise ValueError("invalid missing fields")
    for suggestion in output.suggestions:
        if suggestion.evidenceQuote not in request.userMessage:
            raise ValueError("suggestion evidence is not an exact user quote")
    answered = {item.fieldKey for item in request.currentFacts} | set(suggestion_keys)
    expected_missing = [item.fieldKey for item in request.fieldOptions if item.required and item.fieldKey not in answered]
    if output.missingFields != expected_missing:
        raise ValueError("missing fields do not match the confirmed and proposed facts")
    if bool(expected_missing) != bool(output.nextQuestion and output.nextQuestion.strip()):
        raise ValueError("next question does not match missing fields")
