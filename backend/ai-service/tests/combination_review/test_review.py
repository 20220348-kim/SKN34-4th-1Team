import asyncio
from copy import deepcopy
import json
import os
from pathlib import Path
import random
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import httpx2
from fastapi.testclient import TestClient
from langchain_openai import ChatOpenAI
from langsmith import get_tracing_context
from pydantic import ValidationError

from app.combination_review.agent import CombinationReviewAgent
from app.combination_review.models import AnalyzeRequest, AnalysisSelection, build_citation_options, validate_selection
from app.combination_review.prompt import PROMPT_VERSION
from app.combination_review.service import CombinationReviewError, CombinationReviewService
from app.config import Settings
from app.main import create_app

FIXTURES = (Path(os.environ["GOVBIZ_TEST_CONTRACT_DIR"]) if "GOVBIZ_TEST_CONTRACT_DIR" in os.environ
            else Path(__file__).resolve().parents[4] / "backend/core-service/src/test/resources/combinationreview")


def request_data():
    return json.loads((FIXTURES / "contract-request.json").read_text(encoding="utf-8"))


def response_data():
    data = json.loads((FIXTURES / "contract-response.json").read_text(encoding="utf-8"))
    data["promptVersion"] = PROMPT_VERSION
    return data


def selection_data():
    request = AnalyzeRequest.model_validate(request_data())
    options = build_citation_options(request)
    data = response_data()
    for name in ["contractVersion", "model", "promptVersion"]:
        data.pop(name)
    for pair in data["pairs"]:
        for stage in pair["stages"]:
            for citation in stage["citations"]:
                evidence_index = int(citation.pop("evidenceId")[1:])
                quote = citation.pop("quote")
                citation["citationOptionIndex"] = next(
                    index for index, option in enumerate(options)
                    if option.evidenceIndex == evidence_index and quote in option.quote
                )
    return data


def make_service(data=None, *, status="completed", content=None, http_status=200, delay=0, run_timeout=3,
                 transport_timeout=False):
    calls = []

    async def handle(request):
        assert get_tracing_context()["enabled"] is False
        calls.append(request)
        if transport_timeout:
            raise httpx2.ReadTimeout("private timeout detail", request=request)
        if delay:
            await asyncio.sleep(delay)
        if http_status != 200:
            return httpx2.Response(http_status, json={"error": {"message": "private upstream detail"}})
        body = {
            "id": "resp_test", "object": "response", "created_at": 0, "model": "test-model",
            "status": status, "error": None,
            "incomplete_details": {"reason": "max_output_tokens"} if status == "incomplete" else None,
            "output": [{"id": "msg_test", "type": "message", "role": "assistant", "status": "completed",
                        "content": content if content is not None else [{
                            "type": "output_text", "text": json.dumps(data if data is not None else selection_data(), ensure_ascii=False),
                            "annotations": [],
                        }]}],
        }
        return httpx2.Response(200, json=body)

    model = ChatOpenAI(
        model="test-model", api_key="test-key", base_url="https://openai.test/v1/",
        use_responses_api=True, store=False, reasoning={"effort": "none"},
        max_tokens=6000, timeout=2, max_retries=0,
        http_async_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handle)),
    )
    agent = CombinationReviewAgent(model=model, run_timeout_seconds=run_timeout)
    return CombinationReviewService(agent, "test-model"), calls


def test_citation_markers_the_model_writes_into_sentences_are_removed_from_user_visible_text():
    marker = chr(0xE200) + "cite" + chr(0xE202) + "citationOptionIndex=1" + chr(0xE201)
    data = selection_data()
    data["summary"] = f"사업 1과 사업 2의 중복 여부를 확인했습니다. {marker} {marker}"
    stage = data["pairs"][0]["stages"][0]
    stage["explanation"] = f"사업 1은 동일 과제 중복 지원을 제한합니다. {marker}"
    stage["questions"] = [f"같은 비용인가요? {marker}"] + stage["questions"][1:]
    service, _calls = make_service(data)

    result = asyncio.run(service.analyze(AnalyzeRequest.model_validate(request_data())))

    assert result["summary"] == "사업 1과 사업 2의 중복 여부를 확인했습니다."
    first = result["pairs"][0]["stages"][0]
    assert first["explanation"] == "사업 1은 동일 과제 중복 지원을 제한합니다."
    assert first["questions"][0] == "같은 비용인가요?"
    assert "citationOptionIndex" not in json.dumps(result, ensure_ascii=False)


