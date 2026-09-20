from dataclasses import dataclass
from math import isfinite
from os import environ
from typing import Literal, cast


DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"
# 도우미 자유 질문은 짧은 분류 작업이라 가장 싼 모델을 기본으로 쓴다. 다른 기능의 모델은 바꾸지 않는다.
# nano는 추론 minimal에서 분류가 흔들려(50문항 중 28개) low를 기본으로 둔다. 평가 기록은 evaluation/assistant/runs 참고.
DEFAULT_OPENAI_ASSISTANT_MODEL = "gpt-5-nano"
ASSISTANT_REASONING_EFFORTS = ("none", "minimal", "low")
# 도우미 도구 에이전트(LangGraph)의 계획·답 모델. 도구 선택 정확도를 위해 luna를 기본으로 둔다.
DEFAULT_ASSISTANT_TOOLS_BASE_URL = "http://127.0.0.1:8080"
DEFAULT_ASSISTANT_AGENT_MAX_TOOL_CALLS = 3
DEFAULT_ASSISTANT_AGENT_TIMEOUT_SECONDS = 15.0
DEFAULT_ASSISTANT_TOOL_TIMEOUT_SECONDS = 3.0
MAX_ASSISTANT_AGENT_MAX_TOOL_CALLS = 6
DEFAULT_LLM_MODEL_TIMEOUT_SECONDS = 25.0
DEFAULT_LLM_RUN_TIMEOUT_SECONDS = 30.0
DEFAULT_LLM_RANKING_MODEL_TIMEOUT_SECONDS = 45.0
DEFAULT_LLM_RANKING_RUN_TIMEOUT_SECONDS = 50.0
DEFAULT_LLM_COMBINATION_REVIEW_MODEL_TIMEOUT_SECONDS = 60.0
DEFAULT_LLM_COMBINATION_REVIEW_RUN_TIMEOUT_SECONDS = 70.0
MAX_LLM_RANKING_TIMEOUT_SECONDS = 60.0
MAX_LLM_COMBINATION_REVIEW_TIMEOUT_SECONDS = 120.0


