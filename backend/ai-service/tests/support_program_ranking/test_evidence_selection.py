import json
from unittest.mock import Mock

import pytest
from tests.langchain_stub import ResponsesChatStub, response_message

from app.support_program_ranking.agent import SupportProgramRecommendationAgent, build_evidence_options
from app.support_program_ranking.errors import AgentExecutionError, AgentFailureCode
from app.support_program_ranking.models import (
    SCORING_VERSION,
    SupportProgramCandidate,
    SupportProgramRankingOutput,
    SupportProgramRankingRequest,
)
from app.support_program_ranking.service import SupportProgramRankingService


def candidate(index=1, **changes):
    return SupportProgramCandidate.model_validate({
        "id": f"BIZINFO:selection:{index}",
        "title": f"{index}번 기업 지원",
        "organization": "지원 기관",
        "summary": f"{index}번 공고 요약: 서울 소재 기업의 사업화를 지원합니다.",
        "categories": ["사업화"],
        "regions": ["서울"],
        "targetDescription": f"{index}번 공고 대상: 서울 소재 중소기업",
        "applicationPeriod": "상시 접수",
        "status": "OPEN",
        **changes,
    })


def request_for(candidates):
    return SupportProgramRankingRequest(
        originalQuery="서울 소재 기업 사업화 지원",
        scoringVersion=SCORING_VERSION,
        resultLimit=5,
        candidates=candidates,
    )


def assessment(*, target="MATCH", region="MATCH", target_evidence=None, region_evidence=None,
               semantic=40):
    return {
        "semanticRelevance": semantic,
        "targetAssessment": {
            "eligibility": target,
            "evidence": ([0] if target != "UNKNOWN" else []) if target_evidence is None else target_evidence,
            "explanation": "공식 본문의 기업 요건을 확인했습니다.",
        },
        "regionAssessment": {
            "eligibility": region,
            "evidence": ([1] if region != "UNKNOWN" else []) if region_evidence is None else region_evidence,
            "explanation": "공식 본문의 지역 요건을 확인했습니다.",
        },
        "supportTypeFit": 10,
        "recommendationReasons": ["기업의 사업화 지원을 확인했습니다."],
    }


def agent_with_outputs(*outputs):
    # Scripted responses exercise the real LangChain request and schema, not model semantic quality.
    model = ResponsesChatStub([
        [response_message(json.dumps(output, ensure_ascii=False))]
        for output in outputs
    ])
    return SupportProgramRecommendationAgent(
        model=model.model, model_timeout_seconds=3, run_timeout_seconds=4,
    ), model


@pytest.mark.anyio
async def test_candidate_local_indexes_restore_each_field_without_changing_input_or_explanation():
    values = [
        candidate(summary="  첫  요약 e\u0301\u00a0기업 😀  ", targetDescription="첫 공고의 대상 기업"),
        candidate(2, id="KSTARTUP:selection:1", summary="둘째 공고의 다른 요약", targetDescription="둘째 대상 기업"),
    ]
    assessments = {value.id: assessment() for value in values}
    explanation = "  원문 e\u0301\u00a0요건 😀 확인  "
    assessments[values[0].id]["targetAssessment"]["explanation"] = explanation
    agent, model = agent_with_outputs({"rankings": assessments})
    request = request_for(values)
    original_request = request.model_dump(mode="json", by_alias=True)

    result = await agent.rank(request)

    assert isinstance(result, SupportProgramRankingOutput)
    assert [ranking.program_id for ranking in result.rankings] == [value.id for value in values]
    for ranking, value in zip(result.rankings, values, strict=True):
        assert [item.model_dump() for item in ranking.target_assessment.evidence] == [
            {"field": "SUMMARY", "quote": value.summary},
        ]
        assert [item.model_dump() for item in ranking.region_assessment.evidence] == [
            {"field": "TARGET_DESCRIPTION", "quote": value.target_description},
        ]
    assert result.rankings[0].target_assessment.explanation == explanation
    sent = json.loads(model.first_call.input[0]["content"])
    for actual, expected in zip(sent["candidates"], original_request["candidates"], strict=True):
        assert actual["evidenceOptions"] == [
            {"index": 0, "field": "SUMMARY", "quote": expected["summary"]},
            {"index": 1, "field": "TARGET_DESCRIPTION", "quote": expected["targetDescription"]},
        ]
        assert {key: value for key, value in actual.items() if key != "evidenceOptions"} == expected
    assert request.model_dump(mode="json", by_alias=True) == original_request
    assert len(model.calls) == 1
    model.assert_complete()