def test_langchain_responses_returns_the_same_contract_consumed_by_core():
    service, calls = make_service()
    result = asyncio.run(service.analyze(AnalyzeRequest.model_validate(request_data())))
    assert result == response_data()
    assert result["promptVersion"] == PROMPT_VERSION
    assert len(calls) == 1
    assert calls[0].url.path == "/v1/responses"
    assert calls[0].extensions["timeout"]["read"] == 2
    body = json.loads(calls[0].content)
    assert body["store"] is False and body["max_output_tokens"] == 6000
    assert body["reasoning"] == {"effort": "none"}
    assert not body.get("tools")
    assert body["text"]["format"]["strict"] is True
    schema = body["text"]["format"]["schema"]
    assert '"oneOf"' not in json.dumps(schema)
    assert '"discriminator"' not in json.dumps(schema)
    assert '"anyOf"' in json.dumps(schema)
    user = next(message for message in body["input"] if message["role"] == "user")
    payload = json.loads(user["content"])
    assert "evidence" not in payload
    expected = build_citation_options(AnalyzeRequest.model_validate(request_data()))
    assert [option["quote"] for option in payload["citationOptions"]] == [option.quote for option in expected]
    assert service.agent._run_timeout_seconds == 3


@pytest.mark.parametrize("kwargs", [
    {"status": "incomplete"},
    {"content": [{"type": "refusal", "refusal": "private refusal"}]},
    {"content": [{"type": "output_text", "text": "not JSON", "annotations": []}]},
    {"data": {"summary": "missing required fields"}},
    {"http_status": 429},
    {"http_status": 500},
])
def test_langchain_errors_fail_without_retry_or_normal_answer(kwargs):
    service, calls = make_service(**kwargs)
    with pytest.raises(CombinationReviewError, match="COMBINATION_REVIEW_FAILED"):
        asyncio.run(service.analyze(AnalyzeRequest.model_validate(request_data())))
    assert len(calls) == 1


def test_langchain_total_timeout_cancels_the_call_without_retry():
    service, calls = make_service(delay=1, run_timeout=0.05)
    with pytest.raises(CombinationReviewError, match="COMBINATION_REVIEW_TIMEOUT"):
        asyncio.run(service.analyze(AnalyzeRequest.model_validate(request_data())))
    assert len(calls) == 1


def test_langchain_model_timeout_is_distinguished_without_retry():
    service, calls = make_service(transport_timeout=True)
    with pytest.raises(CombinationReviewError, match="COMBINATION_REVIEW_TIMEOUT"):
        asyncio.run(service.analyze(AnalyzeRequest.model_validate(request_data())))
    assert len(calls) == 1


def test_bootstrap_preserves_the_dedicated_model_timeout_and_shared_client(monkeypatch):
    import app.bootstrap as bootstrap

    models = []
    def capture_model(**kwargs):
        model = ChatOpenAI(**kwargs)
        models.append(model)
        return model

    monkeypatch.setattr(bootstrap, "ChatOpenAI", capture_model)
    container = bootstrap.build_application_container(Settings(
        openai_api_key="test-key", openai_model="test-model",
        llm_model_timeout_seconds=2, llm_run_timeout_seconds=3,
        llm_combination_review_model_timeout_seconds=6, llm_combination_review_run_timeout_seconds=7,
    ))
    try:
        model = next(model for model in models if model.max_tokens == 6000)
        assert model.model_name == "test-model"
        assert model.use_responses_api is True and model.store is False
        assert model.reasoning == {"effort": "none"} and model.max_retries == 0
        assert model.request_timeout == 6
        assert model.root_async_client.timeout == 6
        assert model.root_async_client.max_retries == 0
        assert model.root_async_client._client is container.openai_client._client
        assert container.openai_client.timeout == 2
        assert container.combination_review_service.agent._run_timeout_seconds == 7
    finally:
        asyncio.run(container.close())


