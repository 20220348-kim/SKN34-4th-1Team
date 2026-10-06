"""Versioned document map and server-bound write plan. No executable model output."""
import base64
import hashlib
import json
import logging
import re
import unicodedata
from typing import Literal

from pydantic import Field, model_validator

from app.application_preparation.answer_slots import answer_slots
from app.application_preparation.models import Contract
from app.application_preparation.document import DocumentBox, DocumentFact, DocumentTarget, DocumentPlacement

logger = logging.getLogger(__name__)

CONTRACT = "application-document-mcp-v1"
MAP_VERSION = "native-map-v16-pdf-reading-order-choice-lines"
PLAN_VERSION = "confirmed-facts-bound-v8-printed-slots-example-cleanup"
ENGINES = {
    "hwp": "kr.dogfoot/hwplib@1.1.11+govbiz-ranges-v1",
    "hwpx": "pblsketch/Hangeul-mcp@b6fef153714e0cc9ce566df0da4082fc57c4fda4+govbiz-ranges-v4-body-positions+answer-style-v1+python-hwpx@6.6.0-fit",
    "pdf": "AryanBV/pdf-edit-mcp@d4527e62b59433ad02f31a0511db218a2eeec1d3+govbiz-deletion-proof-v4+FFDetr@56f4e4235e28dcb2953513dc020bb191a2f54cfe+pdfbox-v6",
    "docx": "govbiz/ooxml-native@2",
    "xlsx": "govbiz/xlsx-native@2+openpyxl-3.1.5",
}
KORDOC_VERSION = "chrisryugj/kordoc@f715573df1712d415604ac949603a00e387cd3d7+pdfjs-dist@4.10.38"
PIPELINE_VERSION = hashlib.sha256(json.dumps([CONTRACT, MAP_VERSION, PLAN_VERSION,
    {key: value for key, value in ENGINES.items() if key not in {"docx", "xlsx"}}, KORDOC_VERSION], sort_keys=True).encode()).hexdigest()
MAX_BYTES = 32 * 1024 * 1024


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def object_hash(value: object) -> str:
    return digest(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())


class DocumentError(RuntimeError):
    def __init__(self, code: str, *, reason: str = "UNSPECIFIED"):
        self.code = "APPLICATION_DOCUMENT_" + code
        self.reason = reason
        super().__init__(self.code)


class NativeTargetAnalysis(Contract):
    """Read-only semantic hints. None of these values is a native edit address."""

    nativeOrderIndex: int | None = Field(default=None, ge=0)
    semanticOrderIndex: int | None = Field(default=None, ge=0)
    # Compatibility alias for semanticOrderIndex.
    readingOrderIndex: int | None = Field(default=None, ge=0)
    readingOrderConfidence: float | None = Field(default=None, ge=0, le=1)
    readingOrderStatus: Literal["PRESERVED", "LOCAL_REORDERED", "REVIEW_REQUIRED", "UNRESOLVED"] = "UNRESOLVED"
    readingOrderReason: list[str] = Field(default_factory=list, max_length=20)
    semanticSection: str | None = Field(default=None, max_length=1000)
    headingConfidence: float | None = Field(default=None, ge=0, le=1)
    headingStatus: Literal["ACCEPTED", "REVIEW_REQUIRED", "PRESERVED"] = "PRESERVED"
    headingReason: list[str] = Field(default_factory=list, max_length=20)
    sectionPath: list[str] = Field(default_factory=list, max_length=20)
    tableClassification: Literal["FORM_TABLE", "DATA_TABLE", "LAYOUT_TABLE", "DECORATIVE_TABLE", "AMBIGUOUS"] | None = None
    tableClassificationConfidence: float | None = Field(default=None, ge=0, le=1)
    tableClassificationEvidence: list[str] = Field(default_factory=list, max_length=20)
    reviewRequired: bool = False


class DocumentAnalysisStage(Contract):
    status: Literal["APPLIED", "SKIPPED", "REVIEW_REQUIRED", "PASSED", "PENDING_EXTERNAL"] = "SKIPPED"
    targetCount: int = Field(default=0, ge=0)
    resultCount: int = Field(default=0, ge=0)
    reviewCount: int = Field(default=0, ge=0)
    nativeTargetsChanged: Literal[False] = False
    note: str = Field(default="", max_length=200)
    metrics: dict[str, int] = Field(default_factory=dict)


