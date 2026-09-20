import asyncio
import logging
import re
from unittest.mock import AsyncMock

import pytest

from app.support_program_ranking.errors import AgentExecutionError, AgentFailureCode, AgentTimeoutError
from app.support_program_ranking.models import (
    SCORING_VERSION,
    AssessedSupportProgram,
    SupportProgramEligibilityEvidence,
    SupportProgramRankingOutput,
    SupportProgramRankingRequest,
)
from app.support_program_ranking.service import SupportProgramRankingService


@pytest.fixture
def anyio_backend():
    return "asyncio"


def ranking_request(**changes):
    return SupportProgramRankingRequest.model_validate({
        "originalQuery": "서울 중소기업 사업화 지원",
        "scoringVersion": SCORING_VERSION,
        "resultLimit": 2,
        "companyConditions": {
            "region": "서울", "industry": "소프트웨어", "establishedOn": "2024-01-01",
            "supportPurpose": "사업화", "referenceDate": "2026-09-08",
        },
        "candidates": [
            {
                "id": f"BIZINFO:program-{index}", "title": "기업 사업화 지원", "organization": "기관",
                "summary": "서울 소재 중소기업의 사업화를 지원합니다.", "categories": ["사업화", "금융"],
                "regions": ["서울", "전국"], "targetDescription": "서울 소재 중소기업",
                "applicationPeriod": "상시 접수", "status": "OPEN", "sourceTextTruncated": False,
            }
            for index in range(1, 3)
        ],
        **changes,
    })


def valid_output(request):
    return SupportProgramRankingOutput(rankings=[
        AssessedSupportProgram(
            programId=candidate.id,
            semanticRelevance=35,
            targetAssessment={"eligibility": "UNKNOWN", "evidence": [], "explanation": "기업 조건 확인 필요"},
            regionAssessment={"eligibility": "UNKNOWN", "evidence": [], "explanation": "지역 조건 확인 필요"},
            supportTypeFit=8,
            recommendationReasons=["공고의 사업화 지원 내용을 확인했습니다."],
        )
        for candidate in request.candidates
    ])


def successful_agent():
    agent = AsyncMock()
    agent.rank.side_effect = valid_output
    return agent


@pytest.mark.anyio
async def test_identical_request_reuses_response_and_cache_keys_contain_only_a_digest():
    agent = successful_agent()
    service = SupportProgramRankingService(agent)
    first = await service.rank(ranking_request())
    second = await service.rank(ranking_request())
    assert first == second
    assert agent.rank.await_count == 1
    assert len(service._cache) == 1
    assert re.fullmatch(r"[0-9a-f]{64}", next(iter(service._cache)))
    assert service._pending == {}


@pytest.mark.anyio
@pytest.mark.parametrize("path,value", [
    (("originalQuery",), "서울 중소기업 사업화 자금"),
    (("resultLimit",), 1),
    (("companyConditions",), None),
    (("companyConditions", "region"), "경기"),
    (("companyConditions", "industry"), "제조업"),
    (("companyConditions", "establishedOn"), "2024-01-02"),
    (("companyConditions", "supportPurpose"), "융자"),
    (("companyConditions", "referenceDate"), "2026-09-09"),
    (("candidates", 0, "id"), "KSTARTUP:program-1"),
    (("candidates", 0, "title"), "기업 사업화 자금 지원"),
    (("candidates", 0, "organization"), "다른 기관"),
    (("candidates", 0, "summary"), "서울 소재 중소기업의 사업화와 연구개발을 지원합니다."),
    (("candidates", 0, "targetDescription"), "서울 소재 창업기업"),
    (("candidates", 0, "applicationPeriod"), "예산 소진 시까지"),
    (("candidates", 0, "status"), "CLOSED"),
    (("candidates", 0, "sourceTextTruncated"), True),
    (("candidates", 0, "categories"), ["금융", "사업화"]),
    (("candidates", 0, "regions"), ["전국", "서울"]),
])
async def test_every_input_field_invalidates_cache(path, value):
    agent = successful_agent()
    service = SupportProgramRankingService(agent)
    original = ranking_request()
    await service.rank(original)
    payload = original.model_dump(by_alias=True, mode="json")
    parent = payload
    for segment in path[:-1]:
        parent = parent[segment]
    parent[path[-1]] = value
    changed = SupportProgramRankingRequest.model_validate(payload)
    await service.rank(changed)
    await service.rank(changed)
    assert agent.rank.await_count == 2


