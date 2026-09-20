import json

import pytest
from tests.langchain_stub import ResponsesChatStub, response_message
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.support_program_ranking.errors import AgentExecutionError, AgentFailureCode, AgentTimeoutError
from app.support_program_ranking.agent import SupportProgramRecommendationAgent
from app.support_program_ranking.models import (
    SCORING_VERSION,
    AssessedSupportProgram,
    ScoredSupportProgram,
    SupportProgramEligibility,
    SupportProgramCompanyConditions,
    SupportProgramRankingOutput,
    SupportProgramRankingRequest,
)
from app.config import Settings
from app.main import create_app


TEST_SETTINGS = Settings(
    openai_api_key="test-key",
    openai_model="unused-model",
    llm_model_timeout_seconds=2.0,
    llm_run_timeout_seconds=2.5,
)


def score(
    program_id: str,
    semantic: int,
    *,
    target_eligibility: SupportProgramEligibility = SupportProgramEligibility.MATCH,
    region_eligibility: SupportProgramEligibility = SupportProgramEligibility.MATCH,
    support_type: int = 5,
    target_quote: str = "기업",
    region_quote: str = "지원",
) -> AssessedSupportProgram:
    return AssessedSupportProgram(
        programId=program_id,
        semanticRelevance=semantic,
        targetAssessment={
            "eligibility": target_eligibility,
            "evidence": [] if target_eligibility is SupportProgramEligibility.UNKNOWN else [{"field": "SUMMARY", "quote": target_quote}],
            "explanation": "기업 유형 확인 필요" if target_eligibility is SupportProgramEligibility.UNKNOWN else "본문의 기업 조건을 비교했습니다.",
        },
        regionAssessment={
            "eligibility": region_eligibility,
            "evidence": [] if region_eligibility is SupportProgramEligibility.UNKNOWN else [{"field": "SUMMARY", "quote": region_quote}],
            "explanation": "소재지 조건 확인 필요" if region_eligibility is SupportProgramEligibility.UNKNOWN else "본문의 지역 조건을 비교했습니다.",
        },
        supportTypeFit=support_type,
        recommendationReasons=["공고 원문 근거"],
    )


class SuccessfulAgent(SupportProgramRecommendationAgent):
    def __init__(self) -> None:
        self.requests: list[SupportProgramRankingRequest] = []

    async def rank(
        self,
        request: SupportProgramRankingRequest,
    ) -> SupportProgramRankingOutput:
        self.requests.append(request)
        return SupportProgramRankingOutput(
            rankings=[score("BIZINFO:program-low", 20), score("BIZINFO:program-high", 40)]
        )


class MissingCandidateAgent(SupportProgramRecommendationAgent):
    def __init__(self) -> None:
        pass

    async def rank(
        self,
        request: SupportProgramRankingRequest,
    ) -> SupportProgramRankingOutput:
        return SupportProgramRankingOutput(rankings=[score("BIZINFO:program-high", 40)])


class BelowSemanticMinimumAgent(SupportProgramRecommendationAgent):
    def __init__(self) -> None:
        pass

    async def rank(
        self,
        request: SupportProgramRankingRequest,
    ) -> SupportProgramRankingOutput:
        return SupportProgramRankingOutput(
            rankings=[score("BIZINFO:program-low", 19), score("BIZINFO:program-high", 40)]
        )


class RelevantLowTotalAgent(SupportProgramRecommendationAgent):
    def __init__(self) -> None:
        pass

    async def rank(
        self,
        request: SupportProgramRankingRequest,
    ) -> SupportProgramRankingOutput:
        return SupportProgramRankingOutput(
            rankings=[
                score(
                    "BIZINFO:program-low",
                    20,
                    support_type=9,
                ),
                score("BIZINFO:program-high", 40),
            ]
        )