class DocumentAnalysisMetadata(Contract):
    readingOrder: DocumentAnalysisStage = Field(default_factory=DocumentAnalysisStage)
    heading: DocumentAnalysisStage = Field(default_factory=DocumentAnalysisStage)
    tableClassification: DocumentAnalysisStage = Field(default_factory=DocumentAnalysisStage)
    mapping: DocumentAnalysisStage = Field(default_factory=DocumentAnalysisStage)
    verification: DocumentAnalysisStage = Field(default_factory=DocumentAnalysisStage)


class NativeTarget(Contract):
    targetId: str = Field(min_length=1, max_length=500)
    nativeLocator: dict
    kind: str
    label: str = ""
    currentText: str = Field(max_length=6000)
    context: str = Field(default="", max_length=1000)
    editable: bool = True
    unsupportedReason: str | None = None
    analysis: NativeTargetAnalysis = Field(default_factory=NativeTargetAnalysis)


DOCUMENT_TARGET_LIMIT = 3000


class DocumentMap(Contract):
    contractVersion: Literal["application-document-mcp-v1"] = CONTRACT
    sourceSha256: str
    format: Literal["hwp", "hwpx", "pdf", "docx", "xlsx"]
    engineVersion: str
    mapVersion: str = MAP_VERSION
    targets: list[NativeTarget] = Field(max_length=DOCUMENT_TARGET_LIMIT)
    workbookMetadata: dict = Field(default_factory=dict)
    auxiliaryStatus: str = "SKIPPED_PRIMARY_SUFFICIENT"
    auxiliaryText: str = Field(default="", max_length=40000)
    unmappedFieldIds: list[str] = Field(default_factory=list, max_length=200)
    # 자동으로 넣지 못한 문항별 이유입니다(예: MAPPING_TARGET_OVERLAP). 사람이 원본에서 직접 작성할 문항을 설명합니다.
    unmappedReasons: dict[str, str] = Field(default_factory=dict)
    documentAnalysis: DocumentAnalysisMetadata = Field(default_factory=DocumentAnalysisMetadata)


class EditOperation(Contract):
    targetId: str
    operation: Literal["input", "replace_range", "delete_range", "set_field", "set_check"]
    expectedText: str
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    valueRef: str | None
    box: DocumentBox | None
    reason: str = Field(min_length=1, max_length=1000)
    stylePolicy: Literal["preserve"] = "preserve"
    # The exact text written when it differs from the answer: spacing around a printed blank, a choice mark
    # (■, √, ○) or one part of a split date. Only the server's slot rules set it, and validate_plan re-derives it.
    literal: str | None = Field(default=None, max_length=2100)


class PlanSelection(Contract):
    operations: list[EditOperation] = Field(max_length=600)
    unresolvedTargets: list[str] = Field(max_length=3000)
    scopeTargetIds: list[str] = Field(max_length=3000)


class SkippedFact(Contract):
    """A supplied answer deliberately left out of the document; the rest is still written and Core lists this one."""

    factId: str
    targetId: str = ""
    reason: Literal["OVERFLOW", "AMBIGUOUS_SLOT", "SLOT_MISMATCH", "UNRESOLVED"]
    capacity: int | None = Field(default=None, ge=0)


class WritePlan(PlanSelection):
    sourceSha256: str
    mapVersion: str
    answerRevision: int
    planHash: str
    skippedFacts: list[SkippedFact] = Field(default_factory=list, max_length=200)


class PdfFieldInfo(Contract):
    targetId: str = Field(min_length=1, max_length=500)
    fieldType: str
    editable: bool
    options: list[str] = Field(default_factory=list, max_length=3000)
    optionMappings: list[dict[str, str]] = Field(default_factory=list, max_length=3000)
    widgets: list[dict] = Field(default_factory=list, max_length=3000)