@pytest.mark.anyio
async def test_candidate_order_count_and_source_beyond_result_limit_invalidate_cache():
    agent = successful_agent()
    service = SupportProgramRankingService(agent)
    request = ranking_request(resultLimit=1)
    first = await service.rank(request)
    reordered = request.model_copy(update={"candidates": list(reversed(request.candidates))})
    second = await service.rank(reordered)
    assert first.rankings[0].program_id == "BIZINFO:program-1"
    assert second.rankings[0].program_id == "BIZINFO:program-2"
    await service.rank(request.model_copy(update={"candidates": request.candidates[:1]}))
    changed_source = request.model_copy(deep=True)
    changed_source.candidates[1] = changed_source.candidates[1].model_copy(update={"summary": "변경된 원문"})
    await service.rank(changed_source)
    assert agent.rank.await_count == 4


@pytest.mark.anyio
async def test_scoring_version_is_part_of_the_key_and_service_instances_do_not_share_model_policy():
    first_agent = successful_agent()
    first_service = SupportProgramRankingService(first_agent)
    request = ranking_request()
    await first_service.rank(request)
    second_agent = successful_agent()
    await SupportProgramRankingService(second_agent).rank(request)
    assert second_agent.rank.await_count == 1

    # 현재 HTTP 계약은 한 버전만 받는다. 향후 버전 필드가 달라져도 이전 응답을 재사용하지 않음을 확인한다.
    future_request = request.model_copy(update={"scoring_version": "future-scoring-version"})
    expected = AgentExecutionError("future policy is unavailable")
    first_agent.rank.side_effect = expected
    with pytest.raises(AgentExecutionError) as caught:
        await first_service.rank(future_request)
    assert caught.value is expected
    assert first_agent.rank.await_count == 2


@pytest.mark.anyio
async def test_cache_ttl_starts_at_success_and_hits_do_not_extend_it(monkeypatch):
    now = [100.0]
    monkeypatch.setattr("app.support_program_ranking.service.monotonic", lambda: now[0])
    agent = successful_agent()

    async def delayed_result(request):
        now[0] += 10
        return valid_output(request)

    agent.rank.side_effect = delayed_result
    service = SupportProgramRankingService(agent, cache_ttl_seconds=30)
    await service.rank(ranking_request())
    now[0] = 139.999
    await service.rank(ranking_request())
    assert agent.rank.await_count == 1
    now[0] = 140.0
    await service.rank(ranking_request())
    assert agent.rank.await_count == 2
    assert len(service._cache) == 1


@pytest.mark.anyio
async def test_lru_eviction_limits_stored_responses_and_expired_entries_are_removed(monkeypatch):
    now = [100.0]
    monkeypatch.setattr("app.support_program_ranking.service.monotonic", lambda: now[0])
    agent = successful_agent()
    service = SupportProgramRankingService(agent, cache_max_entries=2, cache_ttl_seconds=30)
    requests = [ranking_request(originalQuery=f"사업화 지원 {index}") for index in range(3)]
    await service.rank(requests[0])
    await service.rank(requests[1])
    await service.rank(requests[0])
    await service.rank(requests[2])
    assert len(service._cache) == 2
    await service.rank(requests[0])
    assert agent.rank.await_count == 3
    await service.rank(requests[1])
    assert agent.rank.await_count == 4
    assert len(service._cache) == 2
    now[0] = 130.0
    await service.rank(requests[2])
    assert len(service._cache) == 1
    assert agent.rank.await_count == 5


@pytest.mark.anyio
async def test_cache_store_and_returns_are_deep_copies():
    agent = successful_agent()
    output = valid_output(ranking_request())
    output.rankings[0] = output.rankings[0].model_copy(update={
        "target_assessment": output.rankings[0].target_assessment.model_copy(update={
            "evidence": [SupportProgramEligibilityEvidence(field="SUMMARY", quote="서울 소재 중소기업")],
        }),
    })
    agent.rank.side_effect = None
    agent.rank.return_value = output
    service = SupportProgramRankingService(agent)
    first = await service.rank(ranking_request())
    expected = first.model_copy(deep=True)
    first.rankings[0].recommendation_reasons.append("첫 응답을 받은 호출자의 변경")
    first.rankings[0].target_evidence.clear()
    first.rankings.pop()
    output.rankings[0].recommendation_reasons.append("Agent 출력의 후속 변경")
    output.rankings.clear()
    second = await service.rank(ranking_request())
    assert second == expected
    second.rankings[0].recommendation_reasons.clear()
    second.rankings.clear()
    assert await service.rank(ranking_request()) == expected
    assert agent.rank.await_count == 1