class NoEligibleCandidateAgent(SupportProgramRecommendationAgent):
    def __init__(self) -> None:
        pass

    async def rank(
        self,
        request: SupportProgramRankingRequest,
    ) -> SupportProgramRankingOutput:
        return SupportProgramRankingOutput(
            rankings=[score("BIZINFO:program-low", 0), score("BIZINFO:program-high", 19)]
        )


class FixedOutputAgent(SupportProgramRecommendationAgent):
    def __init__(self, rankings: list[AssessedSupportProgram]) -> None:
        self._rankings = rankings

    async def rank(
        self,
        request: SupportProgramRankingRequest,
    ) -> SupportProgramRankingOutput:
        return SupportProgramRankingOutput(rankings=self._rankings)


def request_body() -> dict[str, object]:
    return {
        "originalQuery": "서울 AI 창업기업 지원",
        "scoringVersion": SCORING_VERSION,
        "resultLimit": 2,
        "candidates": [
            {
                "id": "BIZINFO:program-low",
                "title": "일반 창업 지원",
                "organization": "기관",
                "summary": "창업기업 지원",
                "categories": ["창업"],
                "regions": ["전국"],
                "targetDescription": "창업기업",
                "applicationPeriod": "상시 접수",
                "status": "OPEN",
                "sourceTextTruncated": False,
            },
            {
                "id": "BIZINFO:program-high",
                "title": "서울 AI 창업기업 지원",
                "organization": "기관",
                "summary": "서울 AI 기업 사업화 지원",
                "categories": ["AI", "창업"],
                "regions": ["서울"],
                "targetDescription": "서울 AI 창업기업",
                "applicationPeriod": "상시 접수",
                "status": "OPEN",
                "sourceTextTruncated": False,
            },
        ],
    }


def single_candidate_request_body(
    *,
    query: str,
    program_id: str,
    title: str,
    summary: str,
    regions: list[str],
    target_description: str,
) -> dict[str, object]:
    return {
        "originalQuery": query,
        "scoringVersion": SCORING_VERSION,
        "resultLimit": 1,
        "candidates": [
            {
                "id": program_id,
                "title": title,
                "organization": "기관",
                "summary": summary,
                "categories": ["AI"],
                "regions": regions,
                "targetDescription": target_description,
                "applicationPeriod": "상시 접수",
                "status": "OPEN",
            }
        ],
    }


def test_returns_llm_scores_sorted_by_total_score() -> None:
    agent = SuccessfulAgent()
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=agent,
        )
    )

    response = client.post(
        "/internal/v1/support-program-rankings/rank",
        json=request_body(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["originalQuery"] == "서울 AI 창업기업 지원"
    assert body["scoringVersion"] == SCORING_VERSION
    assert [item["programId"] for item in body["rankings"]] == [
        "BIZINFO:program-high",
        "BIZINFO:program-low",
    ]
    assert body["rankings"][0]["totalScore"] == 90
    assert not {"targetFit", "regionFit", "applicationStatusFit"} & body["rankings"][0].keys()
    assert body["rankings"][0]["targetEligibility"] == "MATCH"
    assert body["rankings"][0]["regionEligibility"] == "MATCH"
    assert "targetAssessment" not in body["rankings"][0]
    assert "regionAssessment" not in body["rankings"][0]
    assert len(agent.requests) == 1


def test_computes_relevance_total_in_service_and_keeps_v5_http_contract() -> None:
    # 모델이 총점을 계산하지 않는 기존 회귀를 v5 관련도 산식으로 유지한다.
    output = SupportProgramRankingOutput(
        rankings=[
            score(
                "BIZINFO:program-low",
                24,
                support_type=7,
            ),
            # 자격 상태와 무관하게 의미 관련성 20 미만은 제외한다.
            score(
                "BIZINFO:program-high",
                10,
                target_eligibility=SupportProgramEligibility.UNKNOWN,
                support_type=2,
            ),
        ]
    )
    selections = {
        "rankings": {
            assessment.program_id: assessment.model_dump(by_alias=True, exclude={"program_id"})
            for assessment in output.rankings
        }
    }
    for assessment in selections["rankings"].values():
        for dimension in ("targetAssessment", "regionAssessment"):
            assessment[dimension]["evidence"] = [0] if assessment[dimension]["evidence"] else []
    llm_output = json.dumps(selections, ensure_ascii=False)
    assert "totalScore" not in llm_output
    model = ResponsesChatStub([[response_message(llm_output)]])
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=SupportProgramRecommendationAgent(
                model=model.model,
                model_timeout_seconds=2.0,
                run_timeout_seconds=2.5,
            ),
        )
    )

    response = client.post("/internal/v1/support-program-rankings/rank", json=request_body())

    assert response.status_code == 200
    assert response.json() == {
        "originalQuery": "서울 AI 창업기업 지원",
        "scoringVersion": SCORING_VERSION,
        "rankings": [{
            "programId": "BIZINFO:program-low",
            "semanticRelevance": 24,
            "targetEligibility": "MATCH",
            "targetEvidence": [{"field": "SUMMARY", "quote": "창업기업 지원"}],
            "targetExplanation": "본문의 기업 조건을 비교했습니다.",
            "regionEligibility": "MATCH",
            "regionEvidence": [{"field": "SUMMARY", "quote": "창업기업 지원"}],
            "regionExplanation": "본문의 지역 조건을 비교했습니다.",
            "supportTypeFit": 7,
            "totalScore": 62,
            "recommendationReasons": ["공고 원문 근거"],
        }],
    }
    assert len(model.calls) == 1
    model.assert_complete()


