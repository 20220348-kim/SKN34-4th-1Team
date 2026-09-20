import json
from dataclasses import replace
from types import SimpleNamespace

import pytest
from agents.testing import ScriptedModel
from langchain_openai import ChatOpenAI
from tests.langchain_stub import ResponsesChatStub, response_message
from fastapi.testclient import TestClient

import app.bootstrap as bootstrap_module
import app.main as main_module
from app.support_program_ranking.agent import SupportProgramRecommendationAgent
from app.support_program_ranking.models import (
    SCORING_VERSION,
    AssessedSupportProgram,
    SupportProgramCandidate,
    SupportProgramRankingOutput,
    SupportProgramRankingRequest,
)
from app.support_program_ranking.service import SupportProgramRankingService
from app.support_program_evidence.answer_service import SupportProgramEvidenceAnswerService
from app.support_program_evidence.service import SupportProgramEvidenceService
from app.bootstrap import ApplicationContainer, build_application_container
from app.config import Settings
from app.support_program_conversation.service import SupportProgramConversationService
from app.application_preparation.service import ApplicationPreparationService


OPENAI_SETTINGS = Settings(
    openai_api_key="private-key",
    openai_model="test-model",
    llm_model_timeout_seconds=1.25,
    llm_run_timeout_seconds=1.75,
)


class FakeOpenAIClient:
    def __init__(self) -> None:
        self.closed = False
        self.chat = SimpleNamespace(completions=object())
        self.options = []

    def with_options(self, **kwargs):
        self.options.append(kwargs)
        return SimpleNamespace(chat=self.chat, **kwargs)

    async def close(self) -> None:
        self.closed = True


class NeverCalledAgent(SupportProgramRecommendationAgent):
    def __init__(self) -> None:
        pass

    async def rank(
        self,
        request: SupportProgramRankingRequest,
    ) -> SupportProgramRankingOutput:
        raise AssertionError("health and lifespan tests must not invoke the agent")


@pytest.mark.anyio
async def test_builds_and_wires_agent_in_the_composition_root(monkeypatch):
    selected = {"rankings": {"BIZINFO:program-1": {
        "semanticRelevance": 40, "supportTypeFit": 10, "recommendationReasons": ["질의와 직접 관련"],
        "targetAssessment": {"eligibility": "MATCH", "evidence": [1], "explanation": "기업 대상 근거"},
        "regionAssessment": {"eligibility": "MATCH", "evidence": [0], "explanation": "지역 조건 근거"},
    }}}
    stub = ResponsesChatStub([[response_message(json.dumps(selected, ensure_ascii=False))]])
    client = stub.model.root_async_client
    captured = {}
    def openai_client(**kwargs):
        captured.update(kwargs)
        return client
    monkeypatch.setattr(bootstrap_module, "AsyncOpenAI", openai_client)
    container = build_application_container(OPENAI_SETTINGS)
    try:
        assert isinstance(container.support_program_ranking_service, SupportProgramRankingService)
        assert isinstance(container.support_program_conversation_service, SupportProgramConversationService)
        assert isinstance(container.support_program_evidence_answer_service, SupportProgramEvidenceAnswerService)
        assert isinstance(container.support_program_evidence_service, SupportProgramEvidenceService)
        assert isinstance(container.application_preparation_service, ApplicationPreparationService)
        assert captured == {"api_key": "private-key", "timeout": 1.25, "max_retries": 0}
        assert container.openai_client is client
        for service in (container.support_program_index_service, container.support_program_evidence_service):
            assert service.openai_client is client
            assert service.qdrant_client is container.qdrant_client
        assert container.application_preparation_service.agent._model.root_async_client is client
        assert container.combination_review_service.agent._run_timeout_seconds == 70
        response = await container.support_program_ranking_service.rank(SupportProgramRankingRequest(
            originalQuery="서울 AI 반도체", scoringVersion=SCORING_VERSION, resultLimit=1,
            candidates=[SupportProgramCandidate(
                id="BIZINFO:program-1", title="서울 AI 반도체 지원", organization="기관",
                summary="반도체 지원", categories=["AI"], regions=["서울"], targetDescription="중소기업",
                applicationPeriod="상시 접수", status="OPEN",
            )],
        ))
        assert response.rankings[0].total_score == 100
        assert stub.first_call.body["model"] == "test-model"
        assert stub.first_call.timeout == 45
        stub.assert_complete()
    finally:
        await container.close()
    assert client.is_closed()