@pytest.mark.anyio
async def test_empty_success_is_cached_after_all_candidates_are_validated():
    agent = successful_agent()
    output = valid_output(ranking_request())
    output.rankings[:] = [item.model_copy(update={"semantic_relevance": 19}) for item in output.rankings]
    agent.rank.side_effect = None
    agent.rank.return_value = output
    service = SupportProgramRankingService(agent)
    assert (await service.rank(ranking_request())).rankings == []
    assert (await service.rank(ranking_request())).rankings == []
    assert agent.rank.await_count == 1


@pytest.mark.anyio
@pytest.mark.parametrize("error", [
    AgentExecutionError("sensitive upstream error", reason_code=AgentFailureCode.INVALID_EVIDENCE_SELECTION),
    AgentTimeoutError("sensitive upstream timeout"),
])
async def test_agent_failures_preserve_the_original_exception_and_are_not_cached(error, caplog):
    caplog.set_level(logging.INFO, logger="app.support_program_ranking.service")
    agent = successful_agent()
    agent.rank.side_effect = [error, valid_output(ranking_request())]
    service = SupportProgramRankingService(agent)
    with pytest.raises(type(error)) as caught:
        await service.rank(ranking_request())
    assert caught.value is error
    assert service._cache == service._pending == {}
    assert (await service.rank(ranking_request())).rankings
    assert agent.rank.await_count == 2
    assert str(error) not in caplog.text


@pytest.mark.anyio
@pytest.mark.parametrize("failure", ["candidate_set", "evidence", "score"])
async def test_service_validation_failures_are_not_cached_even_for_excluded_candidates(failure):
    agent = successful_agent()
    invalid = valid_output(ranking_request())
    excluded = invalid.rankings[1].model_copy(update={"semantic_relevance": 19})
    if failure == "candidate_set":
        excluded = excluded.model_copy(update={"program_id": "BIZINFO:unexpected"})
    elif failure == "evidence":
        excluded = AssessedSupportProgram.model_validate({
            **excluded.model_dump(by_alias=True),
            "targetAssessment": {
                "eligibility": "INCOMPATIBLE",
                "evidence": [{"field": "SUMMARY", "quote": "원문에 존재하지 않는 근거"}],
                "explanation": "원문과 다른 근거",
            },
        })
    else:
        excluded = excluded.model_copy(update={"support_type_fit": 11})
    invalid.rankings[1] = excluded
    agent.rank.side_effect = [invalid, valid_output(ranking_request())]
    service = SupportProgramRankingService(agent)
    with pytest.raises(AgentExecutionError):
        await service.rank(ranking_request())
    assert service._cache == service._pending == {}
    assert len((await service.rank(ranking_request())).rankings) == 2
    assert agent.rank.await_count == 2


@pytest.mark.anyio
async def test_concurrent_identical_requests_share_one_agent_call_and_copy_results(caplog):
    caplog.set_level(logging.INFO, logger="app.support_program_ranking.service")
    started, release = asyncio.Event(), asyncio.Event()
    agent = successful_agent()

    async def blocked_result(request):
        started.set()
        await release.wait()
        return valid_output(request)

    agent.rank.side_effect = blocked_result
    service = SupportProgramRankingService(agent)
    first = asyncio.create_task(service.rank(ranking_request()))
    await started.wait()
    second = asyncio.create_task(service.rank(ranking_request()))
    await asyncio.sleep(0)
    release.set()
    first_result, second_result = await asyncio.gather(first, second)
    assert agent.rank.await_count == 1
    assert first_result == second_result
    first_result.rankings.clear()
    assert len(second_result.rankings) == 2
    assert len((await service.rank(ranking_request())).rankings) == 2
    assert service._pending == {}
    service_messages = [record.getMessage() for record in caplog.records if record.name.endswith("ranking.service")]
    messages = [message for message in service_messages if message.startswith("support_program_ranking ")]
    selection_messages = [message for message in service_messages if message.startswith("support_program_ranking_selection ")]
    assert selection_messages == [
        "support_program_ranking_selection candidate_count=2 eligible_count=2 selected_count=2 "
        "excluded_low_relevance=0 excluded_target=0 excluded_region=0 "
        "selected_target_unknown=2 selected_region_unknown=2"
    ]
    assert {re.search(r"cache_state=(\w+)", message)[1] for message in messages} == {"miss", "shared", "hit"}
    assert all(re.fullmatch(
        r"support_program_ranking cache_state=(hit|miss|shared) elapsed_ms=\d+\.\d candidate_count=2",
        message,
    ) for message in messages)
    assert "서울" not in caplog.text
    assert next(iter(service._cache)) not in caplog.text


