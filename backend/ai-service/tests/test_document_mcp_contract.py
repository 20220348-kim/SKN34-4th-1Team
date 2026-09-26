import asyncio
import base64
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mcp_types import CallToolResult

from app.application_preparation.document_contract import (
    DocumentError, DocumentMap, EditOperation, GenerateDocumentRequest, NativeTarget,
    PlanSelection, digest, edited_text, validate_plan,
)
from app.application_preparation.document_mcp import DocumentMcpSession


def request(**updates):
    source = b"synthetic test bytes"
    return GenerateDocumentRequest(**{
        "sourceBase64": base64.b64encode(source).decode(), "sourceSha256": digest(source),
        "format": "hwpx", "answerRevision": 3, "facts": [{"id": "company:name", "label": "회사명", "value": "가상기업"}],
        "scope": "신청서", **updates,
    })


def target(name="t1.r1.c2", text="", **updates):
    return NativeTarget(targetId=name, nativeLocator={"target": name}, kind="cell", currentText=text, **updates)


def operation(name="t1.r1.c2", **updates):
    return EditOperation(**{"targetId": name, "operation": "input", "expectedText": "", "start": 0, "end": 0,
                            "valueRef": "company:name", "box": None, "reason": "회사명 항목 오른쪽의 빈 입력란", **updates})


def validated(targets=None, operations=None, **updates):
    req = request()
    targets = targets or [target()]
    document = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test", targets=targets)
    selection = PlanSelection(operations=operations or [operation()], unresolvedTargets=[], scopeTargetIds=[t.targetId for t in targets], **updates)
    return validate_plan(req, document, selection)


def test_same_fact_can_fill_multiple_verified_targets():
    plan = validated([target(), target("t2.r1.c2")], [operation(), operation("t2.r1.c2")])
    assert len(plan.operations) == 2
    assert len(plan.planHash) == 64
    assert plan.answerRevision == 3


@pytest.mark.parametrize("change", [
    {"targetId": "absent"}, {"expectedText": "changed"}, {"valueRef": "invented"},
    {"start": 1, "end": 2}, {"operation": "set_check"},
])
def test_rejects_unbound_or_invalid_operations(change):
    with pytest.raises(DocumentError):
        validated(operations=[operation(**change)])


def test_rejects_duplicate_and_parent_child_edits():
    with pytest.raises(DocumentError):
        validated(operations=[operation(), operation()])
    child = target("t1.r1.c2.p1")
    child.nativeLocator["parent"] = "t1.r1.c2"
    with pytest.raises(DocumentError):
        validated([target(), child], [operation(), operation(child.targetId)])


@pytest.mark.parametrize("color", ["blue", "black", "gray"])
def test_example_range_preserves_label_independently_of_color(color):
    text = "회사명: 예시 주식회사 (필수 고지 유지)"
    item = target(text=text, context=f"color={color}")
    start = text.index("예시")
    end = text.index(" (필수")
    op = operation(operation="replace_range", expectedText=text, start=start, end=end)
    validated([item], [op])
    assert edited_text(item, [op], {"company:name": "가상기업"}) == "회사명: 가상기업 (필수 고지 유지)"


def test_unanswered_example_can_be_deleted_without_inventing_a_fact():
    example = target("t1.r2.c2", "예: 매출 100억원")
    deletion = operation(example.targetId, operation="delete_range", expectedText=example.currentText,
                         start=0, end=len(example.currentText), valueRef=None)
    validated([target(), example], [operation(), deletion])
    assert edited_text(example, [deletion], {}) == ""


def test_nonempty_input_and_unsupported_regions_fail_closed():
    with pytest.raises(DocumentError):
        validated([target(text="필수 고지")], [operation(expectedText="필수 고지")])
    with pytest.raises(DocumentError):
        validated([target(editable=False, unsupportedReason="nested_table")])


def test_hash_and_fact_identity_are_checked_before_tools():
    with pytest.raises(ValueError):
        request(sourceSha256="0" * 64)
    with pytest.raises(ValueError):
        request(facts=[{"id": "same", "label": "회사", "value": "0"}] * 2)


def test_kordoc_write_tool_never_reaches_mcp_session():
    class ForbiddenSession:
        async def call_tool(self, *args):
            pytest.fail("write was forwarded")
    session = DocumentMcpSession("kordoc", ForbiddenSession(), {"patch_document": {}})
    with pytest.raises(DocumentError):
        asyncio.run(session.call("patch_document", {}))


@pytest.mark.parametrize("payload", [{"success": False}, {"ok": False}, {"available": False}, {"error": "partial failure"}])
def test_transport_success_does_not_hide_business_failure(payload):
    class Session:
        async def call_tool(self, *args):
            return CallToolResult(is_error=False, structured_content=payload, content=[])
    session = DocumentMcpSession("pdf", Session(), {"pdf_get_text": {}})
    with pytest.raises(DocumentError):
        asyncio.run(session.call("pdf_get_text", {}))


def test_generate_endpoint_requires_internal_auth(monkeypatch):
    from app.application_preparation.router import router, get_service
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_service] = lambda: SimpleNamespace(agent=None)
    monkeypatch.setenv("DOCUMENT_INTERNAL_TOKEN", "t" * 32)
    with TestClient(app) as client:
        response = client.post("/internal/v1/application-preparations/document/generate", content=b"invalid JSON")
    assert response.status_code == 401


def test_hangeul_fastmcp_envelope_cannot_hide_failure():
    class Session:
        async def call_tool(self, *args):
            return CallToolResult(is_error=False, structured_content={"result": {"available": True, "ok": False, "error": "failed"}}, content=[])
    session = DocumentMcpSession("hwpx", Session(), {"inspect_editable_regions": {}})
    with pytest.raises(DocumentError):
        asyncio.run(session.call("inspect_editable_regions", {}))


@pytest.mark.parametrize("run", ['<hp:run charPrIDRef="33"/>', '<hp:run charPrIDRef="33"><hp:t/></hp:run>'])
def test_empty_run_extension_keeps_style_and_escapes_text(run):
    from app.application_preparation.hwpx_mcp_extension import fill_empty_run
    xml = '<hp:p id="7">' + run + '</hp:p>'
    result = fill_empty_run(xml, '가상 & 연구소 <검증>')
    assert 'charPrIDRef="33"' in result
    assert '가상 &amp; 연구소 &lt;검증&gt;' in result
    assert 'id="7"' in result


@pytest.mark.parametrize("unsafe", ['<hp:pic/>', '<hp:ctrl/>', '<hp:tbl/>', '<hp:t>보존 고지</hp:t>'])
def test_empty_run_extension_refuses_controls_or_existing_content(unsafe):
    from app.application_preparation.hwpx_mcp_extension import fill_empty_run
    assert fill_empty_run('<hp:p><hp:run charPrIDRef="33"/>' + unsafe + '</hp:p>', '가상기업') is None


def test_question_mapping_contains_no_answers_and_rejects_shared_targets():
    from app.application_preparation.document_contract import MapDocumentRequest, MappingSelection, validate_mapping
    from app.application_preparation.document import DocumentPlacement
    base = request().model_dump(exclude={"facts"})
    mapping = MapDocumentRequest(**base, fields=[{"id": "company:name", "label": "기업명", "guidance": "정확한 상호", "required": True}])
    assert mapping.facts == []
    assert "value" not in mapping.fields[0].model_dump()
    document = DocumentMap(sourceSha256=mapping.sourceSha256, format="hwpx", engineVersion="test", targets=[target()])
    binding = DocumentPlacement(factId="company:name", targetId="t1.r1.c2", box=None)
    validate_mapping(mapping, document, MappingSelection(bindings=[binding], scopeTargetIds=["t1.r1.c2"], unmappedFieldIds=[]))
    with pytest.raises(DocumentError):
        validate_mapping(mapping, document, MappingSelection(bindings=[binding, binding], scopeTargetIds=["t1.r1.c2"], unmappedFieldIds=[]))


def test_generation_cannot_move_a_field_bound_before_questions():
    from app.application_preparation.document import DocumentPlacement
    req = request(bindings=[DocumentPlacement(factId="company:name", targetId="t1.r1.c2", box=None)], scopeTargetIds=["t1.r1.c2", "t1.r2.c2"])
    document = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test", targets=[target(), target("t1.r2.c2")])
    with pytest.raises(DocumentError):
        validate_plan(req, document, PlanSelection(operations=[operation("t1.r2.c2")], scopeTargetIds=req.scopeTargetIds, unresolvedTargets=[]))


def test_range_replacement_keeps_the_label_and_notice_in_their_original_runs():
    from app.application_preparation.hwpx_mcp_extension import replace_plain_text_runs
    xml = '<hp:p><hp:run charPrIDRef="1"><hp:t>기업명: </hp:t></hp:run><hp:run charPrIDRef="2"><hp:t>예시 회사</hp:t></hp:run><hp:run charPrIDRef="3"><hp:t> / 필수 고지</hp:t></hp:run></hp:p>'
    result = replace_plain_text_runs(xml, '기업명: 가상기업 / 필수 고지')
    assert result == xml.replace('<hp:t>예시 회사</hp:t>', '<hp:t>가상기업</hp:t>')
    assert replace_plain_text_runs('<hp:p><hp:run><hp:t>예시예시</hp:t></hp:run></hp:p>', '예시') is None



def hwp_request(**updates):
    source = bytes.fromhex("d0cf11e0a1b11ae1") + b"core-authenticated-fixture"
    return request(format="hwp", sourceBase64=base64.b64encode(source).decode(), sourceSha256=digest(source),
                   hwpTargets=[{"id": "s0-p1", "text": "기업명: ____ / 필수", "context": "신청서 기업명 칸"}], **updates)