def test_keeps_input_order_for_ties_and_applies_result_limit() -> None:
    body = request_body()
    body["resultLimit"] = 1
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=FixedOutputAgent([
                score("BIZINFO:program-high", 40),
                score("BIZINFO:program-low", 40),
            ]),
        )
    )

    response = client.post("/internal/v1/support-program-rankings/rank", json=body)

    assert response.status_code == 200
    assert [item["programId"] for item in response.json()["rankings"]] == ["BIZINFO:program-low"]


@pytest.mark.parametrize("dimension", ["targetAssessment", "regionAssessment"])
def test_invalid_llm_eligibility_returns_503_without_retry_or_fallback(dimension: str) -> None:
    output = SupportProgramRankingOutput(rankings=[
        score("BIZINFO:program-low", 40), score("BIZINFO:program-high", 40),
    ])
    payload = {"rankings": {
        assessment.program_id: assessment.model_dump(by_alias=True, exclude={"program_id"})
        for assessment in output.rankings
    }}
    for assessment in payload["rankings"].values():
        for axis in ("targetAssessment", "regionAssessment"):
            assessment[axis]["evidence"] = [0]
    payload["rankings"]["BIZINFO:program-low"][dimension].update(eligibility="INCOMPATIBLE", score=4)
    model = ResponsesChatStub([[response_message(json.dumps(payload, ensure_ascii=False))]])
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=SupportProgramRecommendationAgent(
                model=model.model,
                model_timeout_seconds=2.0,
                run_timeout_seconds=2.5,
            ),
        )
    )

    response = client.post("/internal/v1/support-program-rankings/rank", json=request_body())

    assert response.status_code == 503
    assert response.json() == {"detail": "Support program ranking is temporarily unavailable."}
    assert len(model.calls) == 1


def test_keeps_candidates_with_the_same_original_id_from_different_sources_distinct() -> None:
    body = request_body()
    body["candidates"][0]["id"] = "BIZINFO:PBLN_001"  # type: ignore[index]
    body["candidates"][1]["id"] = "KSTARTUP:PBLN_001"  # type: ignore[index]
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=FixedOutputAgent(
                [
                    score("KSTARTUP:PBLN_001", 40),
                    score("BIZINFO:PBLN_001", 20),
                ]
            ),
        )
    )

    response = client.post(
        "/internal/v1/support-program-rankings/rank",
        json=body,
    )

    assert response.status_code == 200
    assert [item["programId"] for item in response.json()["rankings"]] == [
        "KSTARTUP:PBLN_001",
        "BIZINFO:PBLN_001",
    ]


