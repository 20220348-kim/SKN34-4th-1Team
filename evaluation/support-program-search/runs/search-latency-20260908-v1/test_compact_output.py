import json

import pytest
from agents.testing import ScriptedModel, assistant_message

# Rejected production experiment, retained only for offline reproducibility.
import importlib.util
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "backend/ai-service"))
_spec = importlib.util.spec_from_file_location(
    "app.support_program_ranking._compact_output_test", Path(__file__).with_name("compact_agent.py"))
_experiment = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _experiment
_spec.loader.exec_module(_experiment)
SupportProgramRecommendationAgent = _experiment.SupportProgramRecommendationAgent
from app.support_program_ranking.errors import AgentExecutionError
from app.support_program_ranking.models import SCORING_VERSION, SupportProgramRankingRequest


def request_for(count=2):
    return SupportProgramRankingRequest.model_validate({
        "originalQuery": "서울 사업화 지원", "scoringVersion": SCORING_VERSION, "resultLimit": min(5, count),
        "candidates": [{
            "id": f"{('BIZINFO', 'KSTARTUP')[i % 2]}:공고/{i}:같은-원본", "title": "사업화 지원",
            "organization": "지원 기관", "summary": "서울 소재 기업 사업화 지원",
            "targetDescription": "서울 소재 중소기업", "categories": [], "regions": ["서울"],
            "applicationPeriod": "상시", "status": "OPEN",
        } for i in range(count)],
    })


def assessment():
    return {"s": 35, "f": 8, "t": {"v": "MATCH", "e": [1], "x": "기업 요건 e\u0301 😀 확인"},
            "r": {"v": "UNKNOWN", "e": [0], "x": "서울 소재 여부 확인"}, "why": ["사업화 지원"]}


def make_agent(output):
    model = ScriptedModel([[assistant_message(json.dumps(output, ensure_ascii=False))]])
    return SupportProgramRecommendationAgent(model=model, model_timeout_seconds=3, run_timeout_seconds=4,
                                             reasoning_effort="low", compact_output=True), model


@pytest.mark.anyio
@pytest.mark.parametrize("count", [1, 2, 20])
async def test_compact_preserves_all_candidates_original_fields_and_source_evidence(count):
    request = request_for(count)
    before = request.model_dump(mode="json", by_alias=True)
    agent, model = make_agent({"rankings": {f"p{i}": assessment() for i in range(count)}})
    result = await agent.rank(request)
    assert [x.program_id for x in result.rankings] == [x.id for x in request.candidates]
    for row, candidate in zip(result.rankings, request.candidates, strict=True):
        assert row.semantic_relevance == 35 and row.support_type_fit == 8
        assert row.target_assessment.explanation == "기업 요건 e\u0301 😀 확인"
        assert row.target_assessment.evidence[0].quote == candidate.target_description
        assert row.region_assessment.evidence[0].quote == candidate.summary
        assert row.region_assessment.eligibility.value == "UNKNOWN"
        assert row.recommendation_reasons == ["사업화 지원"]
    sent = json.loads(model.first_call.input[0]["content"])
    for i, (actual, original) in enumerate(zip(sent["candidates"], before["candidates"], strict=True)):
        assert actual["id"] == f"p{i}"
        assert {k: v for k, v in actual.items() if k not in {"id", "evidenceOptions"}} == {
            k: v for k, v in original.items() if k != "id"}
    assert request.model_dump(mode="json", by_alias=True) == before
    assert len(model.calls) == 1
    model.assert_complete()


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["missing", "extra", "foreign", "bad-index", "missing-evidence", "bad-score"])
async def test_compact_rejects_invalid_identity_score_and_evidence(kind):
    value = {"p0": assessment(), "p1": assessment()}
    if kind == "missing":
        del value["p1"]
    elif kind == "extra":
        value["p2"] = assessment()
    elif kind == "foreign":
        value["BIZINFO:unknown"] = value.pop("p0")
    elif kind == "bad-index":
        value["p0"]["t"]["e"] = [2]
    elif kind == "missing-evidence":
        value["p0"]["t"]["e"] = []
    else:
        value["p0"]["s"] = 41
    agent, _ = make_agent({"rankings": value})
    with pytest.raises(AgentExecutionError):
        await agent.rank(request_for())