def test_hwp_map_and_generation_use_core_targets_without_a_windows_process(monkeypatch):
    from app.application_preparation.document_contract import MappingSelection
    from app.application_preparation.router import router, get_service
    from app.application_preparation import document_pipeline
    async def forbidden(*args):
        pytest.fail("HWP must not start an auxiliary editor or Windows bridge")
    monkeypatch.setattr(document_pipeline, "assist_with_kordoc", forbidden)
    for key in ("DOCUMENT_HWP_BRIDGE_URL", "DOCUMENT_HWP_BRIDGE_TOKEN", "DOCUMENT_HWP_COMMAND"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DOCUMENT_INTERNAL_TOKEN", "t" * 32)
    class Agent:
        async def map_document(self, req, document):
            assert req.facts == []
            assert document.engineVersion.startswith("kr.dogfoot/hwplib@1.1.11")
            return MappingSelection(bindings=[{"factId": "company:name", "targetId": "s0-p1", "box": None}],
                                    scopeTargetIds=["s0-p1"], unmappedFieldIds=[])
        async def plan_document(self, req, document):
            t = document.targets[0]
            return PlanSelection(operations=[operation("s0-p1", operation="replace_range", expectedText=t.currentText,
                start=t.currentText.index("____"), end=t.currentText.index("____") + 4)], scopeTargetIds=["s0-p1"], unresolvedTargets=[])
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_service] = lambda: SimpleNamespace(agent=Agent())
    req = hwp_request()
    headers = {"Authorization": "Bearer " + "t" * 32}
    with TestClient(app) as client:
        mapping = req.model_dump(exclude={"facts", "answerRevision"})
        mapping["fields"] = [{"id": "company:name", "label": "기업명", "guidance": "", "required": True}]
        mapped = client.post("/internal/v1/application-preparations/document/map", json=mapping, headers=headers)
        assert mapped.status_code == 200, mapped.text
        payload = req.model_dump()
        payload.update({k: mapped.json()[k] for k in ("bindings", "scopeTargetIds")})
        generated = client.post("/internal/v1/application-preparations/document/generate", json=payload, headers=headers)
    assert generated.status_code == 200, generated.text
    result = generated.json()
    assert result["verification"]["stage"] == "HWPLIB_REQUIRED"
    assert result["outputBase64"] == req.sourceBase64
    assert result["outputSha256"] == req.sourceSha256
    assert result["writePlan"]["operations"][0]["expectedText"] == req.hwpTargets[0].text
    assert result["placements"] == [{"factId": "company:name", "targetId": "s0-p1", "box": None}]


def test_hwp_requires_authoritative_targets_and_rejects_foreign_metadata():
    from app.application_preparation.document_adapters import HwpDocumentAdapter
    req = hwp_request()
    req.hwpTargets = []
    with pytest.raises(DocumentError):
        HwpDocumentAdapter().inspect(req)
    with pytest.raises(ValueError):
        request(hwpTargets=[{"id": "s0-p1", "text": "", "context": ""}])


def test_hwp_unsupported_core_target_is_not_mapped():
    from app.application_preparation.document_adapters import HwpDocumentAdapter
    req = hwp_request()
    req.hwpTargets[0].editable = False
    req.hwpTargets[0].unsupportedReason = "UNSUPPORTED_TEXT_CONTROLS_OR_OFFSETS"
    document = HwpDocumentAdapter().inspect(req)
    assert not document.targets[0].editable
    with pytest.raises(DocumentError):
        validate_plan(req, document, PlanSelection(operations=[operation("s0-p1", expectedText=document.targets[0].currentText)],
                                                  scopeTargetIds=["s0-p1"], unresolvedTargets=[]))


@pytest.mark.parametrize("value,scope", [("없는 선택지", ["a", "b"]), ("디지털", ["a"])])
def test_hwp_checks_require_exact_value_and_whole_group_scope(value, scope):
    req = hwp_request()
    req.facts[0].value = value
    document = DocumentMap(sourceSha256=req.sourceSha256, format="hwp", engineVersion="test", targets=[
        NativeTarget(targetId=k, nativeLocator={"group": "g"}, kind="CHECKBOX", currentText=v)
        for k, v in [("a", "디지털"), ("b", "생활")]])
    with pytest.raises(DocumentError):
        validate_plan(req, document, PlanSelection(operations=[operation("a", operation="set_check", expectedText="디지털", start=0, end=3)], scopeTargetIds=scope, unresolvedTargets=[]))


def test_hwp_planning_uses_saved_form_and_only_answered_bindings(monkeypatch):
    import json
    from unittest.mock import AsyncMock
    from app.application_preparation.agent import ApplicationPreparationAgent
    from app.application_preparation.document import DocumentPlacement
    req = hwp_request()
    req.bindings = [DocumentPlacement(factId="company:name", targetId="s0-p1", box=None),
                    DocumentPlacement(factId="company:phone", targetId="s0-p2", box=None)]
    req.scopeTargetIds = ["s0-p1", "s0-p2"]
    document = DocumentMap(sourceSha256=req.sourceSha256, format="hwp", engineVersion="test", targets=[
        NativeTarget(targetId=key, nativeLocator={"paragraph": key}, kind="paragraph", currentText=text)
        for key, text in [("s0-p1", ""), ("s0-p2", "예시: 확인이 필요한 안내"), ("other-form", "다른 신청서")]
    ])
    before = document.model_dump()
    agent = ApplicationPreparationAgent(model=None, run_timeout_seconds=10)
    invoke = AsyncMock(return_value=PlanSelection(operations=[], scopeTargetIds=[], unresolvedTargets=[]))
    monkeypatch.setattr(agent, "_invoke", invoke)
    asyncio.run(agent.plan_document(req, document))
    payload = json.loads(invoke.call_args.args[2][0]["text"])
    assert payload["bindings"] == [req.bindings[0].model_dump()]
    assert payload["facts"] == [req.facts[0].model_dump()]
    assert [item["targetId"] for item in payload["documentMap"]["targets"]] == ["s0-p1", "s0-p2"]
    assert payload["scopeTargetIds"] == req.scopeTargetIds
    assert document.model_dump() == before


def test_invalid_saved_hwp_scope_does_not_call_model(monkeypatch):
    from unittest.mock import AsyncMock
    from app.application_preparation.agent import ApplicationPreparationAgent
    from app.application_preparation.document_adapters import HwpDocumentAdapter
    req = hwp_request()
    req.scopeTargetIds = ["no-such-target"]
    agent = ApplicationPreparationAgent(model=None, run_timeout_seconds=10)
    invoke = AsyncMock()
    monkeypatch.setattr(agent, "_invoke", invoke)
    with pytest.raises(DocumentError) as error:
        asyncio.run(agent.plan_document(req, HwpDocumentAdapter().inspect(req)))
    assert error.value.reason == "INVALID_SAVED_SCOPE"
    invoke.assert_not_awaited()


def test_out_of_saved_scope_is_still_rejected_with_specific_reason():
    req = hwp_request()
    req.scopeTargetIds = ["s0-p1"]
    document = DocumentMap(sourceSha256=req.sourceSha256, format="hwp", engineVersion="test", targets=[
        NativeTarget(targetId=key, nativeLocator={}, kind="paragraph", currentText="") for key in ["s0-p1", "other-form"]])
    with pytest.raises(DocumentError) as error:
        validate_plan(req, document, PlanSelection(operations=[operation("s0-p1")],
            scopeTargetIds=["s0-p1", "other-form"], unresolvedTargets=[]))
    assert error.value.code == "APPLICATION_DOCUMENT_MAPPING_FAILED"
    assert error.value.reason == "SCOPE_OUTSIDE_SAVED_FORM"


def test_rejected_write_plan_logs_reason_without_answers(monkeypatch, caplog):
    import logging
    from app.application_preparation.router import router, get_service
    class Agent:
        async def plan_document(self, request, document):
            return PlanSelection(operations=[], scopeTargetIds=["s0-p1"], unresolvedTargets=["s0-p1"])
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_service] = lambda: SimpleNamespace(agent=Agent())
    monkeypatch.setenv("DOCUMENT_INTERNAL_TOKEN", "t" * 32)
    req = hwp_request()
    req.facts[0].value = "PRIVATE_FACT_NOT_FOR_LOGGING"
    caplog.set_level(logging.WARNING, logger="app.application_preparation.router")
    with TestClient(app) as client:
        response = client.post("/internal/v1/application-preparations/document/generate", json=req.model_dump(),
                               headers={"Authorization": "Bearer " + "t" * 32})
    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "APPLICATION_DOCUMENT_MAPPING_FAILED"}}
    assert "mode=generate" in caplog.text and "reason=UNRESOLVED_TARGETS" in caplog.text
    assert req.facts[0].value not in caplog.text


@pytest.mark.parametrize("failure,reason", [("tool", "REMOTE_TOOL_ERROR"), ("payload", "REMOTE_RESULT_FAILURE"),
                                           ("transport", "TRANSPORT_CALL"), ("schema", "ARGUMENT_SCHEMA")])
def test_mcp_failure_identifies_tool_without_exposing_document(failure, reason, caplog):
    from unittest.mock import AsyncMock
    from mcp_types import TextContent
    private = "PRIVATE_DOCUMENT_TEXT_AND_PATH"
    session = SimpleNamespace(call_tool=AsyncMock())
    if failure == "transport":
        session.call_tool.side_effect = RuntimeError(private)
    else:
        session.call_tool.return_value = CallToolResult(is_error=failure == "tool",
            structured_content={"error": private} if failure == "payload" else None,
            content=[TextContent(type="text", text=private)])
    wrapped = DocumentMcpSession("pdf", session, {"pdf_get_text": {"type": "object", "required": ["pdf_path"]}})
    with pytest.raises(DocumentError) as error:
        asyncio.run(wrapped.call("pdf_get_text", {} if failure == "schema" else {"pdf_path": private}))
    assert error.value.reason == f"pdf:pdf_get_text:{reason}"
    assert f"engine=pdf tool=pdf_get_text reason={reason}" in caplog.text
    assert private not in caplog.text
    if failure == "schema":
        session.call_tool.assert_not_awaited()


