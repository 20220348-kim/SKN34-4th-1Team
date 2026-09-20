from dataclasses import replace
from types import SimpleNamespace

import pytest
from agents.testing import ScriptedModel

import app.bootstrap as bootstrap_module
from app.assistant_agent.service import AssistantAgentService
from app.bootstrap import build_application_container
from app.config import Settings, SettingsConfigurationError


SETTINGS = Settings(
    openai_api_key="private-key", openai_model="test-model", llm_model_timeout_seconds=1.25, llm_run_timeout_seconds=1.75,
    assistant_tools_token="assistant-tools-secret-for-tests-0123456789", assistant_tools_base_url="http://core-service:8080",
)


class FakeOpenAIClient:
    def __init__(self) -> None:
        self.closed = False
        self.chat = SimpleNamespace(completions=object())

    def with_options(self, **kwargs):
        return SimpleNamespace(chat=self.chat, **kwargs)

    async def close(self) -> None:
        self.closed = True


class FakeChatOpenAI:
    instances: list["FakeChatOpenAI"] = []

    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        FakeChatOpenAI.instances.append(self)

    def bind(self, **kwargs):
        return SimpleNamespace(bound=self, kwargs=kwargs)

    def with_structured_output(self, *args, **kwargs):
        return object()  # Bootstrap tests must never call the model.


@pytest.mark.anyio
async def test_agent_models_tool_client_and_service_are_wired_and_closed(monkeypatch):
    FakeChatOpenAI.instances = []
    client = FakeOpenAIClient()
    monkeypatch.setattr(bootstrap_module, "AsyncOpenAI", lambda **kwargs: client)
    monkeypatch.setattr(bootstrap_module, "OpenAIResponsesModel", lambda **kwargs: ScriptedModel([]))
    monkeypatch.setattr(bootstrap_module, "ChatOpenAI", FakeChatOpenAI)
    settings = replace(SETTINGS, openai_assistant_agent_model="gpt-5.6-sol", openai_assistant_agent_reasoning_effort="low")
    container = build_application_container(settings)
    try:
        assert isinstance(container.assistant_agent_service, AssistantAgentService)
        assert container.assistant_agent_service._timeout_seconds == 15.0
        general, ranking, application, combination, classify, agent = FakeChatOpenAI.instances
        assert application.kwargs["root_async_client"] is client
        assert application.kwargs["timeout"] == 1.25
        assert application.kwargs["max_retries"] == 0
        assert application.kwargs["store"] is False
        assert combination.kwargs["max_tokens"] == 6000
        assert combination.kwargs["timeout"] == 60
        # 분류는 도우미와 같은 싼 모델·low, 계획·답은 전용 모델. 둘 다 저장 안 함·재시도 없음·도우미 제한 시간.
        assert classify.kwargs == {"model": "gpt-5-nano", "api_key": "private-key", "use_responses_api": True, "store": False,
                                   "reasoning": {"effort": "low"}, "timeout": 1.25, "max_retries": 0}
        assert agent.kwargs == {"model": "gpt-5.6-sol", "api_key": "private-key", "use_responses_api": True, "store": False,
                                "reasoning": {"effort": "low"}, "timeout": 1.25, "max_retries": 0}
        tool_client = container.assistant_tool_client
        assert tool_client is not None and tool_client.enabled
        assert str(tool_client._client.base_url) == "http://core-service:8080"
        assert tool_client._client.timeout.read == 3.0
    finally:
        await container.close()
    assert container.assistant_tool_client._client.is_closed
    assert client.closed


