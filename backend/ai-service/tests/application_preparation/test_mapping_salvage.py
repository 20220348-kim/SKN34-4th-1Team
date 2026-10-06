import asyncio
import base64
from unittest.mock import AsyncMock

import pytest

from app.application_preparation import document_pipeline
from app.application_preparation.document_contract import (
    DocumentError, DocumentMap, MapDocumentRequest, MappingSelection, NativeTarget, digest, salvage_mapping, validate_mapping,
)

SOURCE = b"synthetic mapping bytes"


def mapping_request(fields, fmt="hwpx"):
    return MapDocumentRequest(sourceBase64=base64.b64encode(SOURCE).decode(), sourceSha256=digest(SOURCE), format=fmt,
                              scope="신청서", fields=fields)


def field(field_id, label, required=False):
    return {"id": field_id, "label": label, "guidance": "", "required": required}


def cell(name, **locator):
    return NativeTarget(targetId=name, nativeLocator={"target": name, **locator}, kind="cell", currentText="")


def document(req, targets):
    return DocumentMap(sourceSha256=req.sourceSha256, format=req.format, engineVersion="test", targets=targets)


def selection(bindings, scope, unmapped=()):
    return MappingSelection(bindings=[{"factId": fact, "targetId": target, "box": None} for fact, target in bindings],
                            scopeTargetIds=list(scope), unmappedFieldIds=list(unmapped))


FIELDS = [field("info:name", "사업장명", required=True), field("info:fax", "팩스"), field("info:type", "신청 유형", required=True)]


def test_questions_sharing_one_cell_are_all_left_for_manual_entry_and_the_rest_is_kept():
    req = mapping_request(FIELDS)
    doc = document(req, [cell("name"), cell("fax")])
    overlapping = selection([("info:name", "name"), ("info:fax", "fax"), ("info:type", "fax")], ["name", "fax"])
    with pytest.raises(DocumentError) as error:
        validate_mapping(req, doc, overlapping)
    assert error.value.reason == "MAPPING_TARGET_OVERLAP"

    kept, reasons = salvage_mapping(req, doc, overlapping)

    assert [(b.factId, b.targetId) for b in kept.bindings] == [("info:name", "name")]
    assert kept.unmappedFieldIds == ["info:fax", "info:type"]
    # 어느 문항이 그 칸의 주인인지 추측하지 않으므로 둘 다 사람이 직접 작성합니다.
    assert reasons == {"info:fax": "MAPPING_TARGET_OVERLAP", "info:type": "MAPPING_TARGET_OVERLAP"}
    validate_mapping(req, doc, kept, allow_required_unmapped=True)


def test_required_questions_the_model_could_not_place_become_manual_entries_instead_of_failing_the_form():
    req = mapping_request(FIELDS)
    doc = document(req, [cell("name"), cell("fax")])
    honest = selection([("info:name", "name"), ("info:fax", "fax")], ["name", "fax"], unmapped=["info:type"])
    with pytest.raises(DocumentError) as error:
        validate_mapping(req, doc, honest)
    assert error.value.reason == "UNMAPPED_REQUIRED_FIELDS"

    kept, reasons = salvage_mapping(req, doc, honest)

    assert {b.factId for b in kept.bindings} == {"info:name", "info:fax"}
    assert reasons == {"info:type": "MODEL_UNMAPPED"}


def test_bindings_outside_the_editable_scope_are_dropped_and_unknown_scope_ids_are_ignored():
    req = mapping_request(FIELDS)
    doc = document(req, [cell("name"), cell("fax"), cell("locked")])
    doc.targets[2].editable = False
    messy = selection([("info:name", "name"), ("info:fax", "locked"), ("info:type", "fax")], ["name", "fax", "locked", "ghost"])

    kept, reasons = salvage_mapping(req, doc, messy)

    assert [(b.factId, b.targetId) for b in kept.bindings] == [("info:name", "name"), ("info:type", "fax")]
    assert kept.scopeTargetIds == ["name", "fax", "locked"]
    assert reasons == {"info:fax": "MAPPING_TARGET_NOT_EDITABLE_OR_OUT_OF_SCOPE"}


def test_nothing_is_salvaged_when_no_question_keeps_a_valid_cell_or_the_contract_is_broken():
    req = mapping_request(FIELDS[:2])
    doc = document(req, [cell("fax")])
    assert salvage_mapping(req, doc, selection([("info:name", "fax"), ("info:fax", "fax")], ["fax"])) is None
    changed = DocumentMap(sourceSha256=digest(b"other"), format="hwpx", engineVersion="test", targets=[cell("fax")])
    assert salvage_mapping(req, changed, selection([("info:fax", "fax")], ["fax"], unmapped=["info:name"])) is None