@pytest.mark.parametrize("mode,code", [("map", "PLAN_TIMEOUT"), ("generate", "OUTCOME_UNKNOWN")])
def test_document_request_deadline_distinguishes_read_from_write(monkeypatch, mode, code):
    from unittest.mock import AsyncMock
    from app.application_preparation.router import router, get_service
    from app.application_preparation import document_pipeline
    monkeypatch.setenv("DOCUMENT_INTERNAL_TOKEN", "t" * 32)
    monkeypatch.setattr(document_pipeline, "map_document" if mode == "map" else "generate_document",
                        AsyncMock(side_effect=TimeoutError))
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_service] = lambda: SimpleNamespace(agent=None)
    payload = hwp_request().model_dump()
    if mode == "map":
        payload.pop("facts")
        payload.pop("answerRevision")
        payload["fields"] = [{"id": "company:name", "label": "회사명", "guidance": "", "required": True}]
    with TestClient(app) as client:
        response = client.post(f"/internal/v1/application-preparations/document/{mode}", json=payload,
                               headers={"Authorization": "Bearer " + "t" * 32})
    assert response.status_code == 504
    assert response.json() == {"detail": {"code": "APPLICATION_DOCUMENT_" + code}}


@pytest.mark.parametrize("overlap", [0, 0.00000001])
def test_adjacent_pdf_phone_boxes_use_decimal_edges_for_mapping_and_writing(overlap):
    from app.application_preparation.document_contract import MapDocumentRequest, MappingSelection, validate_mapping
    from app.application_preparation.document import DocumentPlacement, DocumentBox
    facts = [{"id": key, "label": key, "value": "02-123-4567"} for key in ["office", "mobile"]]
    req = request(format="pdf", facts=facts)
    boxes = [DocumentBox(x=0.6733490566, y=0.2055855856, width=0.2452830189, height=0.0191441441),
             DocumentBox(x=0.6733490566, y=0.2247297297 - overlap, width=0.2452830189, height=0.0191441441)]
    document = DocumentMap(sourceSha256=req.sourceSha256, format="pdf", engineVersion="test",
        targets=[NativeTarget(targetId="page-0", nativeLocator={}, kind="PDF_PAGE", currentText="")])
    mapping = MapDocumentRequest(**req.model_dump(exclude={"facts"}),
        fields=[{"id": f["id"], "label": f["label"], "guidance": "", "required": False} for f in facts])
    bindings = [DocumentPlacement(factId=f["id"], targetId="page-0", box=b) for f, b in zip(facts, boxes)]
    selection = MappingSelection(bindings=bindings, scopeTargetIds=["page-0"], unmappedFieldIds=[])
    plan = PlanSelection(operations=[operation("page-0", operation="set_field", valueRef=f["id"], box=b) for f, b in zip(facts, boxes)],
        scopeTargetIds=["page-0"], unresolvedTargets=[])
    for validate in (lambda: validate_mapping(mapping, document, selection), lambda: validate_plan(req, document, plan)):
        if overlap:
            with pytest.raises(DocumentError):
                validate()
        else:
            validate()


def test_mapping_response_schema_allows_only_real_editable_leaf_addresses(monkeypatch):
    import json
    from pydantic import ValidationError
    from app.application_preparation.agent import ApplicationPreparationAgent
    from app.application_preparation.document_contract import MapDocumentRequest
    req = MapDocumentRequest(**request().model_dump(exclude={"facts"}),
        fields=[{"id": "company:name", "label": "회사명", "guidance": "", "required": False}])
    document = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test", targets=[
        target("cell"), NativeTarget(targetId="cell.p1", kind="paragraph", currentText="", nativeLocator={"parent": "cell"}),
        target("title", "제목", editable=False)], auxiliaryText="DUPLICATE_PRIMARY_TEXT")
    before = document.model_dump()
    async def invoke(selection_type, _instructions, content, *_args, **_kwargs):
        payload = json.loads(content[0]["text"])
        assert "auxiliaryText" not in payload["documentMap"]
        assert {t["targetId"] for t in payload["documentMap"]["targets"]} == {"cell.p1", "title"}
        valid = {"assignments": {"company:name": {"targetId": "cell.p1"}},
                 "scope": {"cell.p1": True}}
        for invalid in ("cell", "title", "cellXp1", "invented"):
            with pytest.raises(ValidationError):
                selection_type.model_validate({**valid, "assignments": {"company:name": {"targetId": invalid}}})
            with pytest.raises(ValidationError):
                selection_type.model_validate({**valid, "scope": {invalid: True}})
        return selection_type.model_validate(valid)
    agent = ApplicationPreparationAgent(model=None, run_timeout_seconds=1)
    monkeypatch.setattr(agent, "_invoke", invoke)
    selection = asyncio.run(agent.map_document(req, document))
    assert selection.scopeTargetIds == ["cell.p1"]
    assert document.model_dump() == before


def test_hwpx_physical_body_indices_include_blanks_and_survive_filling(monkeypatch, tmp_path):
    import re
    import sys
    from types import ModuleType
    from app.application_preparation.hwpx_mcp_extension import install_addressed_patches, verify_edits
    # External package double; the real parser/preview/apply path is covered by the Docker fixture smoke.
    package, addressed = ModuleType("hangeul_core"), ModuleType("hangeul_core.addressed")
    package.addressed = addressed
    addressed._body_para_spans = lambda xml: [(m.start(), m.end(), False) for m in re.finditer(r'<hp:p\b.*?</hp:p>', xml)]
    addressed._paragraph_text = lambda xml: ''.join(re.findall(r'<hp:t>(.*?)</hp:t>', xml))
    addressed._paragraph_id = lambda xml: re.search(r'id="([^"]+)"', xml).group(1)
    addressed._P_OPEN_TAG_RE = re.compile(r'<hp:p\b[^>]*>')
    addressed._section_names = lambda pkg: ["Contents/section0.xml"]
    addressed.HwpxPackage = SimpleNamespace(open=lambda path: SimpleNamespace(read=lambda name: Path(path).read_bytes()))
    addressed.marker_prefix = lambda text: ""
    addressed.inspect_editable_regions = lambda path, compact=False: {"regions": []}
    monkeypatch.setitem(sys.modules, "hangeul_core", package)
    monkeypatch.setitem(sys.modules, "hangeul_core.addressed", addressed)
    install_addressed_patches()
    xml = '<hp:p id="1"><hp:run charPrIDRef="3"/></hp:p><hp:p id="2"><hp:run><hp:t>보존 제목</hp:t></hp:run></hp:p>'
    source, output = tmp_path / "source.hwpx", tmp_path / "output.hwpx"
    source.write_text(xml, encoding="utf-8")
    assert addressed.body_field_index(source) == {"b1": ("Contents/section0.xml", 1), "b2": ("Contents/section0.xml", 2)}
    changed, applied = addressed.replace_body_paragraph(xml, {1: "검증 기업"}, keep_marker=False)
    assert applied == [1]
    assert '<hp:run charPrIDRef="3"><hp:t>검증 기업</hp:t></hp:run>' in changed
    assert changed[changed.index('<hp:p id="2">'):] == xml[xml.index('<hp:p id="2">'):]
    output.write_text(changed, encoding="utf-8")
    assert addressed.body_field_index(output) == addressed.body_field_index(source)
    assert verify_edits(str(source), str(output), [{"target": "b1", "expected_text": "검증 기업"}])["verified"] is True


@pytest.mark.parametrize("x,passes", [(0.67, False), (0.78, True)])
def test_pdf_answer_box_cannot_cover_a_printed_field_sublabel(x, passes):
    from app.application_preparation.document_contract import MapDocumentRequest, MappingSelection, validate_mapping
    req = MapDocumentRequest(**request(format="pdf").model_dump(exclude={"facts"}),
        fields=[{"id": "office", "label": "기본정보 / (사무실)", "guidance": "", "required": False}])
    document = DocumentMap(sourceSha256=req.sourceSha256, format="pdf", engineVersion="test", targets=[
        NativeTarget(targetId="page-0", kind="PDF_PAGE", currentText="", nativeLocator={"printedTextRegions": [
            {"text": "(사무실)", "box": {"x": 0.68, "y": 0.21, "width": 0.08, "height": 0.015}}]})])
    selection = MappingSelection(bindings=[{"factId": "office", "targetId": "page-0",
        "box": {"x": x, "y": 0.205, "width": 0.1, "height": 0.025}}], scopeTargetIds=["page-0"], unmappedFieldIds=[])
    if passes:
        validate_mapping(req, document, selection)
    else:
        with pytest.raises(DocumentError) as error:
            validate_mapping(req, document, selection)
        assert error.value.reason == "MAPPING_BOX_COVERS_PRINTED_LABEL"


@pytest.mark.parametrize("corrected", [True, False])
def test_pdf_mapping_requests_at_most_one_model_correction_for_measured_label_overlap(monkeypatch, corrected):
    from unittest.mock import AsyncMock
    from app.application_preparation import document_pipeline
    from app.application_preparation.document_contract import MapDocumentRequest, MappingSelection
    req = MapDocumentRequest(**request(format="pdf").model_dump(exclude={"facts"}),
        fields=[{"id": "office", "label": "(사무실)", "guidance": "", "required": False}])
    document = DocumentMap(sourceSha256=req.sourceSha256, format="pdf", engineVersion="test", targets=[
        NativeTarget(targetId="page-0", kind="PDF_PAGE", currentText="", nativeLocator={"printedTextRegions": [
            {"text": "(사무실)", "box": {"x": 0.68, "y": 0.21, "width": 0.08, "height": 0.015}}]})])
    monkeypatch.setattr(document_pipeline, "inspect_document", AsyncMock(return_value=document))
    calls = []
    class Agent:
        async def map_document(self, request, doc, **repair):
            calls.append(repair)
            if len(calls) == 2:
                assert repair["rejection_reason"] == "MAPPING_BOX_COVERS_PRINTED_LABEL"
                assert repair["rejected_output"].bindings[0].box.x == 0.67
            return MappingSelection(bindings=[{"factId": "office", "targetId": "page-0",
                "box": {"x": 0.78 if corrected and len(calls) == 2 else 0.67, "y": 0.205, "width": 0.1, "height": 0.025}}],
                scopeTargetIds=["page-0"], unmappedFieldIds=[])
    if corrected:
        result = asyncio.run(document_pipeline.map_document(req, Agent()))
        assert result["bindings"][0]["box"]["x"] == 0.78
    else:
        with pytest.raises(DocumentError) as error:
            asyncio.run(document_pipeline.map_document(req, Agent()))
        assert error.value.reason == "MAPPING_BOX_COVERS_PRINTED_LABEL"
    assert len(calls) == 2


