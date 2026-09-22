import httpx
import pytest
from langchain_core.messages import ToolMessage

from app.assistant_agent.errors import ToolCallError
from app.assistant_agent.models import AssistantPrincipal
from app.assistant_agent.tools import CoreToolClient, build_tools, sanitize
from tests.assistant_agent.fakes import FakeCoreTools


PRINCIPAL = AssistantPrincipal(accountId=7, toolToken="7.1900000000.sig", hasCompany=True)


def client_for(fake: FakeCoreTools, secret: str | None = None) -> CoreToolClient:
    return CoreToolClient(
        base_url="http://core-service:8080/", secret=fake.secret if secret is None else secret, timeout_seconds=1, transport=fake.transport(),
    )


@pytest.mark.anyio
async def test_get_sends_shared_secret_account_token_and_account_id():
    fake = FakeCoreTools()
    client = client_for(fake)
    try:
        data = await client.get("/recruitments", PRINCIPAL, {"region": "서울", "seekingRole": "", "keyword": ""})
    finally:
        await client.aclose()
    assert [item["id"] for item in data] == [21]
    request = fake.requests[0]
    assert request.url.path == "/internal/v1/assistant/tools/recruitments"
    assert dict(request.url.params) == {"accountId": "7", "region": "서울"}
    assert request.headers["X-Internal-Token"] == fake.secret
    assert request.headers["X-Assistant-Tool-Token"] == PRINCIPAL.tool_token


@pytest.mark.anyio
@pytest.mark.parametrize("status", [401, 503, 500])
async def test_non_200_is_a_tool_call_error(status):
    fake = FakeCoreTools()
    fake.fail_with = status
    client = client_for(fake)
    try:
        with pytest.raises(ToolCallError):
            await client.get("/company-profile", PRINCIPAL)
    finally:
        await client.aclose()


@pytest.mark.anyio
async def test_transport_errors_and_missing_secret_are_tool_call_errors():
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    client = CoreToolClient(base_url="http://core-service:8080", secret="s" * 40, timeout_seconds=1, transport=httpx.MockTransport(boom))
    try:
        with pytest.raises(ToolCallError):
            await client.get("/company-profile", PRINCIPAL)
    finally:
        await client.aclose()
    disabled = client_for(FakeCoreTools(), secret="")
    try:
        assert not disabled.enabled
        with pytest.raises(ToolCallError):
            await disabled.get("/company-profile", PRINCIPAL)
    finally:
        await disabled.aclose()


@pytest.mark.anyio
async def test_tools_return_tool_messages_with_sanitized_artifacts():
    fake = FakeCoreTools()
    client = client_for(fake)
    try:
        tools = {tool.name: tool for tool in build_tools(client, PRINCIPAL)}
        assert set(tools) == {"get_my_company_profile", "search_partner_recruitments", "list_saved_programs"}
        message = await tools["search_partner_recruitments"].ainvoke(
            {"name": "search_partner_recruitments", "args": {"region": "서울", "seekingRole": "PARTICIPANT"}, "id": "call_1", "type": "tool_call"},
        )
        profile = await tools["get_my_company_profile"].ainvoke({"name": "get_my_company_profile", "args": {}, "id": "call_2", "type": "tool_call"})
    finally:
        await client.aclose()
    assert isinstance(message, ToolMessage)
    assert message.artifact[0]["id"] == 21
    assert "AI 실증 참여기관 구합니다" in message.content
    assert dict(fake.requests[0].url.params) == {"accountId": "7", "region": "서울", "seekingRole": "PARTICIPANT"}
    assert profile.artifact["companyName"] == "데이터브릿지 주식회사"


def test_sanitize_masks_pii_strips_urls_truncates_and_keeps_identifiers():
    value = {
        "id": 21, "sourceProgramId": "PBLN_0101234567", "recruitmentDeadline": "2026-09-20",
        "body": "담당자 kim@partner.co.kr 010-9999-8888 사업자 123-45-67890 https://evil.example/a 참고 " + "가" * 700,
        "capabilities": [f"c{i}" for i in range(40)], "nested": {"a": {"b": {"c": {"d": {"e": "deep"}}}}}, "flag": True, "none": None,
    }
    result = sanitize(value)
    assert result["id"] == 21
    assert result["sourceProgramId"] == "PBLN_0101234567"
    assert result["recruitmentDeadline"] == "2026-09-20"
    assert "kim@partner.co.kr" not in result["body"] and "[이메일]" in result["body"]
    assert "010-9999-8888" not in result["body"] and "[전화번호]" in result["body"]
    assert "123-45-67890" not in result["body"]
    assert "https://" not in result["body"] and "[링크]" in result["body"]
    assert result["body"].endswith("…") and len(result["body"]) <= 601
    assert len(result["capabilities"]) == 30
    assert result["nested"]["a"]["b"]["c"]["d"] is None
    assert result["flag"] is True and result["none"] is None


@pytest.mark.anyio
@pytest.mark.parametrize("source_program_id", ["PBLN_" + "1" * 250, "지원 사업~*:" + "😀" * 200])
async def test_saved_program_tool_keeps_full_source_ids_in_the_detail_link(monkeypatch, source_program_id):
    from urllib.parse import parse_qs, urlsplit
    from app.assistant_agent.models import AssistantCard
    from app.assistant_agent.nodes.verify import card_catalog

    source_code = "A" * 64
    identifier = f"{source_code}:{source_program_id}"
    monkeypatch.setattr("tests.assistant_agent.fakes.SAVED_PROGRAMS", [{
        "sourceCode": source_code, "sourceProgramId": source_program_id,
        "title": "지원사업", "organization": "기관", "applicationEndDate": None,
    }])
    client = client_for(FakeCoreTools())
    try:
        tool = next(tool for tool in build_tools(client, PRINCIPAL) if tool.name == "list_saved_programs")
        message = await tool.ainvoke({"name": tool.name, "args": {}, "id": "call_saved", "type": "tool_call"})
    finally:
        await client.aclose()

    assert message.artifact[0]["sourceProgramId"] == source_program_id
    catalog = card_catalog([{"name": "list_saved_programs", "ok": True, "data": message.artifact, "ms": 0}])
    card = AssistantCard(**catalog[("PROGRAM", identifier)], reason="관심 공고", quote=None)
    assert parse_qs(urlsplit(card.to).query) == {"sourceCode": [source_code], "sourceProgramId": [source_program_id]}
