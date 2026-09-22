from copy import deepcopy
from unittest.mock import AsyncMock

import pytest

from app.support_program_conversation.errors import SupportProgramConversationError
from app.support_program_conversation.models import (
    SCHEMA_VERSION, ConversationUpdate, SupportProgramConversationOutput, SupportProgramConversationRequest,
)
from app.support_program_conversation.service import SupportProgramConversationService


@pytest.mark.anyio
async def test_region_patch_preserves_every_unmentioned_field_and_input(request_data, output_data):
    before = deepcopy(request_data)
    request = SupportProgramConversationRequest.model_validate(request_data)
    output = SupportProgramConversationOutput.model_validate(output_data)
    agent = AsyncMock()
    agent.interpret.return_value = output
    service = SupportProgramConversationService(agent)
    response = await service.interpret(request)
    assert response.model_dump(by_alias=True) == {"schemaVersion": SCHEMA_VERSION, "status": "READY",
        "updates": output_data["updates"], "answer": None, "clarificationQuestion": None}
    merged = service._merge_context(request, output)
    expected = deepcopy(request_data["context"])
    expected["companyConditions"]["region"] = "부산"
    assert merged.model_dump(by_alias=True) == expected
    assert request.model_dump(by_alias=True) == before
    agent.interpret.assert_awaited_once_with(request)


@pytest.mark.anyio
async def test_followup_date_merges_from_pending_draft_not_applied_context(request_data):
    draft = deepcopy(request_data["context"])
    draft["companyConditions"].update(region="부산", establishedOn=None, supportPurpose="지원금")
    draft["query"] = "지원금"
    request_data.update(message="2024년 2월 29일", pendingClarification={"question": "정확한 설립일은?", "draftContext": draft})
    request = SupportProgramConversationRequest.model_validate(request_data)
    output = SupportProgramConversationOutput(status="READY", updates=[{
        "field": "ESTABLISHED_ON", "operation": "SET", "value": "2024-02-29", "evidence": request.message,
    }], answerKind=None, clarificationKind=None)
    agent = AsyncMock()
    agent.interpret.return_value = output
    service = SupportProgramConversationService(agent)
    assert (await service.interpret(request)).status == "READY"
    merged = service._merge_context(request, output)
    assert merged.query == "지원금"
    assert merged.company_conditions.region == "부산"
    assert merged.company_conditions.support_purpose == "지원금"
    assert merged.company_conditions.established_on == "2024-02-29"
    assert request.context.company_conditions.region == "서울"
    assert request.pending_clarification.draft_context.company_conditions.established_on is None


@pytest.mark.anyio
@pytest.mark.parametrize("where", ["context", "question", "fabricated", "non_contiguous"])
async def test_only_exact_current_message_quotes_authorize_changes(request_data, output_data, where):
    request_data["message"] = "부 산으로 변경" if where == "non_contiguous" else "변경해줘"
    if where == "context":
        request_data["context"]["companyConditions"]["region"] = "부산"
    elif where == "question":
        request_data["pendingClarification"] = {"question": "부산인가요?", "draftContext": request_data["context"]}
    agent = AsyncMock()
    agent.interpret.return_value = SupportProgramConversationOutput.model_validate(output_data)
    with pytest.raises(SupportProgramConversationError):
        await SupportProgramConversationService(agent).interpret(SupportProgramConversationRequest.model_validate(request_data))


@pytest.mark.anyio
@pytest.mark.parametrize("date_value", ["1899-12-31", "2026-09-08"])
async def test_rejects_out_of_range_date_after_patch_merge(request_data, date_value):
    request_data["message"] = date_value
    agent = AsyncMock()
    agent.interpret.return_value = SupportProgramConversationOutput(status="READY", updates=[{
        "field": "ESTABLISHED_ON", "operation": "SET", "value": date_value, "evidence": date_value,
    }], answerKind=None, clarificationKind=None)
    with pytest.raises(SupportProgramConversationError):
        await SupportProgramConversationService(agent).interpret(SupportProgramConversationRequest.model_validate(request_data))


