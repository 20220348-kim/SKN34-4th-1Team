import asyncio
import json

import pytest
from langchain_core.messages import AIMessage
from pydantic import ValidationError

from app.support_program_llm import get_support_program_usage_details, validate_support_program_output
from app.support_program_evidence.models import SupportProgramEvidenceAnswerSelection
from app.support_program_evidence.agent import SupportProgramEvidenceAnswerAgent
from app.support_program_evidence.models import SupportProgramEvidenceAnswerRequest
from tests.langchain_stub import ResponsesChatStub


VALID = json.dumps({"answer": "근거 답변", "answerStatus": "ANSWERED", "citationChunkIndexes": [0]})


@pytest.mark.parametrize("status", ["incomplete", "failed", "cancelled", "in_progress", None])
def test_rejects_non_completed_responses_even_with_valid_json(status):
    with pytest.raises(ValueError):
        validate_support_program_output(
            AIMessage(content=VALID, response_metadata={"status": status}),
            SupportProgramEvidenceAnswerSelection,
        )


@pytest.mark.parametrize("content", [
    VALID[:-1], chr(96) * 3 + "json\\n" + VALID + "\\n" + chr(96) * 3, VALID + " unexpected text",
    VALID.replace("[0]", '["0"]'), VALID.replace("[0]", "[false]"),
])
def test_does_not_repair_json_or_coerce_citation_indexes(content):
    with pytest.raises(ValidationError):
        validate_support_program_output(
            AIMessage(content=content, response_metadata={"status": "completed"}),
            SupportProgramEvidenceAnswerSelection,
        )


def test_rejects_refusal_even_when_response_also_contains_valid_json():
    with pytest.raises(ValueError):
        validate_support_program_output(AIMessage(
            content=[{"type": "text", "text": VALID}, {"type": "refusal", "refusal": "refused"}],
            response_metadata={"status": "completed"},
        ), SupportProgramEvidenceAnswerSelection)


@pytest.mark.anyio
async def test_cancelling_langchain_request_cancels_http_without_retry():
    entered, stopped = asyncio.Event(), asyncio.Event()
    async def pending(_):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()
    stub = ResponsesChatStub([pending])
    agent = SupportProgramEvidenceAnswerAgent(model=stub.model, model_timeout_seconds=3, run_timeout_seconds=4)
    task = asyncio.create_task(agent.answer(SupportProgramEvidenceAnswerRequest(
        question="지원 대상은?", chunks=[{"id": "a" * 64, "documentId": "BIZINFO:1", "order": 0, "text": "중소기업 지원"}],
    )))
    await asyncio.wait_for(entered.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stopped.is_set()
    assert len(stub.calls) == 1



@pytest.mark.parametrize("usage, expected", [
    (None, (None, None)),
    ({"input_tokens": 100, "output_tokens": 50, "total_tokens": 150}, (None, None)),
    ({"input_token_details": {}, "output_token_details": {}}, (None, None)),
    ({"input_token_details": {"priority_cache_read": 0},
      "output_token_details": {"flex_reasoning": 0}}, (0, 0)),
    ({"input_token_details": {"cache_read": 5, "priority_cache_read": 7, "flex_cache_read": 11,
                             "priority": 100, "flex": 200, "audio": 13, "cache_creation": 17},
      "output_token_details": {"reasoning": 2, "priority_reasoning": 3, "flex_reasoning": 4,
                              "priority": 10, "flex": 20, "audio": 6}}, (23, 9)),
    ({"input_token_details": {"cache_creation": 4, "priority_cache_creation": 8, "priority": 10},
      "output_token_details": {"flex": 20}}, (None, None)),
    ({"input_token_details": {"priority_cache_read": 7}}, (7, None)),
    ({"output_token_details": {"flex_reasoning": 3}}, (None, 3)),
])
def test_usage_details_preserve_missing_and_zero_without_counting_other_tokens(usage, expected):
    assert get_support_program_usage_details(usage) == expected