@pytest.mark.parametrize("change", [
    lambda d: d["programs"].append(deepcopy(d["programs"][0])),
    lambda d: d["evidence"][0].update(programIndex=2),
    lambda d: d["evidence"][0].update(programIndex="0"),
    lambda d: d["evidence"][1].update(id="E0"),
    lambda d: d["evidence"].pop(),
    lambda d: d["programs"][0]["participation"].update(selected=None),
    lambda d: d["programs"][0]["participation"].update(selected="MAYBE"),
    lambda d: d.update(evidence=[]),
    lambda d: d.update(contractVersion="unknown"),
])
def test_invalid_inputs_are_rejected_before_agent(change):
    data = request_data()
    change(data)
    with pytest.raises(ValidationError):
        AnalyzeRequest.model_validate(data)


@pytest.mark.parametrize("change", [
    lambda d: d["pairs"][0]["stages"][0].update(citations=[]),
    lambda d: d["pairs"][0]["stages"][0].update(requiresInstitutionConfirmation=True),
    lambda d: d["pairs"][0]["stages"][0].update(judgment="NEEDS_FACTS", questions=[]),
    lambda d: d["pairs"][0]["stages"].pop(),
    lambda d: d["pairs"].append(deepcopy(d["pairs"][0])),
    lambda d: d["pairs"][0].update(secondProgramIndex=2),
])
def test_invalid_outputs_fail_the_structured_contract(change):
    data = selection_data()
    change(data)
    with pytest.raises(ValidationError):
        AnalysisSelection.model_validate(data)


@pytest.mark.parametrize("change", [
    lambda d: d["pairs"][0]["stages"][0].update(stage="FUNDING"),
    lambda d: d["pairs"][0]["stages"][0]["citations"][0].update(citationOptionIndex=500),
])
def test_invalid_pair_or_citation_is_technical_failure_without_fallback(change):
    data = selection_data()
    change(data)
    agent = SimpleNamespace(analyze=AsyncMock(return_value=AnalysisSelection.model_validate(data)))
    service = CombinationReviewService(agent, "test-model")
    with pytest.raises(CombinationReviewError, match="COMBINATION_REVIEW_FAILED"):
        asyncio.run(service.analyze(AnalyzeRequest.model_validate(request_data())))
    assert agent.analyze.call_count == 1


def test_returns_the_prebuilt_exact_source_quote_selected_by_the_model():
    request = request_data()
    request["evidence"][0]["text"] = "3개\u3000유형에  중복\n신청은 가능하나 1개 유형만 수행 가능합니다."
    data = selection_data()
    for stage in data["pairs"][0]["stages"]:
        for citation in stage["citations"]:
            citation["citationOptionIndex"] = 0
    agent = SimpleNamespace(analyze=AsyncMock(return_value=AnalysisSelection.model_validate(data)))

    result = asyncio.run(CombinationReviewService(agent, "test-model").analyze(AnalyzeRequest.model_validate(request)))

    assert all(
        citation["quote"] == request["evidence"][0]["text"]
        for stage in result["pairs"][0]["stages"]
        for citation in stage["citations"]
    )


def test_a_third_program_is_rejected_before_pair_analysis():
    request = request_data()
    program = deepcopy(request["programs"][0])
    program["sourceProgramId"] = "PBLN_3"
    request["programs"].append(program)
    request["evidence"].append({**request["evidence"][0], "id":"E2", "programIndex":2})
    with pytest.raises(ValidationError):
        AnalyzeRequest.model_validate(request)


def test_too_large_context_rejected_without_model_call(monkeypatch):
    import app.combination_review.service as module
    monkeypatch.setattr(module.tiktoken, "get_encoding", lambda _: SimpleNamespace(encode=lambda *a, **kw: [0]*100001))
    agent = SimpleNamespace(analyze=AsyncMock())
    with pytest.raises(CombinationReviewError, match="CONTEXT_TOO_LARGE"):
        asyncio.run(CombinationReviewService(agent, "test-model").analyze(AnalyzeRequest.model_validate(request_data())))
    agent.analyze.assert_not_called()


def test_timeout_is_distinguished_from_a_normal_insufficient_evidence_answer():
    agent = SimpleNamespace(analyze=AsyncMock(side_effect=TimeoutError()))
    with pytest.raises(CombinationReviewError, match="COMBINATION_REVIEW_TIMEOUT"):
        asyncio.run(CombinationReviewService(agent, "test-model").analyze(AnalyzeRequest.model_validate(request_data())))


def test_execution_failure_is_not_a_normal_insufficient_evidence_answer():
    agent = SimpleNamespace(analyze=AsyncMock(side_effect=RuntimeError("private upstream detail")))
    with pytest.raises(CombinationReviewError, match="COMBINATION_REVIEW_FAILED"):
        asyncio.run(CombinationReviewService(agent, "test-model").analyze(AnalyzeRequest.model_validate(request_data())))