class GenerateDocumentRequest(Contract):
    contractVersion: Literal["application-document-mcp-v1"] = CONTRACT
    sourceBase64: str = Field(min_length=1, max_length=44_739_244)
    sourceSha256: str = Field(pattern="^[a-f0-9]{64}$")
    format: Literal["hwp", "hwpx", "pdf", "docx", "xlsx"]
    answerRevision: int = Field(ge=0)
    facts: list[DocumentFact] = Field(min_length=1, max_length=200)
    scope: str = Field(min_length=1, max_length=30000)
    pdfTargets: list[DocumentTarget] = Field(default_factory=list, max_length=3000)
    pageImages: list[str] = Field(default_factory=list, max_length=50)
    pdfFields: list[PdfFieldInfo] = Field(default_factory=list, max_length=3000)
    hwpTargets: list[DocumentTarget] = Field(default_factory=list, max_length=3000)
    bindings: list[DocumentPlacement] = Field(default_factory=list, max_length=600)
    scopeTargetIds: list[str] = Field(default_factory=list, max_length=3000)

    @model_validator(mode="after")
    def validate_source(self):
        data = base64.b64decode(self.sourceBase64, validate=True)
        if not 0 < len(data) <= MAX_BYTES or digest(data) != self.sourceSha256:
            raise ValueError("source hash/size mismatch")
        if len({f.id for f in self.facts}) != len(self.facts):
            raise ValueError("duplicate fact")
        if sum(map(len, self.pageImages)) > MAX_BYTES:
            raise ValueError("image size limit")
        for page in self.pageImages:
            if not base64.b64decode(page, validate=True).startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("invalid image")
        if self.format != "pdf" and (self.pdfTargets or self.pageImages):
            raise ValueError("PDF metadata on another format")
        if self.format != "hwp" and self.hwpTargets:
            raise ValueError("HWP metadata on another format")
        return self


class DocumentFieldReference(Contract):
    id: str = Field(min_length=1, max_length=129)
    label: str = Field(min_length=1, max_length=210)
    guidance: str = Field(max_length=1000)
    required: bool
    options: list[str] = Field(default_factory=list, max_length=30)


class MapDocumentRequest(GenerateDocumentRequest):
    answerRevision: int = 0
    facts: list[DocumentFact] = Field(default_factory=list, max_length=0)
    fields: list[DocumentFieldReference] = Field(min_length=1, max_length=200)


class MappingSelection(Contract):
    bindings: list[DocumentPlacement] = Field(max_length=600)
    scopeTargetIds: list[str] = Field(max_length=3000)
    unmappedFieldIds: list[str] = Field(max_length=200)


def mapping_label_key(text: str) -> str:
    text = re.sub(r"^\s*[①-⑳]?\s*", "", text)
    key = "".join(c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum())
    # Official forms use both spellings for the same year/month/day column.
    return key.replace("연월일", "년월일")


def mapping_label_matches(label: str, target: NativeTarget, guidance: str = "") -> bool:
    field = mapping_label_key(label.partition(" / ")[2] or label)
    labels = [mapping_label_key(value) for value in target.nativeLocator.get("fieldLabels", [])]
    if target.kind == "XLSX_CELL":
        # A shortened label such as 성명 must not bind a 대표자 question to a team-member row.
        return field in labels
    if not labels:
        return True
    years = set(re.findall(r"(?:19|20)\d{2}", field))
    if years:
        native_years = set(re.findall(r"(?:19|20)\d{2}", " ".join(labels)))
        if native_years and not years <= native_years:
            return False
        row_labels = [mapping_label_key(value) for value in target.nativeLocator.get("rowLabels", [])]
        row_evidence = field
        if re.fullmatch(r"(?:19|20)\d{2}(?:년|년도)?", field):
            row_evidence += mapping_label_key(guidance)
        if native_years and row_labels and not any(len(value) >= 2 and value in row_evidence for value in row_labels):
            return False
    return any(field == value or len(value) >= 2 and (field in value or value in field) for value in labels)