def test_accepts_the_maximum_length_canonical_program_id() -> None:
    canonical_id = f"{'S' * 64}:{'P' * 255}"
    body = request_body()
    body["resultLimit"] = 1
    body["candidates"] = [body["candidates"][0]]  # type: ignore[index]
    body["candidates"][0]["id"] = canonical_id  # type: ignore[index]
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=FixedOutputAgent([score(canonical_id, 40)]),
        )
    )

    response = client.post(
        "/internal/v1/support-program-rankings/rank",
        json=body,
    )

    assert len(canonical_id) == 320
    assert response.status_code == 200
    assert response.json()["rankings"][0]["programId"] == canonical_id


def test_filters_a_candidate_below_the_semantic_relevance_minimum() -> None:
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=BelowSemanticMinimumAgent(),
        )
    )

    response = client.post(
        "/internal/v1/support-program-rankings/rank",
        json=request_body(),
    )

    assert response.status_code == 200
    assert [item["programId"] for item in response.json()["rankings"]] == [
        "BIZINFO:program-high"
    ]


def test_keeps_relevant_candidate_below_the_former_total_score_minimum() -> None:
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=RelevantLowTotalAgent(),
        )
    )

    response = client.post(
        "/internal/v1/support-program-rankings/rank",
        json=request_body(),
    )

    assert response.status_code == 200
    assert [item["programId"] for item in response.json()["rankings"]] == [
        "BIZINFO:program-high", "BIZINFO:program-low"
    ]
    assert response.json()["rankings"][1]["totalScore"] == 58


def test_returns_an_empty_ranking_when_no_candidate_meets_the_minimum() -> None:
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=NoEligibleCandidateAgent(),
        )
    )

    response = client.post(
        "/internal/v1/support-program-rankings/rank",
        json=request_body(),
    )

    assert response.status_code == 200
    assert response.json()["rankings"] == []


def test_excludes_explicit_busan_region_mismatch_despite_high_score() -> None:
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=FixedOutputAgent(
                [
                    score(
                        "BIZINFO:program-busan",
                        40,
                        region_eligibility=SupportProgramEligibility.INCOMPATIBLE,
                        support_type=10,
                    )
                ]
            ),
        )
    )
    body = single_candidate_request_body(
        query="서울 소재 AI 기업 지원",
        program_id="BIZINFO:program-busan",
        title="부산 AI 기업 사업화 지원",
        summary="부산 소재 AI 기업의 사업화를 지원합니다.",
        regions=["부산"],
        target_description="부산 소재 중소기업",
    )

    response = client.post(
        "/internal/v1/support-program-rankings/rank",
        json=body,
    )

    assert response.status_code == 200
    assert response.json()["rankings"] == []


def test_excludes_explicit_pre_startup_target_mismatch_despite_high_score() -> None:
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=FixedOutputAgent(
                [
                    score(
                        "BIZINFO:program-pre-startup",
                        40,
                        target_eligibility=SupportProgramEligibility.INCOMPATIBLE,
                        target_quote="예비창업자",
                        support_type=10,
                    )
                ]
            ),
        )
    )
    body = single_candidate_request_body(
        query="서울 소재 기창업 AI 기업 지원",
        program_id="BIZINFO:program-pre-startup",
        title="서울 AI 예비창업자 지원",
        summary="서울 예비창업자의 AI 사업화를 지원합니다.",
        regions=["서울"],
        target_description="예비창업자",
    )

    response = client.post(
        "/internal/v1/support-program-rankings/rank",
        json=body,
    )

    assert response.status_code == 200
    assert response.json()["rankings"] == []


