from dataclasses import dataclass

from agents import OpenAIResponsesModel
from langchain_openai import ChatOpenAI
from openai import AsyncOpenAI
from qdrant_client import AsyncQdrantClient
from app.combination_review.agent import CombinationReviewAgent
from app.combination_review.service import CombinationReviewService
from app.application_preparation.agent import ApplicationPreparationAgent
from app.application_preparation.service import ApplicationPreparationService
from app.assistant.agent import AssistantAgent
from app.assistant.service import AssistantService
from app.assistant_agent.graph import build_assistant_agent_graph
from app.assistant_agent.retriever import QdrantEvidenceRetriever
from app.assistant_agent.service import AssistantAgentService
from app.assistant_agent.tools import CoreToolClient

from app.support_program_evidence.agent import SupportProgramEvidenceAnswerAgent
from app.support_program_evidence.answer_service import SupportProgramEvidenceAnswerService
from app.support_program_evidence.service import SupportProgramEvidenceService
from app.support_program_ranking.agent import SupportProgramRecommendationAgent
from app.support_program_ranking.service import SupportProgramRankingService
from app.config import Settings
from app.support_program_index.service import SupportProgramIndexService
from app.support_program_conversation.agent import SupportProgramConversationAgent
from app.support_program_conversation.service import SupportProgramConversationService


@dataclass(slots=True)
class ApplicationContainer:
    """애플리케이션 객체 그래프와 그 객체가 소유한 자원."""

    support_program_ranking_service: SupportProgramRankingService
    openai_client: AsyncOpenAI | None = None
    support_program_index_service: SupportProgramIndexService | None = None
    support_program_evidence_service: SupportProgramEvidenceService | None = None
    support_program_evidence_answer_service: SupportProgramEvidenceAnswerService | None = None
    support_program_conversation_service: SupportProgramConversationService | None = None
    qdrant_client: AsyncQdrantClient | None = None
    combination_review_service: CombinationReviewService | None = None
    application_preparation_service: ApplicationPreparationService | None = None
    assistant_service: AssistantService | None = None
    assistant_agent_service: AssistantAgentService | None = None
    assistant_tool_client: CoreToolClient | None = None

    async def close(self) -> None:
        try:
            if self.assistant_tool_client is not None:
                await self.assistant_tool_client.aclose()
        finally:
            try:
                if self.qdrant_client is not None:
                    await self.qdrant_client.close()
            finally:
                if self.openai_client is not None:
                    await self.openai_client.close()