@pytest.mark.anyio
async def test_kstartup_target_exclusions_and_metadata_reach_langchain_and_restore_own_evidence():
    target = (
        "신청 대상: 창업 3년 이내 기업 및 예비창업자\n"
        "제외 대상: 금융기관 채무불이행 중인 기업은 신청할 수 없습니다.\n"
        "업력: 예비창업자, 3년 미만\n대상: 일반인, 대학생\n연령: 만 39세 이하"
    )
    values = [
        candidate(id="BIZINFO:174321"),
        candidate(2, id="KSTARTUP:174321", summary="AI 창업기업의 시제품 제작 비용을 지원합니다.",
                  targetDescription=target, regions=["전국"]),
    ]
    options = build_evidence_options(values[1])
    exclusion_index = next(index for index, option in enumerate(options)
                           if option.field == "TARGET_DESCRIPTION" and "제외 대상:" in option.quote)
    agent, model = agent_with_outputs({"rankings": {
        values[0].id: assessment(),
        values[1].id: assessment(target="UNKNOWN", region="UNKNOWN", target_evidence=[exclusion_index]),
    }})

    result = await SupportProgramRankingService(agent).rank(request_for(values))

    assert [ranking.program_id for ranking in result.rankings] == [value.id for value in values]
    assert result.rankings[1].target_eligibility.value == "UNKNOWN"
    assert result.rankings[1].target_evidence[0].quote == options[exclusion_index].quote
    assert result.rankings[1].target_evidence[0].field == "TARGET_DESCRIPTION"
    sent = json.loads(model.first_call.input[0]["content"])["candidates"]
    assert sent[1]["id"] == "KSTARTUP:174321"
    assert sent[1]["targetDescription"] == target
    assert sent[1]["regions"] == ["전국"]
    assert sent[1]["evidenceOptions"][exclusion_index]["quote"] == options[exclusion_index].quote
    assert len(model.calls) == 1
    model.assert_complete()


@pytest.mark.anyio
async def test_reusing_agent_does_not_reuse_previous_candidates_options_or_index_bounds():
    previous = [candidate(), candidate(2)]
    current = candidate(2, summary="이번 요청의 첫 요약\x00이번 요청의 둘째 요약",
                        targetDescription="이번 요청의 새 대상")
    agent, model = agent_with_outputs(
        {"rankings": {value.id: assessment() for value in previous}},
        {"rankings": {current.id: assessment(target_evidence=[2], region_evidence=[1])}},
    )

    first = await agent.rank(request_for(previous))
    second = await agent.rank(request_for([current]))

    assert first.rankings[1].target_assessment.evidence[0].quote == previous[1].summary
    assert [ranking.program_id for ranking in second.rankings] == [current.id]
    assert second.rankings[0].target_assessment.evidence[0].model_dump() == {
        "field": "TARGET_DESCRIPTION", "quote": current.target_description,
    }
    assert second.rankings[0].region_assessment.evidence[0].model_dump() == {
        "field": "SUMMARY", "quote": "이번 요청의 둘째 요약",
    }
    first_sent, second_sent = [json.loads(call.input[0]["content"]) for call in model.calls]
    assert len(first_sent["candidates"]) == 2
    assert [value["id"] for value in second_sent["candidates"]] == [current.id]
    assert second_sent["candidates"][0]["summary"] == current.summary
    assert second_sent["candidates"][0]["evidenceOptions"] == [
        {"index": 0, "field": "SUMMARY", "quote": "이번 요청의 첫 요약"},
        {"index": 1, "field": "SUMMARY", "quote": "이번 요청의 둘째 요약"},
        {"index": 2, "field": "TARGET_DESCRIPTION", "quote": current.target_description},
    ]
    assert len(model.calls) == 2
    model.assert_complete()