def test_pipeline_asks_for_one_correction_then_keeps_the_cells_that_are_still_valid(monkeypatch):
    req = mapping_request(FIELDS)
    doc = document(req, [cell("name"), cell("fax")])
    monkeypatch.setattr(document_pipeline, "inspect_document", AsyncMock(return_value=doc))
    calls = []

    class Agent:
        async def map_document(self, request, document, **repair):
            calls.append(repair)
            return selection([("info:name", "name"), ("info:fax", "fax"), ("info:type", "fax")], ["name", "fax"])

    result = asyncio.run(document_pipeline.map_document(req, Agent()))

    assert len(calls) == 2 and calls[1]["rejection_reason"] == "MAPPING_TARGET_OVERLAP"
    assert [b["factId"] for b in result["bindings"]] == ["info:name"]
    assert result["documentMap"]["unmappedFieldIds"] == ["info:fax", "info:type"]
    assert result["documentMap"]["unmappedReasons"] == {"info:fax": "MAPPING_TARGET_OVERLAP", "info:type": "MAPPING_TARGET_OVERLAP"}
    assert result["documentMap"]["documentAnalysis"]["mapping"]["status"] == "REVIEW_REQUIRED"


def test_pipeline_accepts_an_honest_required_gap_without_a_second_paid_call(monkeypatch):
    req = mapping_request(FIELDS)
    doc = document(req, [cell("name"), cell("fax")])
    monkeypatch.setattr(document_pipeline, "inspect_document", AsyncMock(return_value=doc))
    agent = AsyncMock()
    agent.map_document = AsyncMock(return_value=selection([("info:name", "name"), ("info:fax", "fax")], ["name", "fax"],
                                                          unmapped=["info:type"]))

    result = asyncio.run(document_pipeline.map_document(req, agent))

    assert agent.map_document.await_count == 1
    assert result["documentMap"]["unmappedReasons"] == {"info:type": "MODEL_UNMAPPED"}


def test_pipeline_still_fails_when_every_question_collides(monkeypatch):
    req = mapping_request(FIELDS[1:])
    doc = document(req, [cell("fax")])
    monkeypatch.setattr(document_pipeline, "inspect_document", AsyncMock(return_value=doc))
    agent = AsyncMock()
    agent.map_document = AsyncMock(return_value=selection([("info:fax", "fax"), ("info:type", "fax")], ["fax"]))

    with pytest.raises(DocumentError) as error:
        asyncio.run(document_pipeline.map_document(req, agent))

    assert error.value.reason == "MAPPING_TARGET_OVERLAP"
    assert agent.map_document.await_count == 2


def test_hwpx_compound_table_questions_are_set_aside_instead_of_failing_the_whole_form(monkeypatch):
    req = mapping_request([field("staff:members", "참여인력", required=True), field("info:name", "사업장명", required=True)])
    doc = document(req, [cell("name"), cell("members", columnLabels=["성명", "직위"], tableHeadings=["참여인력"])])
    monkeypatch.setattr(document_pipeline, "inspect_document", AsyncMock(return_value=doc))
    seen = []

    class Agent:
        async def map_document(self, request, document, **repair):
            seen.append([f.id for f in request.fields])
            return selection([("info:name", "name")], ["name"])

    result = asyncio.run(document_pipeline.map_document(req, Agent()))

    assert seen == [["info:name"]]
    assert result["documentMap"]["unmappedFieldIds"] == ["staff:members"]
    assert result["documentMap"]["unmappedReasons"] == {"staff:members": "COMPOUND_TABLE_QUESTION"}


def test_hwpx_form_made_only_of_compound_table_questions_still_asks_for_reanalysis(monkeypatch):
    req = mapping_request([field("staff:members", "참여인력", required=True)])
    doc = document(req, [cell("members", columnLabels=["성명", "직위"], tableHeadings=["참여인력"])])
    monkeypatch.setattr(document_pipeline, "inspect_document", AsyncMock(return_value=doc))
    agent = AsyncMock()

    with pytest.raises(DocumentError) as error:
        asyncio.run(document_pipeline.map_document(req, agent))

    assert error.value.reason == "COMPOUND_TABLE_QUESTION"
    agent.map_document.assert_not_awaited()