def test_plan_schema_cannot_report_unprovided_consent_or_signature_as_missing(monkeypatch):
    import json
    from pydantic import ValidationError
    from app.application_preparation.agent import ApplicationPreparationAgent
    req = request(scopeTargetIds=["input"])
    doc = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test",
        targets=[target("input"), target("other-form", "다른 서식")])
    async def invoke(selection_type, _instructions, content, *_args, **_kwargs):
        prompt = json.loads(content[0]["text"])
        assert [t["targetId"] for t in prompt["documentMap"]["targets"]] == ["input"]
        assert prompt["documentMap"]["targets"][0]["currentTextLength"] == 0
        for missing in ("consent", "signature", "신청일이 없습니다"):
            with pytest.raises(ValidationError):
                selection_type.model_validate({"operations": [], "scopeTargetIds": ["input"], "unresolvedTargets": [missing]})
        valid = {"operations": [operation("input").model_dump()], "scopeTargetIds": ["input", "input"], "unresolvedTargets": []}
        with pytest.raises(ValidationError):
            selection_type.model_validate({**valid, "operations": [{**valid["operations"][0], "valueRef": "invented"}]})
        return selection_type.model_validate(valid)
    agent = ApplicationPreparationAgent(model=None, run_timeout_seconds=1)
    monkeypatch.setattr(agent, "_invoke", invoke)
    result = asyncio.run(agent.plan_document(req, doc))
    assert result.scopeTargetIds == ["input"]
    assert result.operations[0].valueRef == "company:name"


def test_pdf_page_is_an_empty_new_field_slot_with_read_only_page_text(monkeypatch, tmp_path):
    from contextlib import asynccontextmanager
    from app.application_preparation import document_adapters
    source = b"%PDF-synthetic parser boundary fixture"
    req = request(format="pdf", sourceBase64=base64.b64encode(source).decode(), sourceSha256=digest(source),
        pageImages=[base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()],
        pdfTargets=[{"id": "page-0", "text": "원본 회사명 라벨", "context": "page 1"}])
    responses = {"pdf_get_text": {"page_count": 1, "text": "원본 회사명 라벨"},
        "govbiz_pdf_text_regions": {"page_count": 1, "pages": [{"page": 0, "regions": [], "blankRegions": [
            {"id": "cell-1", "labels": ["회사명"], "box": {"x": .5, "y": .1, "width": .2, "height": .1}}]}]},
        "govbiz_pdf_detect_inputs": {"page_count": 1, "modelSha256": document_adapters.MODEL_SHA256,
            "pages": [{"page": 0, "detections": [{"kind": 0, "confidence": .8,
                "box": {"x": .5, "y": .1, "width": .2, "height": .1}}]}]},
        "pdf_get_text_layout": {"blocks": [{}]}, "pdf_detect_paragraphs": {"paragraphs": []}}
    @asynccontextmanager
    async def session(kind, directory):
        async def call(name, args): return responses[name]
        yield SimpleNamespace(call=call)
    monkeypatch.setattr(document_adapters, "document_session", session)
    path = tmp_path / "source.pdf"
    path.write_bytes(source)
    doc = asyncio.run(document_adapters.PdfDocumentAdapter().inspect(path, req))
    assert doc.targets[0].currentText == ""
    assert doc.targets[0].nativeLocator["pageText"] == "원본 회사명 라벨"
    assert not doc.targets[0].editable
    selection = PlanSelection(operations=[operation("pdf-blank:0:ffdetr-0", operation="set_field")],
        scopeTargetIds=["pdf-blank:0:ffdetr-0"], unresolvedTargets=[])
    validate_plan(req, doc, selection)


def test_hwp_mapping_preserves_authoritative_core_table_context(monkeypatch):
    import json
    from app.application_preparation.agent import ApplicationPreparationAgent
    from app.application_preparation.document_contract import MapDocumentRequest
    from app.application_preparation.document_adapters import HwpDocumentAdapter
    req = MapDocumentRequest(**hwp_request().model_dump(exclude={"facts"}),
        fields=[{"id": "company:name", "label": "회사명", "guidance": "", "required": False}])
    async def invoke(selection_type, _instructions, content, *_args, **_kwargs):
        target = json.loads(content[0]["text"])["documentMap"]["targets"][0]
        assert target["context"] == req.hwpTargets[0].context
        return selection_type.model_validate({"bindings": [], "scopeTargetIds": [], "unmappedFieldIds": ["company:name"]})
    agent = ApplicationPreparationAgent(model=None, run_timeout_seconds=1)
    monkeypatch.setattr(agent, "_invoke", invoke)
    asyncio.run(agent.map_document(req, HwpDocumentAdapter().inspect(req)))


def test_pdf_blank_regions_require_closed_edges_and_never_cover_printed_labels():
    from app.application_preparation.pdf_mcp_extension import pdf_blank_regions
    segments = [(x,.1,x,.5) for x in [.1,.4,.9]] + [(.1,y,.9,y) for y in [.1,.3,.5]]
    words = [{"text":text,"box":{"x":x,"y":y,"width":.08,"height":.025}}
             for text,x,y in [("기업명",.2,.17),("연락처",.2,.38),("사무실",.45,.33),("휴대폰",.45,.43)]]
    regions = pdf_blank_regions(segments,words,1000,1000)
    assert {tuple(r['labels']) for r in regions} == {('기업명',),('사무실',),('휴대폰',)}
    from app.application_preparation.document import DocumentBox
    assert all(not DocumentBox(**r['box']).overlaps(DocumentBox(**w['box'])) for r in regions for w in words)
    assert pdf_blank_regions([s for s in segments if s[0] != .9],words,1000,1000) == []


def test_acroform_native_field_names_constrain_mapping(monkeypatch, tmp_path):
    from contextlib import asynccontextmanager
    from app.application_preparation import document_adapters
    from app.application_preparation.document_contract import MapDocumentRequest, MappingSelection, mapping_label_matches, validate_mapping
    source = b"%PDF-test"
    fields = [{"id": f"pdf-field:{name}", "text": "", "context": f"{name} | type=Tx"}
              for name in ("First Name", "Last Name")]
    req = MapDocumentRequest(sourceBase64=base64.b64encode(source).decode(), sourceSha256=digest(source),
        format="pdf", scope="Authorized Representative", fields=[
            {"id": "representative:first", "label": "First Name", "guidance": "", "required": False}],
        pdfTargets=fields, pageImages=[base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()],
        pdfFields=[{"targetId": item["id"], "fieldType": "PDTextField", "editable": True,
                    "widgets": [{"page": 0}], "options": []} for item in fields])
    replies = {"pdf_get_text": {"page_count": 1, "text": "First Name Last Name"},
        "govbiz_pdf_text_regions": {"page_count": 1, "pages": [{"page": 0, "regions": [], "blankRegions": []}]},
        "pdf_get_text_layout": {"blocks": [{}]}, "pdf_detect_paragraphs": {"paragraphs": []}}
    @asynccontextmanager
    async def session(_kind, _directory):
        yield SimpleNamespace(call=lambda name, _args: asyncio.sleep(0, result=replies[name]))
    monkeypatch.setattr(document_adapters, "document_session", session)
    path = tmp_path / "source.pdf"
    path.write_bytes(source)
    doc = asyncio.run(document_adapters.PdfDocumentAdapter().inspect(path, req))
    by_id = {target.targetId: target for target in doc.targets}
    assert by_id["pdf-field:First Name"].nativeLocator["fieldLabels"] == ["First Name"]
    assert mapping_label_matches("First Name", by_id["pdf-field:First Name"])
    assert not mapping_label_matches("First Name", by_id["pdf-field:Last Name"])
    with pytest.raises(DocumentError) as error:
        validate_mapping(req, doc, MappingSelection(bindings=[
            {"factId": "representative:first", "targetId": "pdf-field:Last Name", "box": None}],
            scopeTargetIds=["pdf-field:Last Name"], unmappedFieldIds=[]))
    assert error.value.reason == "FIELD_LABEL_MISMATCH"


def test_acroform_mapping_scope_is_derived_from_selected_native_fields(monkeypatch):
    from app.application_preparation.agent import ApplicationPreparationAgent
    from app.application_preparation.document_contract import MapDocumentRequest, validate_mapping

    req = MapDocumentRequest(**{**request(format="pdf").model_dump(exclude={"facts"}),
        "fields": [{"id": "company:name", "label": "Company Name", "guidance": "", "required": False}],
        "pdfFields": [{"targetId": "pdf-field:Company Name", "fieldType": "PDTextField",
                       "editable": True, "options": [], "widgets": [{"page": 0}]}]})
    doc = DocumentMap(sourceSha256=req.sourceSha256, format="pdf", engineVersion="test", targets=[
        NativeTarget(targetId="pdf-field:Company Name", kind="PDF_FIELD", currentText="",
                     nativeLocator={"fieldLabels": ["Company Name"]})])

    async def invoke(selection_type, *_args, **_kwargs):
        return selection_type.model_validate({"bindings": [{"factId": "company:name",
            "targetId": "pdf-field:Company Name", "box": None}],
            "scopeTargetIds": [], "unmappedFieldIds": []})

    agent = ApplicationPreparationAgent(model=None, run_timeout_seconds=1)
    monkeypatch.setattr(agent, "_invoke", invoke)
    selection = asyncio.run(agent.map_document(req, doc))
    assert selection.scopeTargetIds == ["pdf-field:Company Name"]
    validate_mapping(req, doc, selection)