@pytest.mark.anyio
@pytest.mark.parametrize("clear_query", [False, True])
async def test_ready_requires_a_merged_query(request_data, clear_query):
    request_data["message"] = "검색 의도 삭제"
    updates = [{"field": "QUERY", "operation": "CLEAR", "value": None, "evidence": "삭제"}] if clear_query else []
    if not clear_query:
        request_data["context"]["query"] = None
    agent = AsyncMock()
    agent.interpret.return_value = SupportProgramConversationOutput(status="READY", updates=updates, answerKind=None, clarificationKind=None)
    with pytest.raises(SupportProgramConversationError):
        await SupportProgramConversationService(agent).interpret(SupportProgramConversationRequest.model_validate(request_data))


@pytest.mark.anyio
async def test_explicit_reset_clears_all_strings_restores_boolean_and_asks_for_query(request_data):
    request_data["message"] = "전체 초기화"
    request_data["context"]["acceptingOnly"] = False
    output = SupportProgramConversationOutput(status="CLARIFICATION_REQUIRED", updates=[
        {"field": field, "operation": "CLEAR", "value": None, "evidence": "전체 초기화"}
        for field in ("QUERY", "REGION", "INDUSTRY", "ESTABLISHED_ON", "SUPPORT_PURPOSE", "ACCEPTING_ONLY")
    ], answerKind=None, clarificationKind="QUERY")
    agent = AsyncMock()
    agent.interpret.return_value = output
    request = SupportProgramConversationRequest.model_validate(request_data)
    service = SupportProgramConversationService(agent)
    response = await service.interpret(request)
    merged = service._merge_context(request, output)
    assert response.status == "CLARIFICATION_REQUIRED"
    assert merged.query is None and merged.accepting_only is True
    assert set(merged.company_conditions.model_dump().values()) == {None}


@pytest.mark.anyio
async def test_ambiguous_region_can_keep_clear_purpose_change_only(request_data):
    request_data["message"] = "부산이나 대구로, 지원금 위주"
    output = SupportProgramConversationOutput(status="CLARIFICATION_REQUIRED", updates=[
        {"field": "SUPPORT_PURPOSE", "operation": "SET", "value": "지원금", "evidence": "지원금"}
    ], answerKind=None, clarificationKind="REGION")
    agent = AsyncMock()
    agent.interpret.return_value = output
    request = SupportProgramConversationRequest.model_validate(request_data)
    service = SupportProgramConversationService(agent)
    assert (await service.interpret(request)).status == "CLARIFICATION_REQUIRED"
    assert service._merge_context(request, output).company_conditions.region == "서울"


@pytest.mark.anyio
@pytest.mark.parametrize("bad_output", [None, {}, "READY"])
async def test_untyped_output_is_an_error_not_clarification(request_data, bad_output):
    agent = AsyncMock()
    agent.interpret.return_value = bad_output
    with pytest.raises(SupportProgramConversationError):
        await SupportProgramConversationService(agent).interpret(SupportProgramConversationRequest.model_validate(request_data))


@pytest.mark.anyio
async def test_revalidates_model_instances_instead_of_trusting_constructed_output(request_data, output_data):
    agent = AsyncMock()
    agent.interpret.return_value = SupportProgramConversationOutput.model_construct(**{
        "status": "READY", "updates": [], "answer_kind": None, "clarification_kind": "REGION",
    })
    with pytest.raises(SupportProgramConversationError):
        await SupportProgramConversationService(agent).interpret(SupportProgramConversationRequest.model_validate(request_data))


