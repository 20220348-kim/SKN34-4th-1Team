from fastapi.testclient import TestClient

from app.support_program_ranking.agent import SupportProgramRecommendationAgent
from app.support_program_ranking.models import (
    SupportProgramRankingOutput,
    SupportProgramRankingRequest,
)
from app.config import Settings
from app.main import create_app


class NeverCalledAgent(SupportProgramRecommendationAgent):
    def __init__(self) -> None:
        pass

    async def rank(
        self,
        request: SupportProgramRankingRequest,
    ) -> SupportProgramRankingOutput:
        raise AssertionError("health tests must not invoke the agent")


client = TestClient(
    create_app(
        settings=Settings(
            openai_api_key="test-key",
            openai_model="test-model",
            llm_model_timeout_seconds=2.0,
            llm_run_timeout_seconds=2.5,
        ),
        support_program_recommendation_agent=NeverCalledAgent(),
    )
)


def test_returns_typed_health_response() -> None:
    response = client.get("/internal/v1/health")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {
        "status": "up",
        "service": "govbiz-ai-service",
    }