def test_native_pdf_field_write_contract_uses_saved_binding_and_exact_current_text(monkeypatch):
    from unittest.mock import AsyncMock
    from app.application_preparation import document_pipeline
    from app.application_preparation.document_adapters import PdfDocumentAdapter

    binding = {"factId": "company:name", "targetId": "pdf-field:Company Name", "box": None}
    req = request(format="pdf", bindings=[binding], scopeTargetIds=[binding["targetId"]])
    doc = DocumentMap(sourceSha256=req.sourceSha256, format="pdf", engineVersion="test", targets=[
        NativeTarget(targetId=binding["targetId"], kind="PDF_FIELD", currentText="old", nativeLocator={})])
    monkeypatch.setattr(document_pipeline, "inspect_document", AsyncMock(return_value=doc))
    monkeypatch.setattr(PdfDocumentAdapter, "apply", AsyncMock(return_value=(base64.b64decode(req.sourceBase64),
        {"stage": "PDFBOX_REQUIRED", "placements": [binding]})))
    agent = SimpleNamespace(plan_document=AsyncMock(side_effect=AssertionError("native field plan is deterministic")))
    result = asyncio.run(document_pipeline.generate_document(req, agent))
    agent.plan_document.assert_not_awaited()
    op = result["writePlan"]["operations"][0]
    assert (op["operation"], op["expectedText"], op["start"], op["end"], op["box"]) == (
        "set_field", "old", 0, 3, None)
    changed = PlanSelection(operations=[EditOperation.model_validate({**op, "end": 4})],
                            unresolvedTargets=[], scopeTargetIds=[binding["targetId"]])
    with pytest.raises(DocumentError) as error:
        validate_plan(req, doc, changed)
    assert error.value.reason == "INVALID_TEXT_RANGE"
    other = NativeTarget(targetId="pdf-field:Other", kind="PDF_FIELD", currentText="", nativeLocator={})
    with pytest.raises(DocumentError) as error:
        validate_plan(req.model_copy(update={"scopeTargetIds": [binding["targetId"], other.targetId]}),
            doc.model_copy(update={"targets": [*doc.targets, other]}),
            PlanSelection(operations=[EditOperation(targetId=other.targetId, operation="set_field",
                expectedText="", start=0, end=0, valueRef="company:name", box=None, reason="test")],
                unresolvedTargets=[], scopeTargetIds=[other.targetId]))
    assert error.value.reason == "SAVED_BINDING_CHANGED"


def test_pdf_field_and_page_box_contracts_remain_distinct():
    from app.application_preparation.document import DocumentBox
    req = request(format="pdf")
    field = NativeTarget(targetId="pdf-field:Name", kind="PDF_FIELD", currentText="", nativeLocator={})
    page = NativeTarget(targetId="page-0", kind="PDF_PAGE", currentText="", nativeLocator={})
    slot = NativeTarget(targetId="pdf-blank:0:ffdetr-0", kind="PDF_INPUT", currentText="", nativeLocator={})
    doc = DocumentMap(sourceSha256=req.sourceSha256, format="pdf", engineVersion="test", targets=[field, page, slot])
    box = DocumentBox(x=.1, y=.1, width=.2, height=.1)
    for target_id, wrong_box in ((field.targetId, box), (page.targetId, None)):
        with pytest.raises(DocumentError) as error:
            validate_plan(req, doc, PlanSelection(operations=[EditOperation(targetId=target_id,
                operation="set_field", expectedText="", start=0, end=0, valueRef="company:name",
                box=wrong_box, reason="test")], unresolvedTargets=[], scopeTargetIds=[target_id]))
        assert error.value.code == "APPLICATION_DOCUMENT_MAPPING_FAILED"
    validate_plan(req, doc, PlanSelection(operations=[EditOperation(targetId=slot.targetId,
        operation="set_field", expectedText="", start=0, end=0, valueRef="company:name",
        box=None, reason="measured input slot")], unresolvedTargets=[], scopeTargetIds=[slot.targetId]))


@pytest.mark.parametrize('required',[False,True])
def test_unmapped_optional_field_is_explicit_and_required_field_still_fails(required):
    from app.application_preparation.document_contract import MapDocumentRequest,MappingSelection,validate_mapping
    req=MapDocumentRequest(**request().model_dump(exclude={'facts'}),fields=[
        {'id':'company:name','label':'기업명','guidance':'','required':True},
        {'id':'consent','label':'동의','guidance':'','required':required}])
    doc=DocumentMap(sourceSha256=req.sourceSha256,format='hwpx',engineVersion='test',targets=[target()])
    selection=MappingSelection(bindings=[{'factId':'company:name','targetId':'t1.r1.c2','box':None}],scopeTargetIds=['t1.r1.c2'],unmappedFieldIds=['consent'])
    if required:
        with pytest.raises(DocumentError) as error: validate_mapping(req,doc,selection)
        assert error.value.reason == 'UNMAPPED_REQUIRED_FIELDS'
    else: validate_mapping(req,doc,selection)


def test_provided_unmapped_answer_is_not_silently_omitted(monkeypatch):
    from unittest.mock import AsyncMock
    from app.application_preparation.document_pipeline import generate_document
    req=request(bindings=[{'factId':'other','targetId':'t1.r1.c2','box':None}])
    agent=SimpleNamespace(plan_document=AsyncMock())
    with pytest.raises(DocumentError) as error: asyncio.run(generate_document(req,agent))
    assert error.value.code == 'APPLICATION_DOCUMENT_UNMAPPED_INPUT'
    agent.plan_document.assert_not_awaited()


def test_table_column_semantics_rejects_name_in_position_cell():
    from app.application_preparation.document_contract import MapDocumentRequest,MappingSelection,validate_mapping
    req=MapDocumentRequest(**request().model_dump(exclude={'facts'}),fields=[{'id':'staff:name','label':'기술인력 / 성명','guidance':'','required':False}])
    doc=DocumentMap(sourceSha256=req.sourceSha256,format='hwpx',engineVersion='test',targets=[
        NativeTarget(targetId='position',nativeLocator={'fieldLabels':['직위']},kind='paragraph',currentText=''),
        NativeTarget(targetId='name',nativeLocator={'fieldLabels':['성명']},kind='paragraph',currentText='')])
    for key in ('position','name'):
        selection=MappingSelection(bindings=[{'factId':'staff:name','targetId':key,'box':None}],scopeTargetIds=[key],unmappedFieldIds=[])
        if key=='position':
            with pytest.raises(DocumentError) as error:validate_mapping(req,doc,selection)
            assert error.value.reason=='FIELD_LABEL_MISMATCH'
        else:validate_mapping(req,doc,selection)


def test_calendar_date_spelling_matches_the_same_native_year_month_day_column():
    from app.application_preparation.document_contract import MapDocumentRequest, MappingSelection, validate_mapping
    req = MapDocumentRequest(**request().model_dump(exclude={"facts"}), fields=[
        {"id": "history:date", "label": "기업체 연혁 / 연월일", "guidance": "", "required": False}])
    doc = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test", targets=[
        NativeTarget(targetId="date", nativeLocator={"fieldLabels": ["년  월  일"]}, kind="paragraph", currentText="")])
    validate_mapping(req, doc, MappingSelection(bindings=[{"factId": "history:date", "targetId": "date", "box": None}],
                                               scopeTargetIds=["date"], unmappedFieldIds=[]))


def test_sales_grid_requires_both_named_row_and_year_column():
    from app.application_preparation.document_contract import mapping_label_matches
    cell = NativeTarget(targetId="sales", nativeLocator={"fieldLabels": ["국 내 판 매", "2023"],
                        "rowLabels": ["국 내 판 매"]}, kind="paragraph", currentText="")
    assert mapping_label_matches("판매실적 / 국내판매 2023", cell)
    assert not mapping_label_matches("판매실적 / 국내판매 2024", cell)
    assert not mapping_label_matches("판매실적 / 수출실적 2023", cell)
    assert not mapping_label_matches("판매실적 / 2023", cell)
    assert mapping_label_matches("판매실적 / 2023", cell, "국내판매 행의 2023년 금액을 입력하세요.")
    assert not mapping_label_matches("판매실적 / 2023", cell, "수출실적 행의 2023년 금액을 입력하세요.")


def test_known_name_cell_cannot_be_bypassed_with_an_unlabelled_body_paragraph():
    from app.application_preparation.document_contract import MapDocumentRequest, MappingSelection, validate_mapping
    req = MapDocumentRequest(**request().model_dump(exclude={"facts"}), fields=[
        {"id": "staff:name", "label": "기술인력 / 성명", "guidance": "", "required": False}])
    doc = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test", targets=[
        NativeTarget(targetId="name", nativeLocator={"fieldLabels": ["성명"]}, kind="paragraph", currentText=""),
        NativeTarget(targetId="body", nativeLocator={}, kind="body_para", currentText="")])
    with pytest.raises(DocumentError) as error:
        validate_mapping(req, doc, MappingSelection(bindings=[{"factId": "staff:name", "targetId": "body", "box": None}],
                        scopeTargetIds=["name", "body"], unmappedFieldIds=[]))
    assert error.value.reason == "FIELD_LABEL_MISMATCH"


def test_nearby_unit_text_is_not_mistaken_for_a_read_only_question_heading(monkeypatch):
    from unittest.mock import AsyncMock
    from app.application_preparation import document_pipeline
    from app.application_preparation.document_contract import MapDocumentRequest, MappingSelection
    req = MapDocumentRequest(**request().model_dump(exclude={"facts"}), fields=[
        {"id": "company:employees", "label": "상시종업원", "guidance": "", "required": False}])
    doc = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test", targets=[
        NativeTarget(targetId="employees", nativeLocator={"fieldLabels": ["상시종업원"]}, kind="paragraph", currentText="    명 (남 ,여 )"),
        NativeTarget(targetId="nearby", nativeLocator={"fieldLabels": ["명 (남 ,여 )"]}, kind="paragraph", currentText="")])
    selection = MappingSelection(bindings=[{"factId": "company:employees", "targetId": "employees", "box": None}],
                                 scopeTargetIds=["employees"], unmappedFieldIds=[])
    monkeypatch.setattr(document_pipeline, "inspect_document", AsyncMock(return_value=doc))
    result = asyncio.run(document_pipeline.map_document(req, SimpleNamespace(map_document=AsyncMock(return_value=selection))))
    assert result["bindings"][0]["targetId"] == "employees"