def test_fastapi_contract_and_generic_failure_response():
    app = create_app(settings=Settings(openai_api_key="unused-test-key", openai_model="test-model",
                                       llm_model_timeout_seconds=2, llm_run_timeout_seconds=3))
    service, _ = make_service()
    app.state.container.combination_review_service = service
    with TestClient(app) as client:
        config = client.get("/internal/v1/combination-reviews/configuration")
        assert config.status_code == 200
        assert config.json() == service.configuration()
        result = client.post("/internal/v1/combination-reviews/analyze", json=request_data())
        assert result.status_code == 200
        assert result.json() == response_data()
        assert client.post("/internal/v1/combination-reviews/analyze", json={}).status_code == 422
        service.agent = SimpleNamespace(analyze=AsyncMock(side_effect=RuntimeError("secret-detail")))
        failure = client.post("/internal/v1/combination-reviews/analyze", json=request_data())
        assert failure.status_code == 503
        assert failure.json() == {"detail":{"code":"COMBINATION_REVIEW_FAILED"}}
        assert "secret-detail" not in failure.text


def test_fastapi_timeout_response_and_safe_diagnostic_log(caplog):
    app = create_app(settings=Settings(openai_api_key="unused-test-key", openai_model="test-model",
                                       llm_model_timeout_seconds=2, llm_run_timeout_seconds=3))
    service, _ = make_service()
    service.agent = SimpleNamespace(analyze=AsyncMock(side_effect=TimeoutError("private-timeout-detail")))
    app.state.container.combination_review_service = service
    caplog.set_level("WARNING", logger="app.combination_review.router")

    with TestClient(app) as client:
        failure = client.post("/internal/v1/combination-reviews/analyze", json=request_data())

    assert failure.status_code == 504
    assert failure.json() == {"detail": {"code": "COMBINATION_REVIEW_TIMEOUT"}}
    assert "failure_kind=timeout" in caplog.text
    assert "failure_reason=upstream_or_schema" in caplog.text
    assert "error_type=TimeoutError" in caplog.text
    assert "program_count=2" in caplog.text
    assert "evidence_count=2" in caplog.text
    assert "private-timeout-detail" not in caplog.text


def options_for(text):
    request = request_data()
    request["evidence"][0]["text"] = text
    return [
        (option.heading, option.quote)
        for option in build_citation_options(AnalyzeRequest.model_validate(request))
        if option.evidenceIndex == 0
    ]


def assert_exact_and_complete(text, options):
    """Every quote is an exact, in-order substring Core accepts, and no non-space character is left out."""
    covered = [False] * len(text)
    cursor = 0
    for heading, quote in options:
        assert 4 <= len(quote) <= 800 and len(quote.encode("utf-16-le")) // 2 <= 800
        assert len(heading) <= 60 and quote == quote.strip()
        index = text.find(quote, cursor)
        assert index >= 0
        covered[index:index + len(quote)] = [True] * len(quote)
        cursor = index + len(quote)
    assert all(covered[index] or char.isspace() for index, char in enumerate(text))


def test_level_one_and_two_bullets_start_items_while_dashes_and_notes_stay_attached():
    lines = [
        "□ 신청 제외 대상: 아래 항목 중 하나라도 해당하는 기업은 신청할 수 없습니다",
        "○ 국세 또는 지방세를 체납 중인 기업(신청일 기준으로 판단합니다)",
        " - 단, 징수유예를 받은 경우는 신청 가능",
        "※ 체납 여부는 납세증명서로 확인",
        "○ 동일 과제로 다른 정부 지원사업에 선정되어 협약 기간 중인 기업",
        "  * 협약 종료 후에는 신청 가능",
    ]
    text = "\n".join(lines)

    assert options_for(text) == [
        ("", lines[0]),
        (lines[0], "\n".join(lines[1:4])),
        (lines[0], "\n".join(lines[4:6]).strip()),
    ]
    assert_exact_and_complete(text, options_for(text))