def test_keeps_a_candidate_when_target_and_region_information_are_unknown() -> None:
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=FixedOutputAgent(
                [
                    score(
                        "BIZINFO:program-unknown",
                        40,
                        target_eligibility=SupportProgramEligibility.UNKNOWN,
                        region_eligibility=SupportProgramEligibility.UNKNOWN,
                        support_type=10,
                    )
                ]
            ),
        )
    )
    body = single_candidate_request_body(
        query="AI 사업화 지원",
        program_id="BIZINFO:program-unknown",
        title="AI 사업화 지원",
        summary="AI 기술 사업화를 지원합니다.",
        regions=["전국"],
        target_description="지원 대상은 공고문 참고",
    )

    response = client.post(
        "/internal/v1/support-program-rankings/rank",
        json=body,
    )

    assert response.status_code == 200
    assert [item["programId"] for item in response.json()["rankings"]] == [
        "BIZINFO:program-unknown"
    ]
    assert response.json()["rankings"][0]["targetEligibility"] == "UNKNOWN"
    assert response.json()["rankings"][0]["regionEligibility"] == "UNKNOWN"


def test_rejects_an_agent_output_that_omits_a_candidate_without_leaking_details() -> None:
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=MissingCandidateAgent(),
        )
    )

    response = client.post(
        "/internal/v1/support-program-rankings/rank",
        json=request_body(),
    )

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Support program ranking is temporarily unavailable."
    }
    assert "program-high" not in response.text


@pytest.mark.parametrize("timed_out,status_code,kind", [(True, 504, "timeout"), (False, 503, "execution")])
@pytest.mark.parametrize("reason_code", [None, *AgentFailureCode, "private untrusted reason"])
def test_logs_only_safe_failure_metadata_and_distinguishes_timeout(monkeypatch, caplog, timed_out, status_code, kind, reason_code):
    from unittest.mock import AsyncMock
    import app.support_program_ranking.router as router_module
    cause = TimeoutError("private upstream body sk-private-key") if timed_out else ValueError("private upstream response")
    error = AgentTimeoutError("private timeout") if timed_out else AgentExecutionError("private invalid output")
    if reason_code is not None:
        error.reason_code = reason_code
    error.__cause__ = cause
    service = AsyncMock()
    service.rank.side_effect = error
    application = create_app(settings=TEST_SETTINGS, support_program_recommendation_agent=SuccessfulAgent())
    application.dependency_overrides[router_module.get_support_program_ranking_service] = lambda: service
    times = iter([100.0, 100.125])
    monkeypatch.setattr(router_module, "perf_counter", lambda: next(times))
    payload = request_body()
    payload["originalQuery"] = "비공개 질문"
    payload["companyConditions"] = {"region": "비공개 지역", "referenceDate": "2026-09-07"}
    with TestClient(application) as client:
        response = client.post("/internal/v1/support-program-rankings/rank", json=payload)
    assert response.status_code == status_code
    expected_detail = "Support program ranking timed out." if timed_out else "Support program ranking is temporarily unavailable."
    assert response.json() == {"detail": expected_detail}
    records = [record for record in caplog.records if record.name == router_module.__name__]
    assert len(records) == 1
    expected_code = reason_code if isinstance(reason_code, AgentFailureCode) else AgentFailureCode.EXECUTION_FAILED
    assert records[0].getMessage() == (
        f"support_program_ranking_failed failure_kind={kind} reason_code={expected_code.value} "
        f"error_type={type(cause).__name__} candidate_count=2 elapsed_ms=125"
    )
    assert records[0].exc_info is None and records[0].stack_info is None
    assert all(secret not in records[0].getMessage() + response.text for secret in ("private", "비공개", "창업기업"))
    service.rank.assert_awaited_once()