def build_application_container(
    settings: Settings,
    *,
    support_program_recommendation_agent: SupportProgramRecommendationAgent | None = None,
    support_program_evidence_answer_agent: SupportProgramEvidenceAnswerAgent | None = None,
    support_program_conversation_agent: SupportProgramConversationAgent | None = None,
    application_preparation_agent: ApplicationPreparationAgent | None = None,
    assistant_agent: AssistantAgent | None = None,
    assistant_agent_service: AssistantAgentService | None = None,
) -> ApplicationContainer:
    """환경설정과 선택적 테스트 대역을 실제 애플리케이션 객체로 조립한다."""

    openai_client = AsyncOpenAI(
        api_key=settings.openai_api_key,
        timeout=settings.llm_model_timeout_seconds,
        max_retries=0,
    )
    ranking_agent = support_program_recommendation_agent
    evidence_answer_agent = support_program_evidence_answer_agent
    conversation_agent = support_program_conversation_agent
    general_model = None
    if (
        evidence_answer_agent is None or conversation_agent is None
    ):
        general_model = ChatOpenAI(
            model=settings.openai_model, api_key=settings.openai_api_key,
            use_responses_api=True, max_retries=0,
            root_async_client=openai_client, async_client=openai_client.chat.completions,
        )
    if ranking_agent is None:
        ranking_agent = SupportProgramRecommendationAgent(
            model=ChatOpenAI(
                model=settings.openai_ranking_model or settings.openai_model,
                api_key=settings.openai_api_key, use_responses_api=True, max_retries=0,
                root_async_client=openai_client, async_client=openai_client.chat.completions,
            ),
            model_timeout_seconds=settings.llm_ranking_model_timeout_seconds,
            run_timeout_seconds=settings.llm_ranking_run_timeout_seconds,
            reasoning_effort=settings.openai_ranking_reasoning_effort,
            service_tier=settings.openai_ranking_service_tier,
        )
    if evidence_answer_agent is None:
        assert general_model is not None
        evidence_answer_agent = SupportProgramEvidenceAnswerAgent(
            model=general_model,
            model_timeout_seconds=settings.llm_model_timeout_seconds,
            run_timeout_seconds=settings.llm_run_timeout_seconds,
        )

    if conversation_agent is None:
        assert general_model is not None
        conversation_agent = SupportProgramConversationAgent(
            model=general_model,
            model_timeout_seconds=settings.llm_model_timeout_seconds,
            run_timeout_seconds=settings.llm_run_timeout_seconds,
        )

    if application_preparation_agent is None:
        application_preparation_agent = ApplicationPreparationAgent(
            model=ChatOpenAI(
                model=settings.openai_model, api_key=settings.openai_api_key,
                use_responses_api=True, store=False, reasoning={"effort": "none"},
                timeout=settings.llm_model_timeout_seconds, max_retries=0,
                root_async_client=openai_client, async_client=openai_client.chat.completions,
            ),
            run_timeout_seconds=settings.llm_run_timeout_seconds,
            discovery_model_timeout_seconds=settings.application_form_discovery_model_timeout_seconds,
            discovery_run_timeout_seconds=settings.application_form_discovery_run_timeout_seconds,
        )

    if assistant_agent is None:
        # 도우미는 분류만 하므로 전용(가장 싼) 모델을 쓰고 클라이언트·재시도 정책은 공유한다.
        assistant_agent = AssistantAgent(
            model=OpenAIResponsesModel(model=settings.openai_assistant_model, openai_client=openai_client),
            reasoning_effort=settings.openai_assistant_reasoning_effort,
            model_timeout_seconds=settings.llm_model_timeout_seconds,
            run_timeout_seconds=settings.llm_run_timeout_seconds,
        )

    combination_openai_client = openai_client.with_options(
        timeout=settings.llm_combination_review_model_timeout_seconds,
    )
    combination_agent = CombinationReviewAgent(
        model=ChatOpenAI(
            model=settings.openai_model, api_key=settings.openai_api_key,
            use_responses_api=True, store=False, reasoning={"effort": "none"},
            max_tokens=6000, timeout=settings.llm_combination_review_model_timeout_seconds,
            max_retries=0, root_async_client=combination_openai_client,
            async_client=combination_openai_client.chat.completions,
        ),
        run_timeout_seconds=settings.llm_combination_review_run_timeout_seconds,
    )

    qdrant_client = AsyncQdrantClient(
        url=settings.qdrant_url,
        api_key=settings.qdrant_api_key,
        timeout=settings.qdrant_timeout_seconds,
        check_compatibility=False,
    )
    evidence_service = SupportProgramEvidenceService(
        openai_client,
        qdrant_client,
        embedding_model=settings.openai_embedding_model,
        embedding_dimensions=settings.openai_embedding_dimensions,
        embedding_timeout_seconds=settings.embedding_timeout_seconds,
    )

    assistant_tool_client = None
    if assistant_agent_service is None:
        # 도우미 도구 에이전트만 LangGraph를 쓴다. 분류는 도우미와 같은 싼 모델, 계획·답은 전용 모델이다.
        # 관심 공고 묶음 질문의 근거 검색은 기존 근거 컬렉션(같은 Qdrant·임베딩 설정)을 문서 id로 좁혀 읽는다.
        assistant_tool_client = CoreToolClient(
            base_url=settings.assistant_tools_base_url, secret=settings.assistant_tools_token,
            timeout_seconds=settings.assistant_tool_timeout_seconds,
        )
        assistant_agent_service = AssistantAgentService(
            graph=build_assistant_agent_graph(
                classify_model=_chat_model(settings, settings.openai_assistant_model, settings.openai_assistant_reasoning_effort),
                agent_model=_chat_model(
                    settings, settings.openai_assistant_agent_model, settings.openai_assistant_agent_reasoning_effort,
                ),
                tool_client=assistant_tool_client,
                max_tool_calls=settings.assistant_agent_max_tool_calls,
                retriever=QdrantEvidenceRetriever(evidence_service),
            ),
            timeout_seconds=settings.assistant_agent_timeout_seconds,
        )
    return ApplicationContainer(
        combination_review_service=CombinationReviewService(combination_agent, settings.openai_model),
        application_preparation_service=ApplicationPreparationService(application_preparation_agent, settings.openai_model),
        support_program_ranking_service=SupportProgramRankingService(ranking_agent),
        support_program_conversation_service=SupportProgramConversationService(conversation_agent),
        assistant_service=AssistantService(assistant_agent),
        assistant_agent_service=assistant_agent_service,
        assistant_tool_client=assistant_tool_client,
        openai_client=openai_client,
        qdrant_client=qdrant_client,
        support_program_index_service=SupportProgramIndexService(
            openai_client,
            qdrant_client,
            embedding_model=settings.openai_embedding_model,
            embedding_dimensions=settings.openai_embedding_dimensions,
            embedding_timeout_seconds=settings.embedding_timeout_seconds,
        ),
        support_program_evidence_service=evidence_service,
        support_program_evidence_answer_service=SupportProgramEvidenceAnswerService(
            evidence_answer_agent,
        ),
    )


def _chat_model(settings: Settings, model: str, reasoning_effort: str) -> ChatOpenAI:
    """LangChain용 OpenAI Responses 모델. 재시도 없음, 저장 안 함, 제한 시간은 도우미 모델과 같다."""
    return ChatOpenAI(
        model=model, api_key=settings.openai_api_key, use_responses_api=True, store=False,
        reasoning={"effort": reasoning_effort}, timeout=settings.llm_model_timeout_seconds, max_retries=0,
    )