def test_split_printed_label_paragraphs_cannot_become_mapping_targets(monkeypatch):
    from unittest.mock import AsyncMock
    from app.application_preparation import document_pipeline
    from app.application_preparation.document_contract import MapDocumentRequest, MappingSelection
    req = MapDocumentRequest(**request().model_dump(exclude={"facts"}), fields=[
        {"id": "company:representative", "label": "대표자성명", "guidance": "", "required": False},
        {"id": "company:registration", "label": "사업자등록번호", "guidance": "", "required": False}])
    doc = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test", targets=[
        NativeTarget(targetId="label-cell", kind="cell", currentText="사업자등록번호", nativeLocator={}),
        NativeTarget(targetId="label-p1", kind="paragraph", currentText="사업자",
                     nativeLocator={"parent": "label-cell", "fieldLabels": ["대표자성명"]}),
        NativeTarget(targetId="label-p2", kind="paragraph", currentText="등록번호",
                     nativeLocator={"parent": "label-cell", "fieldLabels": ["대표자성명"]}),
        NativeTarget(targetId="representative", kind="paragraph", currentText="",
                     nativeLocator={"fieldLabels": ["대표자성명"]}),
        NativeTarget(targetId="registration", kind="paragraph", currentText="",
                     nativeLocator={"fieldLabels": ["사업자등록번호"]})])
    selection = MappingSelection(bindings=[
        {"factId": "company:representative", "targetId": "representative", "box": None},
        {"factId": "company:registration", "targetId": "registration", "box": None}],
        scopeTargetIds=["representative", "registration"], unmappedFieldIds=[])
    async def choose(_request, document, **_repair):
        by_id = {target.targetId: target for target in document.targets}
        assert not by_id["label-p1"].editable and not by_id["label-p2"].editable
        assert by_id["representative"].editable and by_id["registration"].editable
        return selection
    monkeypatch.setattr(document_pipeline, "inspect_document", AsyncMock(return_value=doc))
    result = asyncio.run(document_pipeline.map_document(req, SimpleNamespace(map_document=choose)))
    assert {binding["targetId"] for binding in result["bindings"]} == {"representative", "registration"}


def test_large_hwpx_mapping_sends_only_all_native_label_candidates(monkeypatch):
    import json
    from unittest.mock import AsyncMock
    from app.application_preparation import document_pipeline
    from app.application_preparation.agent import ApplicationPreparationAgent
    from app.application_preparation.document_contract import MapDocumentRequest
    req = MapDocumentRequest(**request().model_dump(exclude={"facts"}), fields=[
        {"id": "company:name", "label": "기업명", "guidance": "", "required": False}])
    candidates = [NativeTarget(targetId=name, kind="paragraph", currentText="",
        nativeLocator={"fieldLabels": ["기업명"], "bindingEligible": True})
        for name in ("t1.r1.c1.p1", "t2.r1.c1.p1")]
    filler = [NativeTarget(targetId=f"b{i}", kind="body_para", currentText="x" * 5200,
                           nativeLocator={}) for i in range(80)]
    doc = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test",
                      targets=[*candidates, *filler])
    monkeypatch.setattr(document_pipeline.HwpxDocumentAdapter, "inspect", AsyncMock(return_value=doc))
    monkeypatch.setattr(document_pipeline, "assist_with_kordoc", AsyncMock())
    inspected = asyncio.run(document_pipeline.inspect_document(Path("unused.hwpx"), req))
    agent = ApplicationPreparationAgent(model=None, run_timeout_seconds=1)

    async def invoke(selection_type, _instructions, content, *_args, **_kwargs):
        payload = json.loads(content[0]["text"])
        assert {item["targetId"] for item in payload["documentMap"]["targets"]} == {
            candidate.targetId for candidate in candidates}
        assert set(payload["fieldCandidates"]["company:name"]) == {
            candidate.targetId for candidate in candidates}
        assert len(content[0]["text"]) < 400000
        return selection_type.model_validate({"assignments": {"company:name": {"targetId": candidates[0].targetId}},
                                              "scope": {candidate.targetId: True for candidate in candidates}})

    monkeypatch.setattr(agent, "_invoke", invoke)
    selection = asyncio.run(agent.map_document(req, inspected))
    assert selection.bindings[0].targetId == candidates[0].targetId
    assert set(selection.scopeTargetIds) == {candidate.targetId for candidate in candidates}


def test_large_hwpx_without_a_labeled_candidate_fails_before_model(monkeypatch):
    from unittest.mock import AsyncMock
    from app.application_preparation import document_pipeline
    from app.application_preparation.document_contract import MapDocumentRequest
    req = MapDocumentRequest(**request().model_dump(exclude={"facts"}), fields=[
        {"id": "company:name", "label": "기업명", "guidance": "", "required": False}])
    doc = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test",
        targets=[NativeTarget(targetId=f"b{i}", kind="body_para", currentText="x" * 5200,
                              nativeLocator={}) for i in range(80)])
    monkeypatch.setattr(document_pipeline.HwpxDocumentAdapter, "inspect", AsyncMock(return_value=doc))
    with pytest.raises(DocumentError) as error:
        asyncio.run(document_pipeline.inspect_document(Path("unused.hwpx"), req))
    assert error.value.reason == "HWPX_MAPPING_CANDIDATE_MISSING"


def test_compound_table_question_requires_reanalysis_before_calling_model(monkeypatch):
    from unittest.mock import AsyncMock
    from app.application_preparation import document_pipeline
    from app.application_preparation.document_contract import MapDocumentRequest
    req=MapDocumentRequest(**request().model_dump(exclude={'facts'}),fields=[{'id':'staff','label':'기술인력 보유현황','guidance':'직위와 성명','required':False}])
    doc=DocumentMap(sourceSha256=req.sourceSha256,format='hwpx',engineVersion='test',targets=[
        NativeTarget(targetId='position',nativeLocator={'tableHeadings':['기술인력 보유현황'],'columnLabels':['직위','성명']},kind='paragraph',currentText='')])
    monkeypatch.setattr(document_pipeline,'inspect_document',AsyncMock(return_value=doc))
    agent=SimpleNamespace(map_document=AsyncMock())
    with pytest.raises(DocumentError) as error:asyncio.run(document_pipeline.map_document(req,agent))
    assert error.value.code=='APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED'
    agent.map_document.assert_not_awaited()


def test_hwpx_context_uses_mcp_table_spans_and_column_evidence():
    from app.application_preparation.hwpx_form_analysis import table_contexts
    def cell(row, col, text, rows=1, cols=1):
        return {"field_id": f"t1.r{row}.c{col}", "row": row, "col": col, "text": text,
                "row_span": rows, "col_span": cols, "is_empty": not text}
    tables = [{"index": 1, "cells": [cell(0, 0, "직위", rows=2), cell(0, 1, "성명", rows=2),
                                     cell(2, 0, ""), cell(2, 1, "")]}]
    fields = [{"field_id": "t1.r2.c0", "label": "직위", "kind": "empty_cell"},
              {"field_id": "t1.r2.c1", "label": "성명", "kind": "empty_cell"},
              {"field_id": "b1", "label": "본문", "kind": "body_para"}]
    contexts = table_contexts(tables, fields)
    assert contexts["t1.r2.c0"]["fieldLabels"] == ["직위"]
    assert contexts["t1.r2.c1"]["fieldLabels"] == ["성명"]
    assert contexts["t1.r2.c1"]["labelCells"] == [{"targetId": "t1.r0.c1", "text": "성명"}]
    assert contexts["t1.r2.c0"]["tableClassification"] == "FORM_TABLE"
    assert contexts["t1.r2.c0"]["bindingEligible"] is True
    assert "b1" not in contexts


def test_hwpx_only_printed_blank_slot_excludes_empty_sibling_from_mapping(monkeypatch, tmp_path):
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock
    from app.application_preparation import document_adapters
    from app.application_preparation.agent import ApplicationPreparationAgent
    from app.application_preparation.document_contract import MapDocumentRequest, MappingSelection, validate_mapping

    source = b"synthetic hwpx source"
    path = tmp_path / "source.hwpx"
    path.write_bytes(source)
    cell_id = "t3.r2.c2"
    blank_id, slot_id = cell_id + ".p1", cell_id + ".p2"
    region = {"target": cell_id, "kind": "cell", "section": "Contents/section0.xml", "table": 3,
              "row": 2, "col": 2, "paragraph_count": 2, "text": "(     )", "editable": True,
              "paragraphs": [{"target": blank_id, "text": "", "marker": ""},
                             {"target": slot_id, "text": "(     )", "marker": ""}]}
    context = {"sourceCellText": "(     )", "rowLabels": ["담당자"], "fieldLabels": ["담당자"],
               "formFields": [], "bindingEligible": True}

    @asynccontextmanager
    async def session(_kind, _directory):
        yield SimpleNamespace(call=AsyncMock(return_value={"source_sha256": digest(source),
                                               "regions": [region], "unsupported_controls": []}))

    monkeypatch.setattr(document_adapters, "validate_hwpx", lambda _path: None)
    monkeypatch.setattr(document_adapters, "document_session", session)
    monkeypatch.setattr(document_adapters, "analyze_cells", AsyncMock(return_value={cell_id: context}))
    document = asyncio.run(document_adapters.HwpxDocumentAdapter().inspect(path))
    by_id = {item.targetId: item for item in document.targets}
    assert [item.targetId for item in document.targets] == [cell_id, blank_id, slot_id]
    assert by_id[blank_id].nativeLocator["parent"] == by_id[slot_id].nativeLocator["parent"] == cell_id
    assert by_id[blank_id].nativeLocator["target"] == blank_id
    assert by_id[slot_id].nativeLocator["target"] == slot_id
    assert by_id[blank_id].nativeLocator["bindingEligible"] is False
    assert by_id[slot_id].nativeLocator["bindingEligible"] is True
    assert by_id[blank_id].editable and by_id[slot_id].editable

    mapping = MapDocumentRequest(sourceBase64=base64.b64encode(source).decode(), sourceSha256=digest(source),
        format="hwpx", scope="신청서", fields=[{"id": "staff:name", "label": "담당자", "guidance": "", "required": True}])
    invalid = MappingSelection(bindings=[{"factId": "staff:name", "targetId": blank_id, "box": None}],
                               scopeTargetIds=[blank_id, slot_id], unmappedFieldIds=[])
    with pytest.raises(DocumentError, match="APPLICATION_DOCUMENT_MAPPING_FAILED"):
        validate_mapping(mapping, document, invalid)
    valid = MappingSelection(bindings=[{"factId": "staff:name", "targetId": slot_id, "box": None}],
                             scopeTargetIds=[blank_id, slot_id], unmappedFieldIds=[])
    validate_mapping(mapping, document, valid)

    agent = ApplicationPreparationAgent(model=None, run_timeout_seconds=1)
    async def invoke(selection_type, _instructions, content, *_args, **_kwargs):
        payload = __import__("json").loads(content[0]["text"])
        assert payload["fieldCandidates"] == {"staff:name": [slot_id]}
        return selection_type.model_validate({"assignments": {"staff:name": {"targetId": slot_id}},
                                              "scope": {blank_id: True, slot_id: True}})
    monkeypatch.setattr(agent, "_invoke", invoke)
    assert asyncio.run(agent.map_document(mapping, document)).bindings[0].targetId == slot_id

    write = request(sourceBase64=base64.b64encode(source).decode(), sourceSha256=digest(source),
                    bindings=[{"factId": "company:name", "targetId": slot_id, "box": None}])
    plan = validate_plan(write, document, PlanSelection(operations=[operation(slot_id,
        operation="replace_range", expectedText="(     )", start=1, end=6)],
        scopeTargetIds=[blank_id, slot_id], unresolvedTargets=[]))
    assert plan.operations[0].targetId == slot_id
    old_binding = request(sourceBase64=base64.b64encode(source).decode(), sourceSha256=digest(source),
                          bindings=[{"factId": "company:name", "targetId": blank_id, "box": None}])
    with pytest.raises(DocumentError) as stale:
        validate_plan(old_binding, document, PlanSelection(operations=[operation(blank_id)],
            scopeTargetIds=[blank_id, slot_id], unresolvedTargets=[]))
    assert stale.value.reason == "SAVED_BINDING_CHANGED"
    with pytest.raises(DocumentError):
        validate_plan(write, document, PlanSelection(operations=[operation("logical:" + cell_id)],
            scopeTargetIds=[blank_id, slot_id], unresolvedTargets=[]))