@pytest.mark.anyio
@pytest.mark.parametrize("cancelled_index", [0, 1])
async def test_cancelling_one_waiter_keeps_the_shared_agent_running(cancelled_index):
    started, release, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
    agent = successful_agent()

    async def blocked_result(request):
        started.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        return valid_output(request)

    agent.rank.side_effect = blocked_result
    service = SupportProgramRankingService(agent)
    waiters = [asyncio.create_task(service.rank(ranking_request()))]
    await started.wait()
    waiters.append(asyncio.create_task(service.rank(ranking_request())))
    await asyncio.sleep(0)
    waiters[cancelled_index].cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiters[cancelled_index]
    assert not cancelled.is_set()
    assert next(iter(service._pending.values())).waiters == 1
    release.set()
    assert len((await waiters[1 - cancelled_index]).rankings) == 2
    assert service._pending == {}
    assert len((await service.rank(ranking_request())).rankings) == 2
    assert agent.rank.await_count == 1


@pytest.mark.anyio
@pytest.mark.parametrize("waiter_count", [1, 2])
async def test_cancelling_all_waiters_cancels_agent_cleans_pending_and_allows_retry(waiter_count):
    started, release, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
    agent = successful_agent()

    async def blocked_result(request):
        started.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        return valid_output(request)

    agent.rank.side_effect = blocked_result
    service = SupportProgramRankingService(agent)
    waiters = [asyncio.create_task(service.rank(ranking_request())) for _ in range(waiter_count)]
    await started.wait()
    pending_task = next(iter(service._pending.values())).task
    for waiter in waiters:
        waiter.cancel()
    results = await asyncio.gather(*waiters, return_exceptions=True)
    assert all(isinstance(result, asyncio.CancelledError) for result in results)
    assert cancelled.is_set()
    assert pending_task.cancelled()
    assert service._cache == service._pending == {}
    release.set()
    assert len((await service.rank(ranking_request())).rankings) == 2
    assert agent.rank.await_count == 2


@pytest.mark.anyio
async def test_shared_failure_reaches_all_waiters_and_next_request_retries():
    started, release = asyncio.Event(), asyncio.Event()
    agent = successful_agent()
    error = AgentExecutionError("upstream failed")

    async def blocked_failure(_request):
        started.set()
        await release.wait()
        raise error

    agent.rank.side_effect = blocked_failure
    service = SupportProgramRankingService(agent)
    first = asyncio.create_task(service.rank(ranking_request()))
    await started.wait()
    second = asyncio.create_task(service.rank(ranking_request()))
    await asyncio.sleep(0)
    release.set()
    results = await asyncio.gather(first, second, return_exceptions=True)
    assert results[0] is results[1] is error
    assert service._cache == service._pending == {}
    agent.rank.side_effect = valid_output
    assert len((await service.rank(ranking_request())).rankings) == 2
    assert agent.rank.await_count == 2


@pytest.mark.anyio
async def test_mutating_nested_input_while_waiting_cannot_change_snapshot_or_cache_identity():
    started, release = asyncio.Event(), asyncio.Event()
    agent = successful_agent()

    async def blocked_result(request):
        started.set()
        await release.wait()
        assert request.candidates[0].id == "BIZINFO:program-1"
        assert request.candidates[0].categories == ["사업화", "금융"]
        return valid_output(request)

    agent.rank.side_effect = blocked_result
    service = SupportProgramRankingService(agent)
    request = ranking_request()
    pending = asyncio.create_task(service.rank(request))
    await started.wait()
    request.candidates[0].categories.append("호출자가 뒤늦게 추가한 분류")
    request.candidates.reverse()
    release.set()
    response = await pending
    assert [item.program_id for item in response.rankings] == ["BIZINFO:program-1", "BIZINFO:program-2"]
    assert await service.rank(ranking_request()) == response
    assert agent.rank.await_count == 1
