from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI
from app.combination_review.router import router as combination_review_router
from app.application_preparation.agent import ApplicationPreparationAgent
from app.application_preparation.router import router as application_preparation_router
from app.assistant.agent import AssistantAgent
from app.assistant.router import router as assistant_router
from app.assistant_agent.router import router as assistant_agent_router
from app.assistant_agent.service import AssistantAgentService

from app.health.router import router as health_router
from app.support_program_evidence.agent import SupportProgramEvidenceAnswerAgent
from app.support_program_evidence.router import router as support_program_evidence_router
from app.support_program_ranking.agent import SupportProgramRecommendationAgent
from app.support_program_ranking.router import router as support_program_rankings_router
from app.bootstrap import build_application_container
from app.config import Settings
from app.support_program_index.router import router as support_program_index_router
from app.support_program_conversation.agent import SupportProgramConversationAgent
from app.support_program_conversation.router import router as support_program_conversation_router


def create_app(
    *,
    settings: Settings | None = None,
    support_program_recommendation_agent: SupportProgramRecommendationAgent | None = None,
    support_program_evidence_answer_agent: SupportProgramEvidenceAnswerAgent | None = None,
    support_program_conversation_agent: SupportProgramConversationAgent | None = None,
    application_preparation_agent: ApplicationPreparationAgent | None = None,
    assistant_agent: AssistantAgent | None = None,
    assistant_agent_service: AssistantAgentService | None = None,
) -> FastAPI:
    """FastAPI 객체를 조립하는 애플리케이션 팩토리다."""
    container = build_application_container(
        settings or Settings.from_environment(),
        support_program_recommendation_agent=support_program_recommendation_agent,
        support_program_evidence_answer_agent=support_program_evidence_answer_agent,
        support_program_conversation_agent=support_program_conversation_agent,
        application_preparation_agent=application_preparation_agent,
        assistant_agent=assistant_agent,
        assistant_agent_service=assistant_agent_service,
    )

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncGenerator[None]:
        # Uvicorn 기본 설정은 app 로그를 출력하지 않는다. 외부 라이브러리의 로그 수준은 유지한다.
        application_logger = logging.getLogger("app")
        application_logger.setLevel(logging.INFO)
        if not application_logger.hasHandlers():
            handler = logging.StreamHandler()
            handler.set_name("govbiz_application")
            handler.setLevel(logging.INFO)
            handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
            application_logger.addHandler(handler)
        try:
            yield
        finally:
            await application.state.container.close()

    application = FastAPI(
        title="GovBiz AI Service",
        description="GovBiz Core API가 내부에서 호출하는 AI 분석 서비스",
        version="0.1.0",
        lifespan=lifespan,
    )
    application.state.container = container
    application.include_router(health_router)
    application.include_router(combination_review_router)
    application.include_router(application_preparation_router)
    application.include_router(support_program_rankings_router)
    application.include_router(support_program_index_router)
    application.include_router(support_program_evidence_router)
    application.include_router(support_program_conversation_router)
    application.include_router(assistant_router)
    application.include_router(assistant_agent_router)
    return application