@pytest.mark.anyio
@pytest.mark.parametrize("selection", [
    pytest.param(-1, id="negative"),
    pytest.param(2, id="equal-to-option-count"),
    pytest.param(True, id="boolean"),
    pytest.param(0.0, id="float"),
    pytest.param("0", id="string"),
    pytest.param({"field": "SUMMARY", "quote": "1번 공고 요약: 서울 소재 기업의 사업화를 지원합니다."},
                 id="copied-own-quote-object"),
    pytest.param({"field": "SUMMARY", "quote": "다른 후보만의 요약"}, id="copied-other-candidate-quote"),
    pytest.param(None, id="null"),
])
async def test_langchain_rejects_out_of_range_or_non_strict_integer_evidence(selection):
    values = [candidate(), candidate(2, summary="다른 후보만의 요약")]
    output = {"rankings": {
        values[0].id: assessment(target_evidence=[selection]),
        values[1].id: assessment(),
    }}
    agent, model = agent_with_outputs(output)

    with pytest.raises(AgentExecutionError):
        await agent.rank(request_for(values))

    assert len(model.calls) == 1
    model.assert_complete()


@pytest.mark.anyio
@pytest.mark.parametrize("eligibility,evidence", [
    ("MATCH", []), ("INCOMPATIBLE", []), ("MATCH", [0, 0]), ("INCOMPATIBLE", [0, 0]),
])
async def test_known_eligibility_rejects_empty_or_duplicate_two_item_selections(eligibility, evidence):
    value = candidate()
    agent, model = agent_with_outputs({"rankings": {
        value.id: assessment(region=eligibility, region_evidence=evidence),
    }})

    with pytest.raises(AgentExecutionError):
        await agent.rank(request_for([value]))

    assert len(model.calls) == 1
    model.assert_complete()


@pytest.mark.anyio
@pytest.mark.parametrize("evidence", [[], [1]])
async def test_unknown_allows_no_evidence_or_one_valid_selection(evidence):
    value = candidate()
    agent, model = agent_with_outputs({"rankings": {
        value.id: assessment(target="UNKNOWN", target_evidence=evidence),
    }})

    output = await agent.rank(request_for([value]))

    target = output.rankings[0].target_assessment
    assert target.eligibility.value == "UNKNOWN"
    assert [item.model_dump() for item in target.evidence] == (
        [{"field": "TARGET_DESCRIPTION", "quote": value.target_description}] if evidence else []
    )
    model.assert_complete()


@pytest.mark.anyio
async def test_candidate_without_any_control_free_option_allows_unknown_and_empty_evidence_only():
    value = candidate(summary="\x00", targetDescription="\u200d")
    agent, model = agent_with_outputs({"rankings": {
        value.id: assessment(target="UNKNOWN", region="UNKNOWN"),
    }})

    output = await agent.rank(request_for([value]))

    ranking = output.rankings[0]
    assert ranking.target_assessment.eligibility.value == ranking.region_assessment.eligibility.value == "UNKNOWN"
    assert ranking.target_assessment.evidence == ranking.region_assessment.evidence == []
    sent = json.loads(model.first_call.input[0]["content"])["candidates"][0]
    assert sent["summary"] == value.summary
    assert sent["targetDescription"] == value.target_description
    assert sent["evidenceOptions"] == []
    model.assert_complete()


