"""실제 Langfuse에 합성 도우미 실행을 저장하고 단계 연결·미확정 사용량을 확인한다."""

import json
from collections import Counter
from uuid import uuid4

from app.assistant_agent.errors import AssistantAgentTimeoutError
from app.assistant_agent.models import SCHEMA_VERSION, AssistantAgentRequest
from tests.assistant_agent.fakes import HANG
from tests.assistant_agent.test_graph import Harness
from tests.assistant_agent.test_saved_programs import Harness as SavedHarness
from tests.assistant_agent.test_saved_programs import documents, finding, reduce_output


def request_data():
    return {
        "schemaVersion": SCHEMA_VERSION,
        "message": "관심 공고 원문을 비교해 줘 PRIVATE-ASSISTANT-SMOKE",
        "history": [],
        "session": {"authenticated": True, "hasCompany": True},
        "context": {"route": "/app/chat", "programSelected": False},
        "principal": {"accountId": 7, "toolToken": "private-assistant-token", "hasCompany": True},
        "helpEntries": [
            {
                "id": "search-help",
                "title": "검색 도움말",
                "question": "검색은 어떻게 하나요?",
                "summary": "검색창에서 검색합니다.",
                "body": [],
                "limitation": None,
                "audience": "public",
                "status": "available",
                "action": {"label": "검색", "to": "/app/chat"},
            }
        ],
    }


async def assistant_trace_examples(tracing):
    records = []
    for scenario in ("saved", "map-failure", "timeout"):
        payload = request_data()
        if scenario == "timeout":
            classification = {
                "intent": "PARTNER_MATCH",
                "answer": None,
                "citations": [],
                "clarificationQuestion": None,
                "searchQuery": None,
                "accountTopic": None,
            }
            harness = Harness(tracing=tracing, classify=[classification], agent=[HANG], timeout=0.5)
        else:
            payload.update(savedProgramDocuments=documents(), resumeIntent="SAVED_PROGRAMS_QUESTION")
            harness = SavedHarness(
                tracing=tracing,
                agent=[reduce_output()],
                classify=[
                    RuntimeError("PRIVATE-ASSISTANT-SMOKE") if scenario == "map-failure" else finding("YES"),
                    finding("NO"),
                ],
            )
        trace_id = uuid4().hex
        try:
            await harness.service.answer(AssistantAgentRequest.model_validate(payload), trace_id=trace_id)
            assert scenario != "timeout"
        except AssistantAgentTimeoutError:
            assert scenario == "timeout"
        finally:
            await harness.client.aclose()
        harness.assert_complete()
        records.append(
            {
                "trace_id": trace_id,
                "assistant_scenario": scenario,
                "observation_count": 3 if scenario == "timeout" else 10,
            }
        )
    return records


def verify_assistant_observations(observations, record):
    scenario = record["assistant_scenario"]
    by_id = {item["id"]: item for item in observations}
    assert len(by_id) == len(observations) == record["observation_count"]
    (root,) = [item for item in observations if item["name"] == "assistant.agent"]
    # SDK는 명시적인 trace ID에 non-recording 부모를 붙일 수 있다. 업무 루트만
    # 외부 부모를 허용하고 모든 실제 노드는 이 요청 안의 부모와 연결돼야 한다.
    assert root.get("parentObservationId") not in by_id
    assert all(item.get("parentObservationId") in by_id for item in observations if item is not root)
    edges = [
        (item["name"], None if item is root else by_id[item["parentObservationId"]]["name"]) for item in observations
    ]
    expected = [("assistant.agent", None)]
    if scenario == "timeout":
        expected += [("assistant.classify", "assistant.agent"), ("assistant.plan", "assistant.agent")]
    else:
        expected += [("assistant." + name, "assistant.agent") for name in ("resume", "saved_programs", "finalize")]
        expected += [
            ("assistant.saved." + name, "assistant.saved_programs") for name in ("retrieve", "map", "reduce", "verify")
        ]
        expected += [("assistant.saved.judge", "assistant.saved.map")] * 2
    assert Counter(edges) == Counter(expected)
    metadata = root["metadata"]
    assert metadata["outcome"] == ("timeout" if scenario == "timeout" else "completed")
    assert metadata["model_calls"] == (2 if scenario == "timeout" else 3)
    assert metadata["usage_unknown_calls"] == (0 if scenario == "saved" else 1)
    assert metadata["usage_complete"] is (scenario == "saved")
    assert metadata["usage_observed_input_tokens"] == {"saved": 600, "map-failure": 400, "timeout": 200}[scenario]
    if scenario != "saved":
        assert metadata.get("usage_input_tokens") is None
    if scenario == "saved":
        assert all(item["level"] != "ERROR" for item in observations)
    elif scenario == "map-failure":
        (mapping,) = [item for item in observations if item["name"] == "assistant.saved.map"]
        assert mapping["level"] == "WARNING" and mapping["metadata"]["map_failures"] == 1
        assert any(item["level"] == "ERROR" for item in observations if item["name"] == "assistant.saved.judge")
    else:
        assert root["level"] == "ERROR"
    text = json.dumps(observations, ensure_ascii=False)
    for private in ("PRIVATE-ASSISTANT-SMOKE", "private-assistant-token", "서울 AI 실증 지원사업", "BIZINFO:PBLN_"):
        assert private not in text
    for item in observations:
        assert item.get("input") in (None, "", "null") and item.get("output") in (None, "", "null")
