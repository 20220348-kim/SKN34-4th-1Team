from unittest.mock import AsyncMock

import pytest

from app.assistant.errors import AssistantAnswerError
from app.assistant.models import SCHEMA_VERSION, AssistantAnswerOutput, AssistantAnswerRequest
from app.assistant.service import AssistantService


@pytest.mark.anyio
async def test_help_answer_with_known_citation_passes_through(request_data, output_data):
    request = AssistantAnswerRequest.model_validate(request_data)
    agent = AsyncMock()
    agent.answer.return_value = AssistantAnswerOutput.model_validate(output_data)
    response = await AssistantService(agent).answer(request)
    assert response.model_dump(by_alias=True) == {"schemaVersion": SCHEMA_VERSION, **output_data}
    agent.answer.assert_awaited_once_with(request)


@pytest.mark.anyio
@pytest.mark.parametrize("citations", [["unknown-entry"], ["search-score-meaning", "unknown-entry"]])
async def test_citation_outside_the_request_help_entries_is_an_error(request_data, output_data, citations):
    output_data["citations"] = citations
    agent = AsyncMock()
    agent.answer.return_value = AssistantAnswerOutput.model_validate(output_data)
    with pytest.raises(AssistantAnswerError):
        await AssistantService(agent).answer(AssistantAnswerRequest.model_validate(request_data))


@pytest.mark.anyio
@pytest.mark.parametrize("data", [
    {"intent": "ACCOUNT_STATE", "accountTopic": "RECEIVED_PROPOSALS"},
    {"intent": "SEARCH", "searchQuery": "서울 제조업 R&D 지원"},
    {"intent": "PROGRAM_QUESTION"},
    {"intent": "OUT_OF_SCOPE", "answer": "세무 대행은 할 수 없어요. 지원사업 검색을 도와드릴 수 있어요."},
    {"intent": "UNCLEAR", "clarificationQuestion": "사용법인가요, 지원사업 검색인가요?"},
])
async def test_non_help_intents_do_not_need_citations(request_data, data):
    output = AssistantAnswerOutput.model_validate({
        "answer": None, "citations": [], "clarificationQuestion": None, "searchQuery": None, "accountTopic": None, **data,
    })
    agent = AsyncMock()
    agent.answer.return_value = output
    response = await AssistantService(agent).answer(AssistantAnswerRequest.model_validate(request_data))
    assert response.intent == data["intent"]
    assert response.citations == []


@pytest.mark.anyio
@pytest.mark.parametrize("bad_output", [None, {}, "PRODUCT_HELP"])
async def test_untyped_output_is_an_error(request_data, bad_output):
    agent = AsyncMock()
    agent.answer.return_value = bad_output
    with pytest.raises(AssistantAnswerError):
        await AssistantService(agent).answer(AssistantAnswerRequest.model_validate(request_data))


@pytest.mark.anyio
async def test_revalidates_model_instances_instead_of_trusting_constructed_output(request_data):
    agent = AsyncMock()
    agent.answer.return_value = AssistantAnswerOutput.model_construct(
        intent="PRODUCT_HELP", answer="근거 없는 답", citations=[],
        clarification_question=None, search_query=None, account_topic=None,
    )
    with pytest.raises(AssistantAnswerError):
        await AssistantService(agent).answer(AssistantAnswerRequest.model_validate(request_data))