@pytest.mark.parametrize(
    "mutation",
    [
        lambda body: body.pop("scoringVersion"),
        lambda body: body.update({"originalQuery": "   "}),
        lambda body: body.update({"originalQuery": "가" * 501}),
        lambda body: body.update({"scoringVersion": "stale-version"}),
        lambda body: body.update({"unknown": "value"}),
        lambda body: body["candidates"].append(body["candidates"][0]),
        lambda body: body["candidates"][0].update({"id": "PBLN_001"}),
        lambda body: body["candidates"][0].update({"id": "BIZINFO: PBLN_001"}),
        lambda body: body["candidates"][0].update({"id": "BIZINFO:PBLN_001 "}),
        lambda body: body["candidates"][0].update({"id": "BIZINFO:PBLN\u200b_001"}),
        lambda body: body["candidates"][0].update({"id": f"BIZINFO:{'P' * 256}"}),
    ],
)
def test_rejects_invalid_requests(mutation) -> None:  # type: ignore[no-untyped-def]
    body = request_body()
    mutation(body)
    client = TestClient(
        create_app(
            settings=TEST_SETTINGS,
            support_program_recommendation_agent=SuccessfulAgent(),
        )
    )

    assert client.post(
        "/internal/v1/support-program-rankings/rank",
        json=body,
    ).status_code == 422


def test_forwards_normalized_confirmed_company_conditions_to_the_existing_agent() -> None:
    agent = SuccessfulAgent()
    body = request_body()
    body["companyConditions"] = {
        "region": " 서울 ", "industry": " 소프트웨어 개발업 ", "establishedOn": "2024-02-29",
        "supportPurpose": " 기술 사업화 ", "referenceDate": "2026-09-07",
    }
    with TestClient(create_app(settings=TEST_SETTINGS, support_program_recommendation_agent=agent)) as client:
        response = client.post("/internal/v1/support-program-rankings/rank", json=body)

    assert response.status_code == 200
    assert len(agent.requests) == 1
    request = agent.requests[0]
    assert request.original_query == body["originalQuery"]
    assert request.company_conditions.model_dump(mode="json", by_alias=True) == {
        "region": "서울", "industry": "소프트웨어 개발업", "establishedOn": "2024-02-29",
        "supportPurpose": "기술 사업화", "referenceDate": "2026-09-07",
    }


@pytest.mark.parametrize("include_null", [False, True])
def test_absent_company_conditions_do_not_add_a_field_to_the_v5_serialized_request(include_null) -> None:
    body = request_body()
    original_json = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    if include_null:
        body["companyConditions"] = None
    request = SupportProgramRankingRequest.model_validate(body)
    assert request.company_conditions is None
    assert request.model_dump_json(by_alias=True) == original_json


@pytest.mark.parametrize("value", [None, "", "   "])
def test_blank_company_fields_remain_unknown(value) -> None:
    conditions = SupportProgramCompanyConditions.model_validate({
        "region": value, "industry": value, "establishedOn": value,
        "supportPurpose": value, "referenceDate": "2026-09-07",
    })
    assert conditions.model_dump(mode="json", by_alias=True) == {
        "region": None, "industry": None, "establishedOn": None,
        "supportPurpose": None, "referenceDate": "2026-09-07",
    }


@pytest.mark.parametrize("established_on", ["1900-01-01", "2024-02-29", "2026-09-07"])
def test_company_dates_include_the_calendar_and_reference_boundaries(established_on) -> None:
    conditions = SupportProgramCompanyConditions.model_validate({
        "establishedOn": established_on, "referenceDate": "2026-09-07",
    })
    assert conditions.established_on.isoformat() == established_on


def test_company_condition_text_limits_count_unicode_code_points_after_trimming() -> None:
    conditions = SupportProgramCompanyConditions.model_validate({
        "region": " " + "🔎" * 50 + " ", "industry": " " + "업" * 100 + " ",
        "supportPurpose": " " + "🔎" * 100 + " ", "referenceDate": "2026-09-07",
    })
    assert len(conditions.region) == 50
    assert len(conditions.industry) == len(conditions.support_purpose) == 100