@pytest.mark.anyio
@pytest.mark.parametrize("value", ["true", "false"])
async def test_accepting_only_set_uses_strict_string_values(request_data, value):
    request_data["message"] = "접수 필터 변경"
    output = SupportProgramConversationOutput(status="READY", updates=[
        {"field": "ACCEPTING_ONLY", "operation": "SET", "value": value, "evidence": "접수 필터 변경"}
    ], answerKind=None, clarificationKind=None)
    agent = AsyncMock()
    agent.interpret.return_value = output
    service = SupportProgramConversationService(agent)
    request = SupportProgramConversationRequest.model_validate(request_data)
    await service.interpret(request)
    assert service._merge_context(request, output).accepting_only is (value == "true")


@pytest.mark.anyio
@pytest.mark.parametrize("message", ["대구", "대구로 찾아봐"])
async def test_region_followup_keeps_pending_trade_intent_and_other_conditions(request_data, message):
    request_data["message"] = message
    proposal = deepcopy(request_data["context"])
    proposal["query"] = "무역 지원"
    proposal["companyConditions"].update(region="서울", supportPurpose="무역")
    request_data["pendingProposal"] = proposal
    output = SupportProgramConversationOutput(status="READY", updates=[
        {"field": "REGION", "operation": "SET", "value": "대구", "evidence": "대구"},
    ], answerKind=None, clarificationKind=None)
    agent = AsyncMock()
    agent.interpret.return_value = output
    service = SupportProgramConversationService(agent)
    request = SupportProgramConversationRequest.model_validate(request_data)

    assert (await service.interpret(request)).status == "READY"
    merged = service._merge_context(request, output)
    assert merged.query == "무역 지원"
    assert merged.company_conditions.region == "대구"
    assert merged.company_conditions.support_purpose == "무역"
    assert merged.company_conditions.industry == proposal["companyConditions"]["industry"]
    assert merged.company_conditions.established_on == proposal["companyConditions"]["establishedOn"]
    assert request.context.query == "사업화 지원"
    assert request.pending_proposal.company_conditions.region == "서울"


@pytest.mark.anyio
@pytest.mark.parametrize("pending", ["proposal", "clarification"])
async def test_explicit_assent_uses_pending_target_without_reasking(request_data, pending):
    request_data["message"] = "설정해"
    draft = deepcopy(request_data["context"])
    draft["query"] = "무역 지원"
    if pending == "proposal":
        draft["companyConditions"]["region"] = "대구"
        request_data["pendingProposal"] = draft
        updates = []
    else:
        request_data["pendingClarification"] = {
            "question": "대구를 현재 소재지로 설정할까요?", "draftContext": draft,
        }
        updates = [{"field": "REGION", "operation": "SET", "value": "대구", "evidence": "설정해"}]
    output = SupportProgramConversationOutput(status="READY", updates=updates, answerKind=None, clarificationKind=None)
    agent = AsyncMock()
    agent.interpret.return_value = output
    service = SupportProgramConversationService(agent)
    request = SupportProgramConversationRequest.model_validate(request_data)
    response = await service.interpret(request)
    assert response.status == "READY"
    assert response.clarification_question is None
    assert service._merge_context(request, output).company_conditions.region == "대구"
    assert service._merge_context(request, output).query == "무역 지원"


@pytest.mark.anyio
@pytest.mark.parametrize("has_query", [False, True])
@pytest.mark.parametrize("result_count", [None, 0, 3])
async def test_answered_renders_summary_without_requiring_or_changing_query(request_data, has_query, result_count):
    request_data["message"] = "왜 못 찾아?"
    if not has_query:
        request_data["context"]["query"] = None
    if result_count is not None:
        request_data["lastSearch"] = {"context": deepcopy(request_data["context"]), "resultCount": result_count}
    before = deepcopy(request_data)
    output = SupportProgramConversationOutput(status="ANSWERED", updates=[], answerKind="RESULT_SUMMARY", clarificationKind=None)
    agent = AsyncMock()
    agent.interpret.return_value = output
    service = SupportProgramConversationService(agent)
    request = SupportProgramConversationRequest.model_validate(request_data)
    response = await service.interpret(request)
    assert ("아직 완료된 검색 결과가 없어" in response.answer if result_count is None
            else f"반환된 공고는 {result_count}건입니다." in response.answer)
    assert response.status == "ANSWERED" and response.updates == []
    assert service._merge_context(request, output) == request.context
    assert request.model_dump(by_alias=True) == before