@dataclass(frozen=True, slots=True)
class Settings:
    """환경변수에서 읽는 지원사업 추천 점수화 agent 설정."""

    openai_api_key: str
    openai_model: str
    llm_model_timeout_seconds: float
    llm_run_timeout_seconds: float
    application_form_discovery_model_timeout_seconds: float = 210.0
    application_form_discovery_run_timeout_seconds: float = 240.0
    qdrant_url: str = "http://localhost:6333"
    qdrant_api_key: str | None = None
    qdrant_timeout_seconds: float = 5.0
    openai_embedding_model: str = "text-embedding-3-small"
    openai_embedding_dimensions: int = 1536
    embedding_timeout_seconds: float = 15.0
    llm_ranking_model_timeout_seconds: float = DEFAULT_LLM_RANKING_MODEL_TIMEOUT_SECONDS
    llm_ranking_run_timeout_seconds: float = DEFAULT_LLM_RANKING_RUN_TIMEOUT_SECONDS
    llm_combination_review_model_timeout_seconds: float = DEFAULT_LLM_COMBINATION_REVIEW_MODEL_TIMEOUT_SECONDS
    llm_combination_review_run_timeout_seconds: float = DEFAULT_LLM_COMBINATION_REVIEW_RUN_TIMEOUT_SECONDS
    openai_ranking_model: str | None = None
    openai_ranking_reasoning_effort: Literal["none", "low"] = "none"
    openai_ranking_service_tier: Literal["default", "priority"] = "default"
    openai_assistant_model: str = DEFAULT_OPENAI_ASSISTANT_MODEL
    openai_assistant_reasoning_effort: Literal["none", "minimal", "low"] = "low"
    openai_assistant_agent_model: str = DEFAULT_OPENAI_MODEL
    openai_assistant_agent_reasoning_effort: Literal["none", "low"] = "none"
    assistant_tools_base_url: str = DEFAULT_ASSISTANT_TOOLS_BASE_URL
    assistant_tools_token: str | None = None
    assistant_agent_max_tool_calls: int = DEFAULT_ASSISTANT_AGENT_MAX_TOOL_CALLS
    assistant_agent_timeout_seconds: float = DEFAULT_ASSISTANT_AGENT_TIMEOUT_SECONDS
    assistant_tool_timeout_seconds: float = DEFAULT_ASSISTANT_TOOL_TIMEOUT_SECONDS

    def __post_init__(self) -> None:
        model = self.application_form_discovery_model_timeout_seconds
        run = self.application_form_discovery_run_timeout_seconds
        if isinstance(model, bool) or isinstance(run, bool) or not isfinite(model) or not isfinite(run) or not 0 < model < run <= 1500:
            raise SettingsConfigurationError("Application form discovery requires 0 < model timeout < run timeout <= 1500")
        if self.openai_assistant_agent_reasoning_effort not in ("none", "low"):
            raise SettingsConfigurationError("OPENAI_ASSISTANT_AGENT_REASONING_EFFORT must be none or low")
        if (
            isinstance(self.assistant_agent_max_tool_calls, bool)
            or not 1 <= self.assistant_agent_max_tool_calls <= MAX_ASSISTANT_AGENT_MAX_TOOL_CALLS
        ):
            raise SettingsConfigurationError("ASSISTANT_AGENT_MAX_TOOL_CALLS must be 1~6")
        if not self.assistant_tools_base_url.startswith(("http://", "https://")):
            raise SettingsConfigurationError("ASSISTANT_TOOLS_BASE_URL must be an http(s) address")
        if self.assistant_tool_timeout_seconds >= self.assistant_agent_timeout_seconds:
            raise SettingsConfigurationError("ASSISTANT_TOOL_TIMEOUT_SECONDS must be less than ASSISTANT_AGENT_TIMEOUT_SECONDS")
        if self.openai_assistant_reasoning_effort not in ASSISTANT_REASONING_EFFORTS:
            raise SettingsConfigurationError("OPENAI_ASSISTANT_REASONING_EFFORT must be none, minimal or low")
        if self.openai_ranking_reasoning_effort not in ("none", "low"):
            raise SettingsConfigurationError("OPENAI_RANKING_REASONING_EFFORT must be none or low")
        if self.openai_ranking_service_tier not in ("default", "priority"):
            raise SettingsConfigurationError("OPENAI_RANKING_SERVICE_TIER must be default or priority")
        for name, value in (
            ("LLM_RANKING_MODEL_TIMEOUT_SECONDS", self.llm_ranking_model_timeout_seconds),
            ("LLM_RANKING_RUN_TIMEOUT_SECONDS", self.llm_ranking_run_timeout_seconds),
        ):
            if isinstance(value, bool) or not isfinite(value) or not 0 < value <= MAX_LLM_RANKING_TIMEOUT_SECONDS:
                raise SettingsConfigurationError(f"{name} must be finite and greater than 0, up to 60 seconds")
        if self.llm_ranking_model_timeout_seconds >= self.llm_ranking_run_timeout_seconds:
            raise SettingsConfigurationError("LLM_RANKING_MODEL_TIMEOUT_SECONDS must be less than LLM_RANKING_RUN_TIMEOUT_SECONDS")
        for name, value in (
            ("LLM_COMBINATION_REVIEW_MODEL_TIMEOUT_SECONDS", self.llm_combination_review_model_timeout_seconds),
            ("LLM_COMBINATION_REVIEW_RUN_TIMEOUT_SECONDS", self.llm_combination_review_run_timeout_seconds),
        ):
            if isinstance(value, bool) or not isfinite(value) or not 0 < value <= MAX_LLM_COMBINATION_REVIEW_TIMEOUT_SECONDS:
                raise SettingsConfigurationError(f"{name} must be finite and greater than 0, up to 120 seconds")
        if self.llm_combination_review_model_timeout_seconds >= self.llm_combination_review_run_timeout_seconds:
            raise SettingsConfigurationError(
                "LLM_COMBINATION_REVIEW_MODEL_TIMEOUT_SECONDS must be less than LLM_COMBINATION_REVIEW_RUN_TIMEOUT_SECONDS"
            )

    @classmethod
    def from_environment(cls) -> "Settings":
        legacy_run_timeout = environ.get("LLM_TIMEOUT_SECONDS")
        openai_api_key = _optional_value(environ.get("OPENAI_API_KEY"))
        if openai_api_key is None:
            raise SettingsConfigurationError("OPENAI_API_KEY is required")

        return cls(
            openai_api_key=openai_api_key,
            openai_model=(
                environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL).strip()
                or DEFAULT_OPENAI_MODEL
            ),
            openai_ranking_model=_optional_value(environ.get("OPENAI_RANKING_MODEL")),
            openai_ranking_reasoning_effort=cast(
                Literal["none", "low"], environ.get("OPENAI_RANKING_REASONING_EFFORT", "none").strip(),
            ),
            openai_ranking_service_tier=cast(
                Literal["default", "priority"], environ.get("OPENAI_RANKING_SERVICE_TIER", "default").strip(),
            ),
            openai_assistant_model=_optional_value(environ.get("OPENAI_ASSISTANT_MODEL")) or DEFAULT_OPENAI_ASSISTANT_MODEL,
            openai_assistant_reasoning_effort=cast(
                Literal["none", "minimal", "low"],
                _optional_value(environ.get("OPENAI_ASSISTANT_REASONING_EFFORT")) or "low",
            ),
            openai_assistant_agent_model=_optional_value(environ.get("OPENAI_ASSISTANT_AGENT_MODEL")) or DEFAULT_OPENAI_MODEL,
            openai_assistant_agent_reasoning_effort=cast(
                Literal["none", "low"], _optional_value(environ.get("OPENAI_ASSISTANT_AGENT_REASONING_EFFORT")) or "none",
            ),
            assistant_tools_base_url=_optional_value(environ.get("ASSISTANT_TOOLS_BASE_URL")) or DEFAULT_ASSISTANT_TOOLS_BASE_URL,
            assistant_tools_token=_optional_value(environ.get("ASSISTANT_TOOLS_TOKEN")),
            assistant_agent_max_tool_calls=_bounded_int(
                "ASSISTANT_AGENT_MAX_TOOL_CALLS", DEFAULT_ASSISTANT_AGENT_MAX_TOOL_CALLS,
            ),
            assistant_agent_timeout_seconds=_positive_float(
                environ.get("ASSISTANT_AGENT_TIMEOUT_SECONDS"), default=DEFAULT_ASSISTANT_AGENT_TIMEOUT_SECONDS,
            ),
            assistant_tool_timeout_seconds=_positive_float(
                environ.get("ASSISTANT_TOOL_TIMEOUT_SECONDS"), default=DEFAULT_ASSISTANT_TOOL_TIMEOUT_SECONDS,
            ),
            llm_model_timeout_seconds=_positive_float(
                environ.get("LLM_MODEL_TIMEOUT_SECONDS"),
                default=DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
            ),
            llm_run_timeout_seconds=_positive_float(
                environ.get("LLM_RUN_TIMEOUT_SECONDS", legacy_run_timeout),
                default=DEFAULT_LLM_RUN_TIMEOUT_SECONDS,
            ),
            llm_ranking_model_timeout_seconds=_strict_timeout(
                "LLM_RANKING_MODEL_TIMEOUT_SECONDS", DEFAULT_LLM_RANKING_MODEL_TIMEOUT_SECONDS,
            ),
            llm_ranking_run_timeout_seconds=_strict_timeout(
                "LLM_RANKING_RUN_TIMEOUT_SECONDS", DEFAULT_LLM_RANKING_RUN_TIMEOUT_SECONDS,
            ),
            llm_combination_review_model_timeout_seconds=_strict_timeout(
                "LLM_COMBINATION_REVIEW_MODEL_TIMEOUT_SECONDS",
                DEFAULT_LLM_COMBINATION_REVIEW_MODEL_TIMEOUT_SECONDS,
            ),
            llm_combination_review_run_timeout_seconds=_strict_timeout(
                "LLM_COMBINATION_REVIEW_RUN_TIMEOUT_SECONDS",
                DEFAULT_LLM_COMBINATION_REVIEW_RUN_TIMEOUT_SECONDS,
            ),
            application_form_discovery_model_timeout_seconds=_strict_timeout("APPLICATION_FORM_DISCOVERY_MODEL_TIMEOUT_SECONDS", 210.0),
            application_form_discovery_run_timeout_seconds=_strict_timeout("APPLICATION_FORM_DISCOVERY_RUN_TIMEOUT_SECONDS", 240.0),
            qdrant_url=_optional_value(environ.get("QDRANT_URL")) or "http://localhost:6333",
            qdrant_api_key=_optional_value(environ.get("QDRANT_API_KEY")),
            qdrant_timeout_seconds=_positive_float(
                environ.get("QDRANT_TIMEOUT_SECONDS"), default=5.0,
            ),
            openai_embedding_model=_embedding_model(),
            openai_embedding_dimensions=_embedding_dimensions(),
            embedding_timeout_seconds=_positive_float(
                environ.get("EMBEDDING_TIMEOUT_SECONDS"), default=15.0,
            ),
        )