@pytest.mark.parametrize("conditions", [
    {},
    {"referenceDate": None},
    {"referenceDate": "2026-02-29"},
    {"referenceDate": "20260907"},
    {"referenceDate": " 2026-09-07 "},
    {"referenceDate": "2026-09-07T00:00:00"},
    {"referenceDate": 0},
    {"referenceDate": True},
    {"establishedOn": "1899-12-31", "referenceDate": "2026-09-07"},
    {"establishedOn": "2026-09-08", "referenceDate": "2026-09-07"},
    {"establishedOn": "2025-02-29", "referenceDate": "2026-09-07"},
    {"establishedOn": "2026-04-31", "referenceDate": "2026-09-07"},
    {"establishedOn": "2026-W01-1", "referenceDate": "2026-09-07"},
    {"establishedOn": "20260907", "referenceDate": "2026-09-07"},
    {"establishedOn": " 2024-02-29 ", "referenceDate": "2026-09-07"},
    {"establishedOn": "\t", "referenceDate": "2026-09-07"},
    {"establishedOn": "\n", "referenceDate": "2026-09-07"},
    {"establishedOn": "\u00a0", "referenceDate": "2026-09-07"},
    {"establishedOn": "2026-09-07T00:00:00", "referenceDate": "2026-09-07"},
    {"establishedOn": 0, "referenceDate": "2026-09-07"},
    {"establishedOn": True, "referenceDate": "2026-09-07"},
    {"region": "가" * 51, "referenceDate": "2026-09-07"},
    {"industry": "가" * 101, "referenceDate": "2026-09-07"},
    {"supportPurpose": "가" * 101, "referenceDate": "2026-09-07"},
    {"region": "서울\u200b", "referenceDate": "2026-09-07"},
    {"region": "\n서울", "referenceDate": "2026-09-07"},
    {"industry": "\t정보통신업", "referenceDate": "2026-09-07"},
    {"supportPurpose": "사업화\r", "referenceDate": "2026-09-07"},
    {"region": "\t", "referenceDate": "2026-09-07"},
    {"industry": "정보\n통신업", "referenceDate": "2026-09-07"},
    {"supportPurpose": "지원\u0000", "referenceDate": "2026-09-07"},
    {"unexpected": "value", "referenceDate": "2026-09-07"},
])
def test_invalid_company_conditions_are_rejected_before_agent_execution(conditions) -> None:
    agent = SuccessfulAgent()
    body = {**request_body(), "companyConditions": conditions}
    with TestClient(create_app(settings=TEST_SETTINGS, support_program_recommendation_agent=agent)) as client:
        response = client.post("/internal/v1/support-program-rankings/rank", json=body)
    assert response.status_code == 422
    assert not agent.requests


def test_score_schema_requires_the_total_to_equal_normalized_relevance() -> None:
    with pytest.raises(ValidationError, match="totalScore"):
        ScoredSupportProgram(
            programId="BIZINFO:program-1",
            semanticRelevance=40,
            targetEligibility=SupportProgramEligibility.MATCH,
            targetEvidence=[{"field": "SUMMARY", "quote": "기업"}],
            targetExplanation="기업 조건 근거",
            regionEligibility=SupportProgramEligibility.MATCH,
            regionEvidence=[{"field": "SUMMARY", "quote": "지원"}],
            regionExplanation="지역 조건 근거",
            supportTypeFit=10,
            totalScore=99,
            recommendationReasons=["근거"],
        )


@pytest.mark.parametrize(
    "program_id",
    [
        "BIZINFO:",
        "BIZINFO: PBLN_001",
        "BIZINFO:PBLN_001 ",
        "BIZINFO:PBLN\u0000_001",
        "BIZINFO:PBLN\u200b_001",
        f"BIZINFO:{'P' * 256}",
    ],
)
def test_score_schema_requires_a_canonical_program_id(program_id: str) -> None:
    with pytest.raises(ValidationError, match="canonical sourceCode:sourceProgramId"):
        score(program_id, 40)


