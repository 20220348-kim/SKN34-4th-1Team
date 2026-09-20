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
    assert "b1" not in contexts


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