class SettingsConfigurationError(RuntimeError):
    """필수 AI Service 환경설정이 없을 때 발생하는 시작 오류."""


def _optional_value(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def _positive_float(value: str | None, *, default: float) -> float:
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError:
        return default
    return parsed if 0 < parsed <= 30 else default


def _bounded_int(name: str, default: int) -> int:
    value = _optional_value(environ.get(name))
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        # Do not include the supplied value in a startup error.
        raise SettingsConfigurationError(f"{name} must be an integer") from None


def _strict_timeout(name: str, default: float) -> float:
    value = environ.get(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        # Do not include the supplied value in a startup error.
        raise SettingsConfigurationError(f"{name} must be a finite positive number") from None


def _embedding_model() -> str:
    model = _optional_value(environ.get("OPENAI_EMBEDDING_MODEL")) or "text-embedding-3-small"
    if model not in {"text-embedding-3-small", "text-embedding-3-large"}:
        raise SettingsConfigurationError("OPENAI_EMBEDDING_MODEL is not supported")
    return model


def _embedding_dimensions() -> int:
    maximum = 1536 if _embedding_model() == "text-embedding-3-small" else 3072
    try:
        dimensions = int(environ.get("OPENAI_EMBEDDING_DIMENSIONS", "1536"))
    except ValueError as error:
        raise SettingsConfigurationError("OPENAI_EMBEDDING_DIMENSIONS is invalid") from error
    if not 1 <= dimensions <= maximum:
        raise SettingsConfigurationError("OPENAI_EMBEDDING_DIMENSIONS is invalid")
    return dimensions