@pytest.mark.parametrize("legacy_field", ["targetFit", "regionFit", "applicationStatusFit"])
def test_v5_score_schema_rejects_removed_eligibility_score_fields(legacy_field: str) -> None:
    with pytest.raises(ValidationError, match=legacy_field):
        ScoredSupportProgram(
            programId="BIZINFO:program-1",
            semanticRelevance=40,
            targetEligibility=SupportProgramEligibility.MATCH,
            targetEvidence=[{"field": "SUMMARY", "quote": "기업"}],
            targetExplanation="기업 조건 근거",
            regionEligibility=SupportProgramEligibility.MATCH,
            regionEvidence=[{"field": "SUMMARY", "quote": "지원"}],
            regionExplanation="지역 조건 근거",
            supportTypeFit=5,
            totalScore=90,
            recommendationReasons=["공고 원문 근거"],
            **{legacy_field: 1},
        )


def test_registered_year_is_preserved_without_an_assumed_date():
    conditions = SupportProgramCompanyConditions(foundedYear=2021, referenceDate="2026-09-16")
    assert conditions.model_dump(by_alias=True)["foundedYear"] == 2021
    assert conditions.established_on is None


@pytest.mark.parametrize("invalid", [
    {"foundedYear": 2027}, {"foundedYear": 1899}, {"foundedYear": "2021"},
    {"foundedYear": True}, {"foundedYear": 2021.5},
    {"foundedYear": 2021, "establishedOn": "2021-01-01"},
])
def test_rejects_invalid_or_conflicting_registered_year(invalid):
    with pytest.raises(ValidationError):
        SupportProgramCompanyConditions(referenceDate="2026-09-16", **invalid)


def test_selection_logs_count_exclusion_reasons_once_and_keep_unknown_without_private_data(caplog) -> None:
    body = request_body()
    body["candidates"] = [
        {**body["candidates"][0], "id": f"BIZINFO:diagnostic-{index}"}
        for index in range(6)
    ]
    body["resultLimit"] = 2
    unknown, incompatible = SupportProgramEligibility.UNKNOWN, SupportProgramEligibility.INCOMPATIBLE
    agent = FixedOutputAgent([
        score("BIZINFO:diagnostic-0", 19, target_eligibility=incompatible, region_eligibility=incompatible),
        score("BIZINFO:diagnostic-1", 40, target_eligibility=incompatible, region_eligibility=incompatible),
        score("BIZINFO:diagnostic-2", 40, region_eligibility=incompatible),
        score("BIZINFO:diagnostic-3", 40, target_eligibility=unknown, region_eligibility=unknown),
        score("BIZINFO:diagnostic-4", 40),
        score("BIZINFO:diagnostic-5", 40),
    ])
    client = TestClient(create_app(settings=TEST_SETTINGS, support_program_recommendation_agent=agent))

    with caplog.at_level("INFO", logger="app.support_program_ranking.service"):
        first = client.post("/internal/v1/support-program-rankings/rank", json=body)
        cached = client.post("/internal/v1/support-program-rankings/rank", json=body)

    assert first.status_code == cached.status_code == 200
    assert first.json() == cached.json()
    assert [item["programId"] for item in first.json()["rankings"]] == [
        "BIZINFO:diagnostic-3", "BIZINFO:diagnostic-4",
    ]
    assert first.json()["rankings"][0]["targetEligibility"] == "UNKNOWN"
    messages = [record.getMessage() for record in caplog.records
                if record.getMessage().startswith("support_program_ranking_selection ")]
    assert messages == [
        "support_program_ranking_selection candidate_count=6 eligible_count=3 selected_count=2 "
        "excluded_low_relevance=1 excluded_target=1 excluded_region=1 "
        "selected_target_unknown=1 selected_region_unknown=1"
    ]
    assert body["originalQuery"] not in caplog.text
    assert "BIZINFO:diagnostic-" not in caplog.text
    assert "기업 유형 확인 필요" not in caplog.text