@pytest.mark.anyio
@pytest.mark.parametrize("ranking_model,reasoning", [(None, "none"), ("gpt-5.6-sol", "low"), ("gpt-5.6-luna", "low")])
@pytest.mark.parametrize("tier", ["default", "priority"])
async def test_ranking_model_and_reasoning_do_not_change_conversation_or_evidence(
    monkeypatch, ranking_model, reasoning, tier,
):
    client = FakeOpenAIClient()
    assistant_model = ScriptedModel([])
    monkeypatch.setattr(bootstrap_module, "AsyncOpenAI", lambda **kwargs: client)
    monkeypatch.setattr(bootstrap_module, "OpenAIResponsesModel", lambda **kwargs: assistant_model)
    settings = replace(OPENAI_SETTINGS, openai_ranking_model=ranking_model,
                       openai_ranking_reasoning_effort=reasoning, openai_ranking_service_tier=tier)
    container = build_application_container(settings)
    try:
        ranking = container.support_program_ranking_service._agent
        assert ranking._run_timeout_seconds == 50
        assert ranking._model.bound.model_name == (ranking_model or "test-model")
        assert ranking._model.kwargs == {
            "max_tokens": 10_000, "store": False, "reasoning": {"effort": reasoning}, "timeout": 45, "service_tier": tier,
        }
        conversation = container.support_program_conversation_service._agent
        evidence = container.support_program_evidence_answer_service._agent
        for agent in (conversation, evidence):
            assert agent._run_timeout_seconds == 1.75
            assert agent._model.bound.model_name == "test-model"
            assert agent._model.kwargs == {"max_tokens": 2_000, "store": False, "reasoning": {"effort": "none"}, "timeout": 1.25}
        assert conversation._model.bound is evidence._model.bound
        for agent in (ranking, conversation, evidence):
            assert isinstance(agent._model.bound, ChatOpenAI)
            assert agent._model.bound.use_responses_api is True
            assert agent._model.bound.max_retries == 0
            assert agent._model.bound.root_async_client is client
        assistant = container.assistant_service._agent._agent
        assert assistant.model is assistant_model
        assert assistant.model_settings.reasoning.effort == "low"
        assert assistant.model_settings.timeout == 1.25
        assert "service_tier" not in (assistant.model_settings.extra_args or {})
        assert container.openai_client is client
        assert container.support_program_index_service.openai_client is client
        assert container.support_program_evidence_service.openai_client is client
        assistant_model.assert_complete()
    finally:
        await container.close()
    assert client.closed


def test_application_lifespan_closes_container_owned_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = FakeOpenAIClient()
    container = ApplicationContainer(
        support_program_ranking_service=SupportProgramRankingService(NeverCalledAgent()),
        openai_client=client,  # type: ignore[arg-type]
    )

    monkeypatch.setattr(
        main_module,
        "build_application_container",
        lambda *args, **kwargs: container,
    )

    with TestClient(main_module.create_app(settings=OPENAI_SETTINGS)) as test_client:
        assert client.closed is False
        assert test_client.get("/internal/v1/health").status_code == 200

    assert client.closed is True


@pytest.mark.anyio
async def test_closes_both_qdrant_and_openai_clients() -> None:
    from unittest.mock import AsyncMock

    openai = FakeOpenAIClient()
    qdrant = AsyncMock()
    container = ApplicationContainer(
        support_program_ranking_service=SupportProgramRankingService(NeverCalledAgent()),
        openai_client=openai,  # type: ignore[arg-type]
        qdrant_client=qdrant,
    )
    await container.close()
    qdrant.close.assert_awaited_once()
    assert openai.closed is True