@pytest.mark.anyio
@pytest.mark.parametrize("eligibility,evidence", [
    ("MATCH", []), ("INCOMPATIBLE", []), ("UNKNOWN", [0]),
])
async def test_candidate_without_options_rejects_known_eligibility_or_any_index(eligibility, evidence):
    value = candidate(summary="\x00", targetDescription="\u200d")
    agent, model = agent_with_outputs({"rankings": {
        value.id: assessment(target=eligibility, target_evidence=evidence, region="UNKNOWN"),
    }})

    with pytest.raises(AgentExecutionError):
        await agent.rank(request_for([value]))

    model.assert_complete()


@pytest.mark.anyio
@pytest.mark.parametrize("source_code", ["BIZINFO", "KSTARTUP"])
async def test_restored_exact_quote_does_not_bypass_truncated_source_service_validation(source_code):
    value = candidate(id=f"{source_code}:174321", sourceTextTruncated=True)
    output = {"rankings": {value.id: assessment()}}
    agent, model = agent_with_outputs(output, output)
    request = request_for([value])

    restored = await agent.rank(request)
    assert restored.rankings[0].target_assessment.evidence[0].quote == value.summary
    with pytest.raises(AgentExecutionError) as captured:
        await SupportProgramRankingService(agent).rank(request)

    assert captured.value.reason_code is AgentFailureCode.TRUNCATED_SOURCE_KNOWN_ELIGIBILITY
    assert len(model.calls) == 2
    model.assert_complete()


@pytest.mark.anyio
@pytest.mark.parametrize("excluded_reason", ["low-score", "incompatible"])
async def test_invalid_selection_in_twentieth_excluded_candidate_fails_the_entire_service_request(excluded_reason):
    values = [candidate(index) for index in range(1, 21)]
    assessments = {value.id: assessment() for value in values}
    assessments[values[-1].id] = assessment(
        semantic=0 if excluded_reason == "low-score" else 40,
        target="INCOMPATIBLE" if excluded_reason == "incompatible" else "MATCH",
        target_evidence=[2],
    )
    agent, model = agent_with_outputs({"rankings": assessments})

    with pytest.raises(AgentExecutionError):
        await SupportProgramRankingService(agent).rank(request_for(values))

    assert len(model.calls) == 1
    assert len(json.loads(model.first_call.input[0]["content"])["candidates"]) == 20
    model.assert_complete()


@pytest.mark.anyio
async def test_runtime_guard_rejects_out_of_range_evidence_after_nested_schema_validation_is_bypassed(monkeypatch):
    value = candidate()
    valid = {"rankings": {value.id: assessment()}}
    agent, model = agent_with_outputs(valid)

    def return_corrupted_output(message, output_type):
        output = output_type.model_validate(valid)
        selected = getattr(output.rankings, value.id)
        corrupted_target = selected.target_assessment.model_copy(update={"evidence": [2]})
        corrupted_selection = selected.model_copy(update={"target_assessment": corrupted_target})
        corrupted_rankings = output.rankings.model_copy(update={value.id: corrupted_selection})
        return output.model_copy(update={"rankings": corrupted_rankings})

    run = Mock(side_effect=return_corrupted_output)
    monkeypatch.setattr("app.support_program_ranking.agent.validate_support_program_output", run)

    with pytest.raises(AgentExecutionError) as captured:
        await agent.rank(request_for([value]))

    assert captured.value.reason_code is AgentFailureCode.INVALID_EVIDENCE_SELECTION
    run.assert_called_once()
    assert len(model.calls) == 1


@pytest.mark.anyio
async def test_selecting_valid_evidence_does_not_relax_explanation_control_character_validation():
    value = candidate()
    selection = assessment()
    selection["targetAssessment"]["explanation"] = "확인된 요건\x00추가 설명"
    agent, model = agent_with_outputs({"rankings": {value.id: selection}})

    with pytest.raises(AgentExecutionError):
        await agent.rank(request_for([value]))

    assert len(model.calls) == 1
    model.assert_complete()