@pytest.mark.anyio
async def test_supplied_agent_service_skips_model_and_client_construction(monkeypatch):
    FakeChatOpenAI.instances = []
    client = FakeOpenAIClient()
    monkeypatch.setattr(bootstrap_module, "AsyncOpenAI", lambda **kwargs: client)
    monkeypatch.setattr(bootstrap_module, "OpenAIResponsesModel", lambda **kwargs: ScriptedModel([]))
    monkeypatch.setattr(bootstrap_module, "ChatOpenAI", FakeChatOpenAI)
    service = object.__new__(AssistantAgentService)
    container = build_application_container(SETTINGS, assistant_agent_service=service)
    try:
        assert container.assistant_agent_service is service
        assert container.assistant_tool_client is None
        assert len(FakeChatOpenAI.instances) == 4
        assert FakeChatOpenAI.instances[3].kwargs["max_tokens"] == 6000
    finally:
        await container.close()
    assert client.closed


def test_agent_settings_read_from_environment(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "private-key")
    monkeypatch.setenv("OPENAI_ASSISTANT_AGENT_MODEL", " gpt-5-nano ")
    monkeypatch.setenv("OPENAI_ASSISTANT_AGENT_REASONING_EFFORT", "low")
    monkeypatch.setenv("ASSISTANT_TOOLS_BASE_URL", "http://core-service:8080/")
    monkeypatch.setenv("ASSISTANT_TOOLS_TOKEN", " secret-value-that-is-long-enough-0123456789 ")
    monkeypatch.setenv("ASSISTANT_AGENT_MAX_TOOL_CALLS", "2")
    monkeypatch.setenv("ASSISTANT_AGENT_TIMEOUT_SECONDS", "12")
    monkeypatch.setenv("ASSISTANT_TOOL_TIMEOUT_SECONDS", "2.5")
    settings = Settings.from_environment()
    assert settings.openai_assistant_agent_model == "gpt-5-nano"
    assert settings.openai_assistant_agent_reasoning_effort == "low"
    assert settings.assistant_tools_base_url == "http://core-service:8080/"
    assert settings.assistant_tools_token == "secret-value-that-is-long-enough-0123456789"
    assert settings.assistant_agent_max_tool_calls == 2
    assert settings.assistant_agent_timeout_seconds == 12
    assert settings.assistant_tool_timeout_seconds == 2.5


def test_agent_settings_defaults(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "private-key")
    for name in ("OPENAI_ASSISTANT_AGENT_MODEL", "OPENAI_ASSISTANT_AGENT_REASONING_EFFORT", "ASSISTANT_TOOLS_BASE_URL",
                 "ASSISTANT_TOOLS_TOKEN", "ASSISTANT_AGENT_MAX_TOOL_CALLS", "ASSISTANT_AGENT_TIMEOUT_SECONDS", "ASSISTANT_TOOL_TIMEOUT_SECONDS"):
        monkeypatch.delenv(name, raising=False)
    settings = Settings.from_environment()
    assert settings.openai_assistant_agent_model == "gpt-5.6-luna"
    assert settings.openai_assistant_agent_reasoning_effort == "none"
    assert settings.assistant_tools_base_url == "http://127.0.0.1:8080"
    assert settings.assistant_tools_token is None
    assert (settings.assistant_agent_max_tool_calls, settings.assistant_agent_timeout_seconds, settings.assistant_tool_timeout_seconds) == (3, 15.0, 3.0)


@pytest.mark.parametrize("name,value", [
    ("OPENAI_ASSISTANT_AGENT_REASONING_EFFORT", "minimal"),
    ("ASSISTANT_AGENT_MAX_TOOL_CALLS", "0"),
    ("ASSISTANT_AGENT_MAX_TOOL_CALLS", "7"),
    ("ASSISTANT_AGENT_MAX_TOOL_CALLS", "three"),
    ("ASSISTANT_TOOLS_BASE_URL", "core-service:8080"),
    ("ASSISTANT_TOOL_TIMEOUT_SECONDS", "20"),
])
def test_invalid_agent_settings_fail_startup(monkeypatch, name, value):
    monkeypatch.setenv("OPENAI_API_KEY", "private-key")
    monkeypatch.setenv(name, value)
    with pytest.raises(SettingsConfigurationError) as info:
        Settings.from_environment()
    assert value not in str(info.value) or value in ("0", "7", "20")