def _binding_violation(request: MapDocumentRequest, document: DocumentMap, binding: DocumentPlacement,
                       targets: dict, scope: set[str], labels: set[str]) -> str | None:
    """바인딩 하나가 어기는 규칙의 이유 코드입니다. 다른 바인딩과의 겹침은 따로 봅니다."""
    target = targets.get(binding.targetId)
    if target is None or not target.editable or binding.targetId not in scope or target.kind == "PDF_TEXT":
        return "MAPPING_TARGET_NOT_EDITABLE_OR_OUT_OF_SCOPE"
    if not target.nativeLocator.get("bindingEligible", True):
        return "REPEATED_ROW_NOT_SELECTED"
    box = binding.box
    field = next(f for f in request.fields if f.id == binding.factId)
    candidates = {candidate.targetId for candidate in document.targets if candidate.editable
                  and candidate.nativeLocator.get("fieldLabels") and mapping_label_matches(field.label, candidate, field.guidance)}
    if candidates and binding.targetId not in candidates:
        return "FIELD_LABEL_MISMATCH"
    if not mapping_label_matches(field.label, target, field.guidance):
        return "FIELD_LABEL_MISMATCH"
    if (box is not None) != (target.kind == "PDF_PAGE"):
        return "MAPPING_BOX_KIND_MISMATCH"
    if box and (box.x + box.width > 1 or box.y + box.height > 1):
        return "MAPPING_BOX_OUT_OF_PAGE"
    if box:
        for region in target.nativeLocator.get("printedTextRegions", []):
            if mapping_label_key(region["text"]) in labels and box.overlaps(DocumentBox.model_validate(region["box"])):
                return "MAPPING_BOX_COVERS_PRINTED_LABEL"
    return None


def _overlaps(one: DocumentPlacement, other: DocumentPlacement) -> bool:
    return one.box is None or other.box is None or one.box.overlaps(other.box)


def validate_mapping(request: MapDocumentRequest, document: DocumentMap, selection: MappingSelection,
                     *, allow_required_unmapped: bool = False):
    """매핑 결과를 원본 지도와 문항에 맞춰 엄격히 검사합니다. [allow_required_unmapped]는 살려 쓴 결과처럼
    필수 문항을 사람이 직접 작성하도록 남긴 경우에만 켭니다."""
    fields = {f.id for f in request.fields}
    targets = {t.targetId: t for t in document.targets}
    if len(fields) != len(request.fields):
        raise DocumentError("MAPPING_FAILED", reason="DUPLICATE_FIELD_IDS")
    unmapped = set(selection.unmappedFieldIds)
    bound = {b.factId for b in selection.bindings}
    if len(unmapped) != len(selection.unmappedFieldIds) or not unmapped <= fields or unmapped & bound:
        raise DocumentError("MAPPING_FAILED", reason="INVALID_UNMAPPED_FIELDS")
    if not allow_required_unmapped and unmapped & {f.id for f in request.fields if f.required}:
        raise DocumentError("MAPPING_FAILED", reason="UNMAPPED_REQUIRED_FIELDS")
    if bound | unmapped != fields:
        raise DocumentError("MAPPING_FAILED", reason="FIELD_COVERAGE_MISMATCH")
    if len(selection.scopeTargetIds) != len(set(selection.scopeTargetIds)) or not set(selection.scopeTargetIds) <= targets.keys():
        raise DocumentError("MAPPING_FAILED", reason="INVALID_MAPPING_SCOPE")
    if document.sourceSha256 != request.sourceSha256 or document.format != request.format or len(targets) != len(document.targets):
        raise DocumentError("SOURCE_CHANGED")
    seen = {}
    scope = set(selection.scopeTargetIds)
    labels = {mapping_label_key(f.label.partition(" / ")[2] or f.label) for f in request.fields}
    for binding in selection.bindings:
        if reason := _binding_violation(request, document, binding, targets, scope, labels):
            raise DocumentError("MAPPING_FAILED", reason=reason)
        for previous in seen.get(binding.targetId, []):
            if _overlaps(binding, previous):
                raise DocumentError("MAPPING_FAILED", reason="MAPPING_TARGET_OVERLAP")
        seen.setdefault(binding.targetId, []).append(binding)
    if any(targets[key].nativeLocator.get("parent") in seen for key in seen):
        raise DocumentError("MAPPING_FAILED", reason="MAPPING_PARENT_CHILD_CONFLICT")