@pytest.mark.anyio
async def test_answered_does_not_apply_last_search_context_to_pending_proposal(request_data):
    request_data["message"] = "몇 개 찾았어?"
    request_data["lastSearch"] = {"context": deepcopy(request_data["context"]), "resultCount": 2}
    request_data["pendingProposal"] = deepcopy(request_data["context"])
    request_data["pendingProposal"]["companyConditions"]["region"] = "대구"
    output = SupportProgramConversationOutput(status="ANSWERED", updates=[], answerKind="RESULT_SUMMARY", clarificationKind=None)
    agent = AsyncMock()
    agent.interpret.return_value = output
    service = SupportProgramConversationService(agent)
    request = SupportProgramConversationRequest.model_validate(request_data)
    response = await service.interpret(request)
    assert response.updates == []
    assert service._merge_context(request, output) == request.pending_proposal
    assert request.last_search.context.company_conditions.region == "서울"


@pytest.mark.anyio
@pytest.mark.parametrize("answer_kind,updates", [
    (None, []),
    ("injected free answer", []),
    ("RESULT_SUMMARY", [{"field": "REGION", "operation": "SET", "value": "부산", "evidence": "부산"}]),
])
async def test_forged_answered_output_is_revalidated(request_data, answer_kind, updates):
    agent = AsyncMock()
    agent.interpret.return_value = SupportProgramConversationOutput.model_construct(
        status="ANSWERED", updates=[ConversationUpdate.model_validate(update) for update in updates],
        clarification_kind=None, answer_kind=answer_kind,
    )
    with pytest.raises(SupportProgramConversationError):
        await SupportProgramConversationService(agent).interpret(SupportProgramConversationRequest.model_validate(request_data))


@pytest.mark.anyio
async def test_registered_year_survives_region_change_without_a_fabricated_date(request_data, output_data):
    request_data["context"]["companyConditions"].update(establishedOn=None, foundedYear=2021)
    request = SupportProgramConversationRequest.model_validate(request_data)
    output = SupportProgramConversationOutput.model_validate(output_data)
    agent = AsyncMock()
    agent.interpret.return_value = output
    service = SupportProgramConversationService(agent)
    await service.interpret(request)
    conditions = service._merge_context(request, output).company_conditions
    assert conditions.founded_year == 2021
    assert conditions.established_on is None
    assert conditions.region == "부산"


@pytest.mark.anyio
@pytest.mark.parametrize("field,value,evidence", [
    ("FOUNDED_YEAR", "2021", "2021년"),
    ("ESTABLISHED_ON", "2021-06-01", "2021-06-01"),
    ("FOUNDED_YEAR", None, "설립 조건 해제"),
])
async def test_foundation_precision_can_be_replaced_and_cleared(request_data, field, value, evidence):
    request_data["context"]["companyConditions"].update(establishedOn=None, foundedYear=2020)
    request_data["message"] = evidence
    output = SupportProgramConversationOutput(status="READY", updates=[{
        "field": field, "operation": "CLEAR" if value is None else "SET", "value": value, "evidence": evidence,
    }], answerKind=None, clarificationKind=None)
    agent = AsyncMock()
    agent.interpret.return_value = output
    service = SupportProgramConversationService(agent)
    request = SupportProgramConversationRequest.model_validate(request_data)
    await service.interpret(request)
    result = service._merge_context(request, output).company_conditions
    assert result.founded_year == (int(value) if field == "FOUNDED_YEAR" and value else None)
    assert result.established_on == (value if field == "ESTABLISHED_ON" else None)