def test_numbered_items_start_units_but_decimals_and_dates_do_not():
    lines = [
        "1. 지원 내용: 기업당 최대 5천만원 이내에서 총사업비의 70%를 지원합니다",
        "1.5배 이내의 민간부담금은 기업이 현금으로 부담하며 현물은 인정하지 않습니다",
        "2) 최근 3년 이내에 같은 사업에 2회 이상 선정된 기업은 신청이 제한됩니다",
        "(3) 선정 후 협약을 포기한 기업은 다음 연도 공모에 참여할 수 없습니다",
        "가. 다른 부처의 동일 과제 지원을 받고 있는 경우 지원 대상에서 제외합니다",
        "② 휴업 또는 폐업 중인 기업은 신청 자격이 없으며 확인 시 선정을 취소합니다",
        "ㅇ 선정 기업은 협약 기간 안에 사업을 완료하고 결과보고서를 제출하여야 합니다",
        "2026. 12. 31.까지 제출하지 않으면 지원금 일부를 환수할 수 있습니다",
        "주) 기한 연장은 전담기관 승인을 받은 경우에만 인정합니다",
    ]

    assert [quote for _, quote in options_for("\n".join(lines))] == [
        "\n".join(lines[0:2]), lines[2], lines[3], lines[4], lines[5], "\n".join(lines[6:9]),
    ]


def test_a_long_unit_restarts_at_a_line_only_after_a_sentence_end():
    first = "협약 기간 중 사업계획을 변경하려면 사전에 전담기관의 승인을 받아야 하며 " * 8 + "승인 없이 변경하면 환수합니다."
    second = "선정된 기업은 같은 내용으로 다른 기관의 지원을 중복하여 받을 수 없으며 " * 2 + "적발 시 선정을 취소함"
    third = "협약 종료 후 3년간 성과를 보고하여야 합니다."
    unfinished = first.removesuffix("환수합니다.") + "지원금을"

    assert [quote for _, quote in options_for(f"{first}\n{second}\n{third}")] == [first, f"{second}\n{third}"]
    assert [quote for _, quote in options_for(f"{unfinished}\n{second}\n{third}")] == [
        f"{unfinished}\n{second}", third,
    ]


def test_short_units_join_the_next_unit_and_a_tiny_last_unit_joins_the_previous_one():
    long_item = "○ " + "다른 중앙부처나 지자체의 유사 사업에서 같은 비용을 지원받은 경우 지원 대상에서 제외합니다 " * 10
    long_item = long_item.strip()

    assert options_for("□ 신청 자격\n○ 중소기업기본법 제2조에 따른 중소기업으로서 공고일 기준 업력 7년 이내인 기업") == [
        ("", "□ 신청 자격\n○ 중소기업기본법 제2조에 따른 중소기업으로서 공고일 기준 업력 7년 이내인 기업"),
    ]
    assert [quote for _, quote in options_for(f"○ 짧은 항목입니다\n{long_item}")] == ["○ 짧은 항목입니다", long_item]
    assert [quote for _, quote in options_for(f"1)\n{long_item}")] == [f"1)\n{long_item}"]
    assert [quote for _, quote in options_for("○ 국세 체납 기업은 지원 대상에서 제외하며 신청 시 납세증명서를 제출합니다\n② 끝")] == [
        "○ 국세 체납 기업은 지원 대상에서 제외하며 신청 시 납세증명서를 제출합니다\n② 끝",
    ]


def test_a_line_over_800_characters_is_cut_at_spaces_without_dropping_a_short_tail():
    # The last space before 800 characters would leave only "끝다", which is too short to cite.
    line = "가나다라마바사아자차 " * 72 + "가나다라마바 끝다"

    options = options_for(line)

    assert [quote for _, quote in options] == [line[:791], line[792:]]
    assert_exact_and_complete(line, options)
    paragraph = "동일한 사업비로 다른 기관의 지원을 받은 사실이 확인되면 협약을 해지하고 지원금을 환수합니다. " * 40
    assert len(options_for(paragraph)) >= 3
    assert_exact_and_complete(paragraph, options_for(paragraph))


def test_quotes_stay_within_800_utf16_units_for_core():
    text = "\U000F0832나 " * 210

    options = options_for(text)

    assert len(options) == 2
    assert_exact_and_complete(text, options)