def salvage_mapping(request: MapDocumentRequest, document: DocumentMap,
                    selection: MappingSelection) -> tuple[MappingSelection, dict[str, str]] | None:
    """다시 요청해도 규칙을 어긴 매핑에서 어긴 문항만 사람이 직접 작성할 문항으로 옮기고 나머지 칸은 살립니다.
    같은 칸을 고른 문항들과 서로 부모·자식인 칸을 고른 문항들은 어느 쪽이 맞는지 알 수 없어 모두 뺍니다.
    질문 ID 중복이나 원본 변경처럼 계약이 깨졌거나 남는 칸이 없으면 None입니다(호출부가 원래 실패를 냅니다)."""
    field_ids = [f.id for f in request.fields]
    targets = {t.targetId: t for t in document.targets}
    if (len(set(field_ids)) != len(field_ids) or len(targets) != len(document.targets)
            or document.sourceSha256 != request.sourceSha256 or document.format != request.format):
        return None
    known = set(field_ids)
    scope_ids = list(dict.fromkeys(key for key in selection.scopeTargetIds if key in targets))
    scope = set(scope_ids)
    declared = set(selection.unmappedFieldIds) & known
    labels = {mapping_label_key(f.label.partition(" / ")[2] or f.label) for f in request.fields}
    reasons: dict[str, str] = {field_id: "MODEL_UNMAPPED" for field_id in declared}
    kept: list[DocumentPlacement] = []
    for binding in selection.bindings:
        if binding.factId not in known or binding.factId in declared:
            continue
        if reason := _binding_violation(request, document, binding, targets, scope, labels):
            reasons.setdefault(binding.factId, reason)
            continue
        kept.append(binding)
    dropped: dict[int, str] = {}
    for index, binding in enumerate(kept):
        for other_index, other in enumerate(kept):
            if other_index != index and other.targetId == binding.targetId and _overlaps(binding, other):
                dropped[index] = "MAPPING_TARGET_OVERLAP"
    bound_targets = {binding.targetId for binding in kept}
    for index, binding in enumerate(kept):
        parent = targets[binding.targetId].nativeLocator.get("parent")
        if parent in bound_targets:
            dropped.setdefault(index, "MAPPING_PARENT_CHILD_CONFLICT")
            for other_index, other in enumerate(kept):
                if other.targetId == parent:
                    dropped.setdefault(other_index, "MAPPING_PARENT_CHILD_CONFLICT")
    for index, reason in dropped.items():
        reasons.setdefault(kept[index].factId, reason)
    kept = [binding for index, binding in enumerate(kept) if index not in dropped]
    if not kept:
        return None
    bound = {binding.factId for binding in kept}
    unmapped = [field_id for field_id in field_ids if field_id not in bound]
    reasons = {field_id: reasons.get(field_id, "NOT_PLACED") for field_id in unmapped}
    salvaged = MappingSelection(bindings=kept, scopeTargetIds=scope_ids, unmappedFieldIds=unmapped)
    validate_mapping(request, document, salvaged, allow_required_unmapped=True)
    return salvaged, reasons


