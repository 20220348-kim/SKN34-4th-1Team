import subprocess
import sys
import textwrap

import pytest


@pytest.mark.parametrize("existing_handler_owner", [None, "root", "app"])
def test_uvicorn_lifespan_emits_safe_service_info_once_without_enabling_library_info(existing_handler_owner):
    # pytest의 root capture handler가 운영 기본 설정의 INFO 누락을 가리지 않게 별도 프로세스로 확인한다.
    script = textwrap.dedent("""
        import asyncio
        import logging
        import logging.config
        from types import SimpleNamespace
        from unittest.mock import AsyncMock

        from uvicorn.config import LOGGING_CONFIG

        logging.config.dictConfig(LOGGING_CONFIG)
        existing_handler_owner = EXISTING_HANDLER_OWNER
        if existing_handler_owner is not None:
            logger = logging.getLogger() if existing_handler_owner == "root" else logging.getLogger("app")
            logger.addHandler(logging.StreamHandler())

        from app import main
        from app.config import Settings
        from app.support_program_ranking.models import (
            SCORING_VERSION, AssessedSupportProgram, SupportProgramRankingOutput, SupportProgramRankingRequest,
        )
        from app.support_program_ranking.service import SupportProgramRankingService

        request = SupportProgramRankingRequest.model_validate({
            "originalQuery": "비공개 검색어", "scoringVersion": SCORING_VERSION, "resultLimit": 1,
            "candidates": [{
                "id": "BIZINFO:private-id", "title": "비공개 제목", "organization": "기관",
                "summary": "비공개 본문", "targetDescription": "비공개 대상", "categories": [], "regions": [],
                "applicationPeriod": "상시", "status": "OPEN",
            }],
        })
        assessment = AssessedSupportProgram(
            programId="BIZINFO:private-id", semanticRelevance=35, supportTypeFit=8,
            targetAssessment={"eligibility": "UNKNOWN", "evidence": [], "explanation": "조건 확인"},
            regionAssessment={"eligibility": "UNKNOWN", "evidence": [], "explanation": "지역 확인"},
            recommendationReasons=["사업화 지원"],
        )
        agent = SimpleNamespace(rank=AsyncMock(return_value=SupportProgramRankingOutput(rankings=[assessment])))
        service = SupportProgramRankingService(agent)
        container = SimpleNamespace(close=AsyncMock())
        main.build_application_container = lambda *args, **kwargs: container
        settings = Settings(
            openai_api_key="private-key", openai_model="unused-test-model",
            llm_model_timeout_seconds=1, llm_run_timeout_seconds=2,
        )

        async def verify():
            for _ in range(2):
                application = main.create_app(settings=settings)
                async with application.router.lifespan_context(application):
                    await service.rank(request)
                    logging.getLogger("openai").info("private provider body")
                    logging.getLogger("httpx2").info("private HTTP request")
            assert container.close.await_count == 2
            assert agent.rank.await_count == 1
            application_logger = logging.getLogger("app")
            assert application_logger.getEffectiveLevel() == logging.INFO
            assert len(application_logger.handlers) == (0 if existing_handler_owner == "root" else 1)
            assert logging.getLogger().level == logging.WARNING
            assert not logging.getLogger("openai").isEnabledFor(logging.INFO)
            assert not logging.getLogger("httpx2").isEnabledFor(logging.INFO)

        asyncio.run(verify())
    """).replace("EXISTING_HANDLER_OWNER", repr(existing_handler_owner))

    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=30)

    assert result.returncode == 0, result.stderr
    assert result.stderr.count("support_program_ranking cache_state=") == 2
    assert result.stderr.count("cache_state=miss") == result.stderr.count("cache_state=hit") == 1
    assert "비공개" not in result.stderr
    assert "private" not in result.stderr
    assert not result.stdout