def test_heading_is_the_nearest_upper_heading_and_is_not_added_to_the_quote():
    restriction = "□ 다른 정부 창업지원사업에 선정되어 협약 기간 중인 기업과 최근 3년 안에 같은 사업에 선정된 기업은 신청할 수 없습니다"
    text = "\n".join([
        "Ⅰ. 사업 개요",
        "이 사업은 창업기업의 성장을 위해 사업화 자금과 멘토링을 함께 지원하는 사업입니다",
        "1. 지원 대상",
        "□ 신청 자격",
        "○ 공고일 기준 창업 7년 이내인 중소기업으로서 본사가 서울에 있는 기업",
        "○ 대표자가 만 39세 이하인 청년 창업기업은 서류평가에서 2점의 가점을 받을 수 있습니다",
        "2. 지원 제외",
        restriction,
        "- 단, 협약을 정상 종료한 경우 신청 가능",
        "○ 협약 중 사업을 포기한 기업은 포기일부터 1년간 신청할 수 없습니다",
    ])

    # 인용이 이미 그 제목으로 시작하면 같은 줄을 두 번 보내지 않도록 heading을 비웁니다.
    assert options_for(text) == [
        ("", "Ⅰ. 사업 개요\n이 사업은 창업기업의 성장을 위해 사업화 자금과 멘토링을 함께 지원하는 사업입니다"),
        ("", "1. 지원 대상\n□ 신청 자격\n○ 공고일 기준 창업 7년 이내인 중소기업으로서 본사가 서울에 있는 기업"),
        ("□ 신청 자격", "○ 대표자가 만 39세 이하인 청년 창업기업은 서류평가에서 2점의 가점을 받을 수 있습니다"),
        ("", f"2. 지원 제외\n{restriction}\n- 단, 협약을 정상 종료한 경우 신청 가능"),
        (restriction[:60], "○ 협약 중 사업을 포기한 기업은 포기일부터 1년간 신청할 수 없습니다"),
    ]


REALISTIC_EXCERPTS = [
    # HWP paragraphs
    "지식재산처 공고 제2026-144호\n2026년 IP투자연계 지식재산평가 지원사업 공고\n1. 사업 개요\n"
    "□ 우수 지식재산(IP)을 보유한 중소·초기 중견기업에 대한 투자심의 시 평가비용 지원\n2. 지원 대상\n"
    "□ 신청일 현재 공개된 출원 또는 등록된 특허권을 보유하고 투자를 유치함에 있어\n"
    "ㅇ 중소기업기본법 제2조에 따른 중소기업\n"
    "ㅇ 중견기업 성장촉진 및 경쟁력 강화에 관한 특별법 제2조에 따른 중견기업(단, 직전연도 매출액 3,000억원 이상 제외)\n"
    "\n\n※ 동일 특허로 같은 연도에 다른 평가지원 사업의 지원을 받은 경우 신청 불가\n② 끝",
    # PDF page with CRLF, wrapped lines and a page number
    "3. 신청 제외 대상\r\n  가. 공고일 현재 국세·지방세 체납 기업. 단, 징수유예 또는 체납처분 유예를 받은 경우는\r\n"
    "예외로 함\r\n  나) 정부 R&D 사업에 참여제한 중인 기업\r\n    - 참여제한 기간이 공고 마감일 이전에 종료되는 경우 신청 가능\r\n"
    "  * 다른 부처 유사 사업과 중복 수혜가 확인되면 선정을 취소하고 지원금을 환수함\r\n- 3 -\r\n",
    # Table cells extracted one per line
    "업종 분류\n산업분류코드\n(KSIC-11)\n제외 업종\n제조업\n33402 中\n불건전 영상게임기 제조업\n"
    + "\n".join(f"{code}\n제외 업종 예시 {code}" for code in range(56211, 56311)),
    # Consent form paragraph longer than 800 characters
    "◈ 기업(개인)정보 수집·이용에 관한 사항\n수집·이용 목적\n"
    + "신청자격 및 중복지원 검토, 선정평가, 협약체결, 사업운영, 사후관리, 정책자료 활용 등 제반사항, " * 14
    + "\n동의를 거부할 수 있으나 거부 시 지원이 불가능합니다.",
]


@pytest.mark.parametrize("text", REALISTIC_EXCERPTS)
def test_realistic_excerpts_split_into_exact_complete_quotes(text):
    assert_exact_and_complete(text, options_for(text))


