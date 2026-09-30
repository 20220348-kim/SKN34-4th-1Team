"""저장된 바인딩에서 작성 계획을 결정적으로 만드는 규칙입니다. 모델은 한 문단에 여러 답변이 묶인 경우에만 부릅니다."""
import asyncio
import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.application_preparation import document_pipeline
from app.application_preparation.document_adapters import HwpxDocumentAdapter
from app.application_preparation.document_contract import (
    DocumentError, DocumentMap, EditOperation, GenerateDocumentRequest, NativeTarget, PlanSelection, digest,
)

SOURCE = b"synthetic deterministic plan fixture"


def request(fmt="hwpx", facts=None, bindings=None, scope=None):
    facts = facts or [{"id": "company:name", "label": "회사명", "value": "가상기업"}]
    return GenerateDocumentRequest(sourceBase64=base64.b64encode(SOURCE).decode(), sourceSha256=digest(SOURCE),
        format=fmt, answerRevision=3, facts=facts, scope="신청서",
        bindings=bindings or [{"factId": fact["id"], "targetId": "t1.r1.c2", "box": None} for fact in facts],
        scopeTargetIds=scope if scope is not None else list(dict.fromkeys(b["targetId"] for b in (bindings or [{"targetId": "t1.r1.c2"}]))))


def target(name="t1.r1.c2", text="", kind="cell", **locator):
    return NativeTarget(targetId=name, nativeLocator={"target": name, **locator}, kind=kind, currentText=text)


def generate(monkeypatch, req, targets, agent=None):
    document = DocumentMap(sourceSha256=req.sourceSha256, format=req.format, engineVersion="test", targets=targets)
    monkeypatch.setattr(document_pipeline, "inspect_document", AsyncMock(return_value=document))
    monkeypatch.setattr(HwpxDocumentAdapter, "apply", AsyncMock(return_value=(SOURCE, {"applied": len(req.facts), "placements": []})))
    agent = agent or SimpleNamespace(plan_document=AsyncMock(side_effect=AssertionError("saved bindings make the plan deterministic")))
    result = asyncio.run(document_pipeline.generate_document(req, agent))
    return result["writePlan"]["operations"], agent


@pytest.mark.parametrize("text,expected", [
    ("", ("input", 0, 0)),
    ("   ", ("input", 0, 0)),
    ("기업명: ____ / 필수", ("replace_range", 5, 9)),
    ("성명 (      )", ("replace_range", 3, 11)),
    ("대표자명:", ("replace_range", 5, 5)),
    ("예) 홍길동", ("replace_range", 0, 6)),
])
def test_single_answer_text_operation_follows_fixed_rules(monkeypatch, text, expected):
    operations, agent = generate(monkeypatch, request(), [target(text=text)])
    agent.plan_document.assert_not_awaited()
    (op,) = operations
    assert (op["operation"], op["start"], op["end"]) == expected
    assert op["expectedText"] == text and op["valueRef"] == "company:name" and op["reason"]


def test_same_answer_fills_every_bound_target_without_the_model(monkeypatch):
    req = request(bindings=[{"factId": "company:name", "targetId": "t1.r1.c2", "box": None},
                            {"factId": "company:name", "targetId": "t3.r2.c2", "box": None}])
    operations, agent = generate(monkeypatch, req, [target(), target("t3.r2.c2", "예) 회사")])
    agent.plan_document.assert_not_awaited()
    assert [(op["targetId"], op["operation"]) for op in operations] == [("t1.r1.c2", "input"), ("t3.r2.c2", "replace_range")]


def test_several_answers_in_one_paragraph_ask_the_model_for_those_only(monkeypatch):
    facts = [{"id": "company:name", "label": "회사명", "value": "가상기업"},
             {"id": "company:phone", "label": "연락처", "value": "02-000-0000"},
             {"id": "company:ceo", "label": "대표자", "value": "홍길동"}]
    bindings = [{"factId": "company:name", "targetId": "p1", "box": None},
                {"factId": "company:phone", "targetId": "p1", "box": None},
                {"factId": "company:ceo", "targetId": "t1.r1.c2", "box": None}]
    req = request(facts=facts, bindings=bindings, scope=["p1", "t1.r1.c2"])
    shared = "회사명: ____ 연락처: ____"
    seen = {}

    async def plan_document(reduced, document):
        seen["facts"] = [fact.id for fact in reduced.facts]
        seen["bindings"] = [binding.factId for binding in reduced.bindings]
        first, second = shared.index("____"), shared.rindex("____")
        return PlanSelection(operations=[
            EditOperation(targetId="p1", operation="replace_range", expectedText=shared, start=first, end=first + 4, valueRef="company:name", box=None, reason="첫 빈칸"),
            EditOperation(targetId="p1", operation="replace_range", expectedText=shared, start=second, end=second + 4, valueRef="company:phone", box=None, reason="둘째 빈칸"),
        ], unresolvedTargets=[], scopeTargetIds=["p1"])

    operations, _ = generate(monkeypatch, req, [target("p1", shared, kind="paragraph"), target()], SimpleNamespace(plan_document=plan_document))
    assert seen == {"facts": ["company:name", "company:phone"], "bindings": ["company:name", "company:phone"]}
    assert sorted((op["targetId"], op["valueRef"]) for op in operations) == [
        ("p1", "company:name"), ("p1", "company:phone"), ("t1.r1.c2", "company:ceo")]


def test_deterministic_plan_still_fails_closed_on_a_changed_binding(monkeypatch):
    # The saved binding points at a target the fresh inspection does not offer as editable: the rule must not paper over it.
    req = request()
    read_only = NativeTarget(targetId="t1.r1.c2", nativeLocator={"target": "t1.r1.c2"}, kind="cell", currentText="", editable=False)
    with pytest.raises(DocumentError) as error:
        generate(monkeypatch, req, [read_only])
    assert error.value.code == "APPLICATION_DOCUMENT_MAPPING_FAILED"
    assert error.value.reason == "TARGET_NOT_EDITABLE_OR_OUT_OF_SCOPE"


def test_pdf_and_unbound_requests_keep_the_model_path(monkeypatch):
    req = GenerateDocumentRequest(sourceBase64=base64.b64encode(SOURCE).decode(), sourceSha256=digest(SOURCE),
        format="hwpx", answerRevision=3, facts=[{"id": "company:name", "label": "회사명", "value": "가상기업"}], scope="신청서")
    document = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test", targets=[target()])
    monkeypatch.setattr(document_pipeline, "inspect_document", AsyncMock(return_value=document))
    monkeypatch.setattr(HwpxDocumentAdapter, "apply", AsyncMock(return_value=(SOURCE, {"applied": 1, "placements": []})))
    agent = SimpleNamespace(plan_document=AsyncMock(return_value=PlanSelection(operations=[
        EditOperation(targetId="t1.r1.c2", operation="input", expectedText="", start=0, end=0, valueRef="company:name", box=None, reason="빈칸")],
        unresolvedTargets=[], scopeTargetIds=["t1.r1.c2"])))
    asyncio.run(document_pipeline.generate_document(req, agent))
    agent.plan_document.assert_awaited_once()