def test_hwpx_paragraph_eligibility_preserves_ambiguous_cells():
    from app.application_preparation.document_adapters import _explicit_hwpx_input_paragraph

    base = {"kind": "cell", "editable": True, "paragraph_count": 2, "text": "",
            "paragraphs": [{"target": "cell.p1", "text": "", "marker": ""},
                           {"target": "cell.p2", "text": "", "marker": ""}]}
    context = {"rowLabels": ["항목"], "formFields": []}
    assert _explicit_hwpx_input_paragraph(base, context) is None
    base["paragraphs"][1]["text"] = "예시 설명"
    base["text"] = "예시 설명"
    assert _explicit_hwpx_input_paragraph(base, context) is None
    base["paragraphs"][1]["text"] = "(    )"
    base["text"] = "(    )"
    assert _explicit_hwpx_input_paragraph(base, {**context, "formFields": [{"field_id": "cell"}]}) is None
    assert _explicit_hwpx_input_paragraph(base, {**context, "rowLabels": []}) is None
    base["paragraphs"] = [{"target": "cell.p1", "text": "(    )", "marker": ""},
                          {"target": "cell.p2", "text": "", "marker": ""}]
    assert _explicit_hwpx_input_paragraph(base, context) == "cell.p1"
    base["paragraphs"][1]["text"] = "(   )"
    base["text"] = "(    )(   )"
    assert _explicit_hwpx_input_paragraph(base, context) is None


def test_table_gate_excludes_only_confident_layout_and_preserves_ambiguous_cells():
    from app.application_preparation.hwpx_form_analysis import table_contexts

    layout = [{"index": 1, "cells": [
        {"field_id": "t1.r0.c0", "row": 0, "col": 0, "text": "신청", "row_span": 1, "col_span": 1, "is_empty": False},
        {"field_id": "t1.r0.c1", "row": 0, "col": 1, "text": "→ 평가 → 선정", "row_span": 1, "col_span": 1, "is_empty": False},
    ]}]
    layout_contexts = table_contexts(layout, [])
    assert set(layout_contexts) == {"t1.r0.c0", "t1.r0.c1"}
    assert {item["tableClassification"] for item in layout_contexts.values()} == {"LAYOUT_TABLE"}
    assert all(item["bindingEligible"] is False for item in layout_contexts.values())

    ambiguous = [{"index": 2, "cells": [
        {"field_id": "t2.r0.c0", "row": 0, "col": 0, "text": "기업명", "row_span": 1, "col_span": 1, "is_empty": False},
        {"field_id": "t2.r0.c1", "row": 0, "col": 1, "text": "", "row_span": 1, "col_span": 1, "is_empty": True},
    ]}]
    ambiguous_contexts = table_contexts(ambiguous, [])
    assert set(ambiguous_contexts) == {"t2.r0.c0", "t2.r0.c1"}
    assert {item["tableClassification"] for item in ambiguous_contexts.values()} == {"AMBIGUOUS"}
    assert all(item["bindingEligible"] is True for item in ambiguous_contexts.values())
    assert all(item["tableClassificationReviewRequired"] is True for item in ambiguous_contexts.values())


def test_numbered_section_banner_spacers_are_not_treated_as_form_inputs():
    from app.application_preparation.hwpx_form_analysis import table_contexts

    cells = [
        {"field_id": "t1.r0.c0", "row": 0, "col": 0, "text": "1", "row_span": 1, "col_span": 1, "is_empty": False},
        {"field_id": "t1.r0.c1", "row": 0, "col": 1, "text": "", "row_span": 1, "col_span": 1, "is_empty": True},
        {"field_id": "t1.r0.c2", "row": 0, "col": 2, "text": "사업개요", "row_span": 1, "col_span": 1, "is_empty": False},
        {"field_id": "t1.r0.c3", "row": 0, "col": 3, "text": "", "row_span": 2, "col_span": 1, "is_empty": True},
        {"field_id": "t1.r1.c3", "row": 1, "col": 3, "text": "", "row_span": 1, "col_span": 1, "is_empty": True},
    ]
    fields = [
        {"field_id": "t1.r0.c1", "label": "1", "kind": "empty_cell", "capacity_hint": 0},
        {"field_id": "t1.r0.c3", "label": "사업개요", "kind": "empty_cell", "capacity_hint": 1},
    ]
    contexts = table_contexts([{"index": 1, "cells": cells}], fields)
    assert {item["tableClassification"] for item in contexts.values()} == {"LAYOUT_TABLE"}
    assert {item["tableClassificationConfidence"] for item in contexts.values()} == {0.98}
    assert all(item["bindingEligible"] is False for item in contexts.values())
    assert {tuple(item["tableClassificationEvidence"]) for item in contexts.values()} == {
        ("numbered_section_banner", "empty_spacer_fields"),
    }


def test_reading_order_metadata_never_changes_hwp_native_targets(tmp_path):
    from app.application_preparation.document import DocumentTarget
    from app.application_preparation.document_pipeline import inspect_document

    req = hwp_request()
    req.hwpTargets = [
        DocumentTarget(id="s0-p9", text="첫 문단", context="신청서"),
        DocumentTarget(id="s2-t1-r0-c1-p3", text="둘째 문단", context="기업 현황"),
    ]
    document = asyncio.run(inspect_document(tmp_path / "unused.hwp", req))
    assert [target.targetId for target in document.targets] == ["s0-p9", "s2-t1-r0-c1-p3"]
    assert [target.nativeLocator["paragraph"] for target in document.targets] == ["s0-p9", "s2-t1-r0-c1-p3"]
    assert [target.analysis.nativeOrderIndex for target in document.targets] == [0, 1]
    assert [target.analysis.semanticOrderIndex for target in document.targets] == [0, 1]
    assert [target.analysis.readingOrderIndex for target in document.targets] == [0, 1]
    assert all(target.analysis.readingOrderStatus == "PRESERVED" for target in document.targets)
    assert document.documentAnalysis.readingOrder.nativeTargetsChanged is False
    assert document.documentAnalysis.readingOrder.metrics == {
        "totalTargets": 2, "reorderedTargets": 0, "reviewRequiredTargets": 0, "preservedTargets": 2,
    }


def test_hwpx_semantic_order_corrects_only_simple_local_label_input_pair():
    from copy import deepcopy
    from app.application_preparation.hwpx_form_analysis import annotate_semantic_reading_order

    input_locator = {"table": 1, "row": 0, "col": 1, "rowSpan": 1, "colSpan": 1,
                     "fieldLabels": ["기업명"], "formFields": [{"field_id": "t1.r0.c1"}],
                     "labelCells": [{"targetId": "t1.r0.c0", "text": "기업명"}]}
    label_locator = {"table": 1, "row": 0, "col": 0, "rowSpan": 1, "colSpan": 1,
                     "fieldLabels": [], "formFields": [], "labelCells": []}
    targets = [
        NativeTarget(targetId="t1.r0.c1", nativeLocator=input_locator, kind="cell", currentText="",
                     analysis={"tableClassification": "FORM_TABLE"}),
        NativeTarget(targetId="t1.r0.c0", nativeLocator=label_locator, kind="cell", currentText="기업명",
                     analysis={"tableClassification": "FORM_TABLE"}),
    ]
    original_ids = [target.targetId for target in targets]
    original_locators = deepcopy([target.nativeLocator for target in targets])
    annotate_semantic_reading_order(targets)
    assert [target.targetId for target in targets] == original_ids
    assert [target.nativeLocator for target in targets] == original_locators
    assert [target.analysis.nativeOrderIndex for target in targets] == [0, 1]
    assert [target.analysis.semanticOrderIndex for target in targets] == [1, 0]
    assert all(target.analysis.readingOrderStatus == "LOCAL_REORDERED" for target in targets)


def test_hwpx_semantic_order_preserves_merged_or_repeated_form_structure():
    from app.application_preparation.hwpx_form_analysis import annotate_semantic_reading_order

    targets = [
        NativeTarget(targetId="t1.r0.c1", nativeLocator={"table": 1, "row": 0, "col": 1,
            "rowSpan": 1, "colSpan": 2, "fieldLabels": ["기업명"],
            "formFields": [{"field_id": "t1.r0.c1"}],
            "labelCells": [{"targetId": "t1.r0.c0", "text": "기업명"}]},
            kind="cell", currentText="", analysis={"tableClassification": "FORM_TABLE"}),
        NativeTarget(targetId="t1.r0.c0", nativeLocator={"table": 1, "row": 0, "col": 0,
            "rowSpan": 1, "colSpan": 1, "fieldLabels": [], "formFields": [], "labelCells": []},
            kind="cell", currentText="기업명", analysis={"tableClassification": "FORM_TABLE"}),
    ]
    annotate_semantic_reading_order(targets)
    assert [target.analysis.semanticOrderIndex for target in targets] == [0, 1]
    assert all(target.analysis.readingOrderStatus == "REVIEW_REQUIRED" for target in targets)
    assert {tuple(target.analysis.readingOrderReason) for target in targets} == {
        ("merged_or_duplicate_cell_structure",),
    }