def test_generated_blocks_always_split_into_exact_complete_quotes():
    generator = random.Random(305)
    starts = ["", "", "□ ", "○ ", "ㅇ ", "- ", "※ ", "* ", "1. ", "2) ", "(3) ", "가. ", "① ", "Ⅱ. ", "제2조 ", "1.5 ", "주) "]
    words = ["중복", "지원", "제외", "신청", "협약", "기업은", "다른 사업", "합니다.", "함", "가", "　", "  ", "\U000F0832"]
    for _ in range(300):
        lines, size = [], generator.randint(1, 3800)
        while sum(len(line) + 1 for line in lines) < size:
            body = " ".join(generator.choice(words) for _ in range(generator.choice([0, 1, 3, 20, 150, 400])))
            lines.append(generator.choice(["", " ", "\t"]) + generator.choice(starts) + body + generator.choice(["", " ", "\r"]))
        text = "\n".join(lines)[:4000]
        if len(text.strip()) >= 4:
            assert_exact_and_complete(text, options_for(text))


def many_options_request(count):
    request = request_data()
    line = "○ 다른 정부 지원사업에 선정되어 협약 기간 중인 기업은 신청할 수 없습니다 {:04d}"
    request["evidence"] = [
        {**request["evidence"][0], "id": f"E{index}", "programIndex": index % 2,
         "text": "\n".join(line.format(index * 5 + item) for item in range(5 if index < count - 2048 else 4))}
        for index in range(512)
    ]
    return AnalyzeRequest.model_validate(request)


@pytest.mark.parametrize(("count", "accepted"), [(2048, True), (2049, False)])
def test_more_than_2048_citation_options_fail_before_the_model_call(monkeypatch, count, accepted):
    import app.combination_review.service as module
    monkeypatch.setattr(module.tiktoken, "get_encoding", lambda _: SimpleNamespace(encode=lambda *a, **kw: [0]))
    request = many_options_request(count)
    assert len(build_citation_options(request)) == count
    agent = SimpleNamespace(analyze=AsyncMock(return_value=AnalysisSelection.model_validate(selection_data())))

    if accepted:
        asyncio.run(CombinationReviewService(agent, "test-model").analyze(request))
        assert agent.analyze.call_count == 1
        return
    with pytest.raises(CombinationReviewError, match="CONTEXT_TOO_LARGE"):
        asyncio.run(CombinationReviewService(agent, "test-model").analyze(request))
    agent.analyze.assert_not_called()

    app = create_app(settings=Settings(openai_api_key="unused-test-key", openai_model="test-model",
                                       llm_model_timeout_seconds=2, llm_run_timeout_seconds=3))
    app.state.container.combination_review_service = CombinationReviewService(agent, "test-model")
    with TestClient(app) as client:
        failure = client.post("/internal/v1/combination-reviews/analyze", json=request.model_dump())
    assert failure.status_code == 422
    assert failure.json() == {"detail": {"code": "CONTEXT_TOO_LARGE"}}
    agent.analyze.assert_not_called()


def test_agent_sends_option_headings_while_core_still_receives_evidence_id_and_quote():
    request = request_data()
    request["evidence"][0]["text"] = (
        "□ 신청 제한\n○ 다른 정부 창업지원사업에 선정되어 협약 기간 중인 기업은 신청할 수 없습니다\n"
        "○ 최근 3년 이내 같은 사업에 선정된 기업은 신청할 수 없으며 적발 시 선정을 취소합니다"
    )
    service, calls = make_service()

    result = asyncio.run(service.analyze(AnalyzeRequest.model_validate(request)))

    body = json.loads(calls[0].content)
    payload = json.loads(next(message for message in body["input"] if message["role"] == "user")["content"])
    first = "□ 신청 제한\n○ 다른 정부 창업지원사업에 선정되어 협약 기간 중인 기업은 신청할 수 없습니다"
    assert payload["citationOptions"] == [
        {"citationOptionIndex": 0, "programIndex": 0, "locator": "contract fixture", "heading": "", "quote": first},
        {"citationOptionIndex": 1, "programIndex": 0, "locator": "contract fixture", "heading": "□ 신청 제한",
         "quote": "○ 최근 3년 이내 같은 사업에 선정된 기업은 신청할 수 없으며 적발 시 선정을 취소합니다"},
        {"citationOptionIndex": 2, "programIndex": 1, "locator": "contract fixture", "heading": "",
         "quote": request["evidence"][1]["text"]},
    ]
    citations = [citation for stage in result["pairs"][0]["stages"] for citation in stage["citations"]]
    assert citations and all(citation == {"evidenceId": "E0", "quote": first} for citation in citations)