def validate_plan(request: GenerateDocumentRequest, document: DocumentMap, selection: PlanSelection,
                  skipped: list[SkippedFact] = ()) -> WritePlan:
    """Checks the plan against the native map and saved bindings. Answers the planner could not place
    (unresolvedTargets, or [skipped] by the slot rules and the fit check) are left out of the document and
    reported instead of failing it, as long as at least one answer is written."""
    if document.sourceSha256 != request.sourceSha256 or document.format != request.format:
        raise DocumentError("SOURCE_CHANGED")
    targets = {t.targetId: t for t in document.targets}
    if len(targets) != len(document.targets):
        raise DocumentError("VALIDATION_FAILED")
    facts = {f.id: f.value for f in request.facts}
    bound = {b.factId: b.targetId for b in request.bindings}
    skipped = [*skipped, *(SkippedFact(factId=fact_id, targetId=bound.get(fact_id, ""), reason="UNRESOLVED")
                           for fact_id in selection.unresolvedTargets)]
    skipped_ids = {item.factId for item in skipped}
    if len(skipped_ids) != len(skipped) or not skipped_ids <= facts.keys():
        raise DocumentError("MAPPING_FAILED", reason="INVALID_SKIPPED_FACTS")
    if skipped_ids & {op.valueRef for op in selection.operations}:
        raise DocumentError("MAPPING_FAILED", reason="SKIPPED_FACT_ALSO_PLANNED")
    if not selection.operations:
        if skipped and all(item.reason == "OVERFLOW" for item in skipped):
            raise DocumentError("OVERFLOW", reason="ALL_FACTS_OVERFLOW")
        raise DocumentError("NO_WRITABLE_INPUT", reason="ALL_FACTS_SKIPPED")
    scope = set(selection.scopeTargetIds)
    if not scope <= targets.keys() or len(scope) != len(selection.scopeTargetIds):
        raise DocumentError("MAPPING_FAILED", reason="INVALID_SCOPE_IDS")
    if request.scopeTargetIds and not scope <= set(request.scopeTargetIds):
        raise DocumentError("MAPPING_FAILED", reason="SCOPE_OUTSIDE_SAVED_FORM")
    used: set[str] = set()
    seen: dict[str, list[EditOperation]] = {}
    for op in selection.operations:
        target = targets.get(op.targetId)
        if target is None or op.targetId not in scope or not target.editable:
            raise DocumentError("MAPPING_FAILED", reason="TARGET_NOT_EDITABLE_OR_OUT_OF_SCOPE")
        if (request.format == "hwpx" and op.valueRef is not None
                and not target.nativeLocator.get("bindingEligible", True)):
            raise DocumentError("MAPPING_FAILED", reason="SAVED_BINDING_CHANGED" if request.bindings else "TARGET_NOT_EDITABLE_OR_OUT_OF_SCOPE")
        if request.format == "xlsx":
            if (target.kind != "XLSX_CELL" or op.operation not in {"input", "set_field"}
                    or op.start != 0 or op.end != 0 or target.currentText
                    or not target.nativeLocator.get("bindingEligible", False)):
                raise DocumentError("UNSUPPORTED", reason="XLSX_ONLY_BLANK_CELL_WRITE")
            from app.application_preparation.xlsx_adapter import cell_value
            if op.valueRef not in facts:
                raise DocumentError("INPUT_REQUIRED")
            cell_value(target, facts[op.valueRef])
        if op.expectedText != target.currentText:
            raise DocumentError("SOURCE_CHANGED")
        if not 0 <= op.start <= op.end <= len(target.currentText):
            raise DocumentError("MAPPING_FAILED", reason="INVALID_TEXT_RANGE")
        if op.operation == "delete_range":
            if op.valueRef is not None or op.start == op.end or op.box is not None:
                raise DocumentError("MAPPING_FAILED", reason="INVALID_DELETE_OPERATION")
        else:
            if op.valueRef not in facts:
                raise DocumentError("INPUT_REQUIRED")
            used.add(op.valueRef)
            if request.bindings and not any(b.factId == op.valueRef and b.targetId == op.targetId and b.box == op.box for b in request.bindings):
                saved = [b.targetId for b in request.bindings if b.factId == op.valueRef]
                logger.warning("document_plan_saved_binding_changed format=%s field_id=%s planned_target=%s saved_targets=%s",
                               request.format, op.valueRef, op.targetId, saved)
                raise DocumentError("MAPPING_FAILED", reason="SAVED_BINDING_CHANGED")
        if op.operation == "input" and (op.start != op.end or target.currentText.strip()):
            raise DocumentError("MAPPING_FAILED", reason="INPUT_TARGET_NOT_EMPTY")
        if op.operation == "set_check" and target.kind != "CHECKBOX":
            raise DocumentError("UNSUPPORTED")
        if target.kind == "CHECKBOX" and (op.operation != "set_check" or op.start != 0 or op.end != len(target.currentText)
                                           or facts.get(op.valueRef, "").strip() != target.currentText.strip()):
            raise DocumentError("MAPPING_FAILED", reason="CHECK_VALUE_MISMATCH")
        if op.operation == "set_field" and target.kind not in {"HWP_FIELD", "PDF_FIELD", "PDF_PAGE", "PDF_INPUT", "DOCX_CONTROL", "XLSX_CELL"}:
            raise DocumentError("UNSUPPORTED")
        if (op.box is not None) != (target.kind == "PDF_PAGE" and op.operation == "set_field"):
            raise DocumentError("MAPPING_FAILED")
        if op.box and (op.box.x + op.box.width > 1 or op.box.y + op.box.height > 1):
            raise DocumentError("MAPPING_FAILED")
        for previous in seen.get(op.targetId, []):
            if op.box and previous.box:
                if op.box.overlaps(previous.box):
                    raise DocumentError("MAPPING_FAILED", reason="OVERLAPPING_BOXES")
            elif max(op.start, previous.start) < min(op.end, previous.end) or op.start == previous.start or op.operation.startswith("set_") or previous.operation.startswith("set_"):
                raise DocumentError("MAPPING_FAILED", reason="OVERLAPPING_OPERATIONS")
        seen.setdefault(op.targetId, []).append(op)
    labels = {f.id: f.label for f in request.facts}
    for target_id, fact_id in {(op.targetId, op.valueRef) for op in selection.operations if op.literal is not None}:
        # A derived text is accepted only where the slot rules produce exactly these edits for this answer.
        ops = [op for op in selection.operations if op.targetId == target_id and op.valueRef == fact_id]
        expected_slots = answer_slots(targets[target_id].currentText, facts[fact_id], labels[fact_id])
        if (isinstance(expected_slots, str) or any(op.operation != "replace_range" for op in ops) or
                sorted((op.start, op.end, facts[fact_id] if op.literal is None else op.literal) for op in ops)
                != sorted((slot.start, slot.end, slot.text) for slot in expected_slots)):
            raise DocumentError("MAPPING_FAILED", reason="LITERAL_NOT_DERIVED")
    if request.bindings:
        def identity(field, target, box):
            return (field, target, None if box is None else (box.x, box.y, box.width, box.height))
        expected = {identity(b.factId, b.targetId, b.box) for b in request.bindings if b.factId in facts and b.factId not in skipped_ids}
        applied = {identity(op.valueRef, op.targetId, op.box) for op in selection.operations if op.valueRef is not None}
        if applied != expected:
            raise DocumentError("MAPPING_FAILED", reason="BOUND_FACTS_NOT_COVERED")
    if request.format == "hwp":
        groups = set()
        for op in selection.operations:
            target = targets[op.targetId]
            if target.kind == "CHECKBOX":
                group = target.nativeLocator.get("group")
                members = {t.targetId for t in document.targets if t.kind == "CHECKBOX" and t.nativeLocator.get("group") == group}
                if not group or group in groups or not members <= scope:
                    raise DocumentError("MAPPING_FAILED", reason="INCOMPLETE_CHECK_GROUP")
                groups.add(group)
    # A fact can legitimately appear in several official input fields.
    if used | skipped_ids != facts.keys():
        raise DocumentError("MAPPING_FAILED", reason="FACTS_NOT_COVERED")
    for target_id in seen:
        parent = targets[target_id].nativeLocator.get("parent")
        if parent in seen:
            raise DocumentError("MAPPING_FAILED", reason="PARENT_CHILD_CONFLICT")
    # Core applies the plan; it learns about unplaced answers only from skippedFacts.
    payload = {**selection.model_dump(), "unresolvedTargets": [], "skippedFacts": [item.model_dump() for item in skipped],
               "sourceSha256": request.sourceSha256, "mapVersion": document.mapVersion, "answerRevision": request.answerRevision}
    return WritePlan(**payload, planHash=object_hash(payload))


def edited_text(target: NativeTarget, operations: list[EditOperation], facts: dict[str, str]) -> str:
    text = target.currentText
    for op in sorted(operations, key=lambda item: item.start, reverse=True):
        value = "" if op.operation == "delete_range" else facts[op.valueRef] if op.literal is None else op.literal
        if op.operation == "set_field":
            text = value
        else:
            text = text[:op.start] + value + text[op.end:]
    return text