def test_heading_metadata_is_scope_only_and_keeps_target_identity(monkeypatch):
    from app.application_preparation.hwpx_form_analysis import analyze_cells
    from unittest.mock import AsyncMock

    monkeypatch.setattr("app.application_preparation.hwpx_form_analysis.source_table_headings", lambda _path: {1: ["1. 기업 현황"]})
    cells = [
        {"field_id": "t1.r0.c0", "row": 0, "col": 0, "text": "기업명", "row_span": 1, "col_span": 1, "is_empty": False},
        {"field_id": "t1.r0.c1", "row": 0, "col": 1, "text": "", "row_span": 1, "col_span": 1, "is_empty": True},
    ]
    session = SimpleNamespace(call=AsyncMock(side_effect=[
        {"tables": [{"index": 1, "cells": cells}]},
        {"fields": [{"field_id": "t1.r0.c1", "label": "기업명", "kind": "empty_cell"}]},
    ]))
    result = asyncio.run(analyze_cells(session, Path("form.hwpx"), []))
    assert set(result) == {"t1.r0.c0", "t1.r0.c1"}
    assert result["t1.r0.c1"]["semanticSection"] == "1. 기업 현황"
    assert result["t1.r0.c1"]["headingConfidence"] == 0.95
    assert result["t1.r0.c1"]["headingStatus"] == "ACCEPTED"
    assert result["t1.r0.c1"]["sectionPath"] == ["1. 기업 현황"]
    assert "followed_by_form_table" in result["t1.r0.c1"]["headingReason"]


def test_heading_detector_uses_form_density_without_promoting_ordinary_short_text():
    from app.application_preparation.document_contract import mapping_label_key
    from app.application_preparation.hwpx_form_analysis import semantic_heading

    heading = "기업 현황"
    accepted = semantic_heading([heading], table_classification="FORM_TABLE", form_field_count=3,
                                occurrences={mapping_label_key(heading): 1})
    assert accepted[0] == heading
    assert accepted[3] == "ACCEPTED"
    assert "multiple_following_form_fields" in accepted[2]

    ordinary = "제출 서류는 다음과 같습니다."
    preserved = semantic_heading([ordinary], table_classification="FORM_TABLE", form_field_count=3,
                                 occurrences={mapping_label_key(ordinary): 1})
    assert preserved == (None, None, ["sentence_ending"], "PRESERVED")

    for non_heading in ("중소벤처기업부 장관", "* 별첨 3 참고", "◦ 기타 제출서류 각 1부"):
        rejected = semantic_heading([non_heading], table_classification="FORM_TABLE", form_field_count=3,
                                    occurrences={mapping_label_key(non_heading): 1})
        assert rejected == (None, None, ["note_bullet_or_signature"], "PRESERVED")

    preferred = semantic_heading(["Ⅰ. 기업 일반현황", "(단위:원)"], table_classification="FORM_TABLE",
                                 form_field_count=3, occurrences={mapping_label_key("Ⅰ. 기업 일반현황"): 1})
    assert preferred[0] == "Ⅰ. 기업 일반현황"
    assert preferred[3] == "ACCEPTED"
    for non_heading in ("(단위:백만원)", "서 초 구 청 장  귀 하"):
        rejected = semantic_heading([non_heading], table_classification="FORM_TABLE", form_field_count=3,
                                    occurrences={mapping_label_key(non_heading): 1})
        assert rejected == (None, None, ["note_bullet_or_signature"], "PRESERVED")

    ambiguous = "참고"
    weak = semantic_heading([ambiguous], table_classification="AMBIGUOUS", form_field_count=0,
                            occurrences={mapping_label_key(ambiguous): 1})
    assert weak[0] is None
    assert weak[3] == "PRESERVED"


def test_hwpx_label_search_preserves_ambiguity_instead_of_picking_first_cell(monkeypatch):
    from app.application_preparation.hwpx_form_analysis import analyze_cells
    monkeypatch.setattr("app.application_preparation.hwpx_form_analysis.source_table_headings", lambda _path: {1: ["인력 현황"]})
    from unittest.mock import AsyncMock
    cells = [{"field_id": f"t1.r{row}.c0", "row": row, "col": 0, "text": "성명" if row == 0 else "",
              "row_span": 1, "col_span": 1, "is_empty": row > 0} for row in range(3)]
    session = SimpleNamespace(call=AsyncMock(side_effect=[
        {"tables": [{"index": 1, "cells": cells}]},
        {"fields": [{"field_id": f"t1.r{row}.c0", "label": "성명", "kind": "empty_cell"} for row in (1, 2)]},
        {"state": "ambiguous_label", "candidate_field_ids": ["t1.r1.c0", "t1.r2.c0"]}]))
    result = asyncio.run(analyze_cells(session, Path("form.hwpx"), [SimpleNamespace(label="인력 / 성명")]))
    for row in (1, 2):
        assert result[f"t1.r{row}.c0"]["labelSearch"] == [{"label": "성명", "state": "ambiguous_label"}]
    assert [call.args[0] for call in session.call.await_args_list] == ["get_table_map", "analyze_form", "find_cell_by_label"]


def test_mapping_schema_has_exactly_one_disposition_per_question(monkeypatch):
    from app.application_preparation.agent import ApplicationPreparationAgent
    from app.application_preparation.document_contract import MapDocumentRequest
    from pydantic import ValidationError
    req = MapDocumentRequest(**request().model_dump(exclude={"facts"}), fields=[
        {"id": "company:name", "label": "회사명", "guidance": "", "required": False}])
    async def invoke(selection_type, *_args, **_kwargs):
        with pytest.raises(ValidationError):
            selection_type.model_validate({"assignments": {"invented": {"targetId": None}}, "scope": {"t1.r1.c2": False}})
        with pytest.raises(ValidationError):
            selection_type.model_validate({"assignments": {"company:name": {"targetId": "invented"}}, "scope": {"t1.r1.c2": False}})
        valid = {"assignments": {"company:name": {"targetId": None}}, "scope": {"t1.r1.c2": False}}
        with pytest.raises(ValidationError):
            selection_type.model_validate({**valid, "unmappedFieldIds": ["company:name"]})
        return selection_type.model_validate(valid)
    agent = ApplicationPreparationAgent(model=None, run_timeout_seconds=1)
    monkeypatch.setattr(agent, "_invoke", invoke)
    doc = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test", targets=[target()])
    selection = asyncio.run(agent.map_document(req, doc))
    assert selection.unmappedFieldIds == ["company:name"]


@pytest.mark.parametrize("repair_succeeds", [True, False])
def test_contradictory_mapping_gets_one_correction_and_never_drops_answers(monkeypatch, repair_succeeds):
    from unittest.mock import AsyncMock
    from app.application_preparation import document_pipeline
    from app.application_preparation.document_contract import MapDocumentRequest, MappingSelection
    req = MapDocumentRequest(**request().model_dump(exclude={"facts"}), fields=[
        {"id": "company:name", "label": "회사명", "guidance": "", "required": False}])
    doc = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test", targets=[target()])
    contradictory = MappingSelection(bindings=[{"factId": "company:name", "targetId": "t1.r1.c2", "box": None}],
        scopeTargetIds=["t1.r1.c2"], unmappedFieldIds=["company:name"])
    repaired = contradictory.model_copy(update={"unmappedFieldIds": []})
    agent = SimpleNamespace(map_document=AsyncMock(side_effect=[contradictory, repaired if repair_succeeds else contradictory]))
    monkeypatch.setattr(document_pipeline, "inspect_document", AsyncMock(return_value=doc))
    if repair_succeeds:
        result = asyncio.run(document_pipeline.map_document(req, agent))
        assert result["bindings"] == repaired.model_dump()["bindings"]
    else:
        with pytest.raises(DocumentError) as error:
            asyncio.run(document_pipeline.map_document(req, agent))
        assert error.value.reason == "INVALID_UNMAPPED_FIELDS"
    assert agent.map_document.await_count == 2
    assert agent.map_document.await_args.kwargs["rejection_reason"] == "INVALID_UNMAPPED_FIELDS"


def test_hwpx_fit_failure_stops_before_writing_a_file(monkeypatch, tmp_path):
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock
    from app.application_preparation import document_adapters
    from app.application_preparation.document_contract import WritePlan
    req = request()
    cell = target().model_copy(update={"nativeLocator": {"kind": "cell"}})
    doc = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test", targets=[cell])
    plan = WritePlan(sourceSha256=req.sourceSha256, mapVersion=doc.mapVersion, answerRevision=3, planHash="test",
        operations=[EditOperation(targetId=cell.targetId, operation="input", expectedText="", start=0, end=0,
                                  valueRef="company:name", box=None, reason="확인된 빈칸")], unresolvedTargets=[], scopeTargetIds=[cell.targetId])
    session = SimpleNamespace(call=AsyncMock(return_value={"checked": 1, "warnings": [{"overflow": True}]}))
    @asynccontextmanager
    async def open_session(*_args):
        yield session
    adapter = document_adapters.HwpxDocumentAdapter()
    monkeypatch.setattr(adapter, "inspect", AsyncMock(return_value=doc))
    monkeypatch.setattr(document_adapters, "document_session", open_session)
    with pytest.raises(DocumentError) as error:
        asyncio.run(adapter.apply(tmp_path / "source.hwpx", doc, plan, {"company:name": "매우 긴 답변"}))
    assert error.value.code == "APPLICATION_DOCUMENT_OVERFLOW"
    assert session.call.await_args.args[0] == "analyze_formfit"
    assert session.call.await_count == 1
    assert not (tmp_path / "completed.hwpx").exists()
