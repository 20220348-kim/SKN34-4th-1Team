import pytest

from app.config import (
    DEFAULT_LLM_COMBINATION_REVIEW_MODEL_TIMEOUT_SECONDS,
    DEFAULT_LLM_COMBINATION_REVIEW_RUN_TIMEOUT_SECONDS,
    DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
    DEFAULT_LLM_RUN_TIMEOUT_SECONDS,
    DEFAULT_OPENAI_MODEL,
    Settings,
    SettingsConfigurationError,
)


@pytest.fixture(autouse=True)
def configure_required_openai_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("LLM_RANKING_MODEL_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("LLM_RANKING_RUN_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("LLM_COMBINATION_REVIEW_MODEL_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("LLM_COMBINATION_REVIEW_RUN_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("OPENAI_RANKING_MODEL", raising=False)
    monkeypatch.delenv("OPENAI_RANKING_REASONING_EFFORT", raising=False)
    monkeypatch.delenv("OPENAI_RANKING_SERVICE_TIER", raising=False)


def test_ranking_latency_options_are_explicit_and_default_to_standard_processing(monkeypatch):
    baseline = Settings.from_environment()
    assert baseline.openai_ranking_service_tier == "default"
    monkeypatch.setenv("OPENAI_RANKING_SERVICE_TIER", " priority ")
    changed = Settings.from_environment()
    assert changed.openai_ranking_service_tier == "priority"


@pytest.mark.parametrize("name,value", [
    ("OPENAI_RANKING_SERVICE_TIER", "flex"), ("OPENAI_RANKING_SERVICE_TIER", ""),
])
def test_invalid_latency_option_is_not_silently_enabled(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(SettingsConfigurationError, match=name):
        Settings.from_environment()


def test_reads_trimmed_openai_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", " private-key ")
    monkeypatch.setenv("OPENAI_MODEL", " test-model ")
    monkeypatch.setenv("LLM_MODEL_TIMEOUT_SECONDS", "1.25")
    monkeypatch.setenv("LLM_RUN_TIMEOUT_SECONDS", "1.75")

    settings = Settings.from_environment()

    assert settings.openai_api_key == "private-key"
    assert settings.openai_model == "test-model"
    assert settings.llm_model_timeout_seconds == 1.25
    assert settings.llm_run_timeout_seconds == 1.75


def test_default_timeouts_allow_measured_ranking_latency(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "LLM_MODEL_TIMEOUT_SECONDS",
        "LLM_RUN_TIMEOUT_SECONDS",
        "LLM_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)

    settings = Settings.from_environment()

    assert settings.llm_model_timeout_seconds == 25.0
    assert settings.llm_run_timeout_seconds == 30.0
    assert settings.llm_combination_review_model_timeout_seconds == DEFAULT_LLM_COMBINATION_REVIEW_MODEL_TIMEOUT_SECONDS
    assert settings.llm_combination_review_run_timeout_seconds == DEFAULT_LLM_COMBINATION_REVIEW_RUN_TIMEOUT_SECONDS


def test_accepts_the_thirty_second_timeout_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_MODEL_TIMEOUT_SECONDS", "30")
    monkeypatch.setenv("LLM_RUN_TIMEOUT_SECONDS", "30")

    settings = Settings.from_environment()

    assert settings.llm_model_timeout_seconds == 30.0
    assert settings.llm_run_timeout_seconds == 30.0


@pytest.mark.parametrize(
    ("environment_name", "field_name", "default"),
    [
        (
            "LLM_MODEL_TIMEOUT_SECONDS",
            "llm_model_timeout_seconds",
            DEFAULT_LLM_MODEL_TIMEOUT_SECONDS,
        ),
        (
            "LLM_RUN_TIMEOUT_SECONDS",
            "llm_run_timeout_seconds",
            DEFAULT_LLM_RUN_TIMEOUT_SECONDS,
        ),
    ],
)
@pytest.mark.parametrize("value", [None, "", "0", "-1", "invalid", "31"])
def test_uses_safe_timeout_default(
    monkeypatch: pytest.MonkeyPatch,
    environment_name: str,
    field_name: str,
    default: float,
    value: str | None,
) -> None:
    monkeypatch.delenv("LLM_TIMEOUT_SECONDS", raising=False)
    if value is None:
        monkeypatch.delenv(environment_name, raising=False)
    else:
        monkeypatch.setenv(environment_name, value)

    settings = Settings.from_environment()

    assert getattr(settings, field_name) == default


def test_uses_legacy_timeout_as_run_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LLM_RUN_TIMEOUT_SECONDS", raising=False)
    monkeypatch.setenv("LLM_TIMEOUT_SECONDS", "2.25")

    assert Settings.from_environment().llm_run_timeout_seconds == 2.25


@pytest.mark.parametrize("value", [None, "   "])
def test_requires_nonblank_openai_api_key(
    monkeypatch: pytest.MonkeyPatch,
    value: str | None,
) -> None:
    if value is None:
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    else:
        monkeypatch.setenv("OPENAI_API_KEY", value)

    with pytest.raises(SettingsConfigurationError, match="OPENAI_API_KEY is required"):
        Settings.from_environment()


def test_uses_default_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_MODEL", raising=False)

    assert Settings.from_environment().openai_model == DEFAULT_OPENAI_MODEL


@pytest.mark.parametrize("value", [None, "", "   "])
def test_absent_ranking_model_preserves_the_general_model(monkeypatch, value):
    monkeypatch.setenv("OPENAI_MODEL", "custom-existing-model")
    if value is not None:
        monkeypatch.setenv("OPENAI_RANKING_MODEL", value)
    settings = Settings.from_environment()
    assert settings.openai_ranking_model is None
    assert settings.openai_model == "custom-existing-model"
    assert settings.openai_ranking_reasoning_effort == "none"


@pytest.mark.parametrize("value", [None, "", "   "])
def test_assistant_model_defaults_to_the_cheapest_model(monkeypatch, value):
    monkeypatch.setenv("OPENAI_MODEL", "custom-existing-model")
    for name in ("OPENAI_ASSISTANT_MODEL", "OPENAI_ASSISTANT_REASONING_EFFORT"):
        monkeypatch.delenv(name, raising=False)
        if value is not None:
            monkeypatch.setenv(name, value)
    settings = Settings.from_environment()
    assert settings.openai_assistant_model == "gpt-5-nano"
    assert settings.openai_assistant_reasoning_effort == "low"
    assert settings.openai_model == "custom-existing-model"


def test_reads_trimmed_assistant_model_and_rejects_unknown_reasoning(monkeypatch):
    monkeypatch.setenv("OPENAI_ASSISTANT_MODEL", " gpt-5.6-luna ")
    monkeypatch.setenv("OPENAI_ASSISTANT_REASONING_EFFORT", " minimal ")
    settings = Settings.from_environment()
    assert settings.openai_assistant_model == "gpt-5.6-luna"
    assert settings.openai_assistant_reasoning_effort == "minimal"
    monkeypatch.setenv("OPENAI_ASSISTANT_REASONING_EFFORT", "high")
    with pytest.raises(SettingsConfigurationError):
        Settings.from_environment()


def test_reads_independent_trimmed_ranking_model_and_reasoning(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL", "gpt-5.6-luna")
    monkeypatch.setenv("OPENAI_RANKING_MODEL", " gpt-5.6-sol ")
    monkeypatch.setenv("OPENAI_RANKING_REASONING_EFFORT", " low ")
    settings = Settings.from_environment()
    assert settings.openai_ranking_model == "gpt-5.6-sol"
    assert settings.openai_ranking_reasoning_effort == "low"
    assert settings.openai_model == "gpt-5.6-luna"
    assert settings.openai_embedding_model == "text-embedding-3-small"


@pytest.mark.parametrize("value", ["", " ", "medium", "LOW", "private-invalid-setting"])
def test_invalid_ranking_reasoning_fails_startup_without_silent_replacement(monkeypatch, value):
    monkeypatch.setenv("OPENAI_RANKING_REASONING_EFFORT", value)
    with pytest.raises(SettingsConfigurationError, match="OPENAI_RANKING_REASONING_EFFORT") as captured:
        Settings.from_environment()
    assert "private-invalid-setting" not in str(captured.value)


@pytest.mark.parametrize("value", [None, True, "medium", ""])
def test_direct_settings_also_reject_invalid_ranking_reasoning(value):
    with pytest.raises(SettingsConfigurationError, match="OPENAI_RANKING_REASONING_EFFORT"):
        Settings(openai_api_key="test-key", openai_model="test-model", llm_model_timeout_seconds=25,
                 llm_run_timeout_seconds=30, openai_ranking_reasoning_effort=value)


def test_reads_vector_search_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("QDRANT_URL", " http://qdrant:6333 ")
    monkeypatch.setenv("QDRANT_API_KEY", " private-vector-key ")
    monkeypatch.setenv("QDRANT_TIMEOUT_SECONDS", "2.5")
    monkeypatch.setenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-large")
    monkeypatch.setenv("OPENAI_EMBEDDING_DIMENSIONS", "512")
    monkeypatch.setenv("EMBEDDING_TIMEOUT_SECONDS", "12.5")
    settings = Settings.from_environment()
    assert settings.qdrant_url == "http://qdrant:6333"
    assert settings.qdrant_api_key == "private-vector-key"
    assert settings.qdrant_timeout_seconds == 2.5
    assert settings.openai_embedding_model == "text-embedding-3-large"
    assert settings.openai_embedding_dimensions == 512
    assert settings.embedding_timeout_seconds == 12.5


@pytest.mark.parametrize("value", ["0", "-1", "1.5", "1537", "NaN", "invalid"])
def test_rejects_invalid_embedding_dimensions(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
    monkeypatch.setenv("OPENAI_EMBEDDING_DIMENSIONS", value)
    with pytest.raises(SettingsConfigurationError, match="OPENAI_EMBEDDING_DIMENSIONS"):
        Settings.from_environment()


def test_rejects_unknown_embedding_tokenization_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_EMBEDDING_MODEL", "unknown-model")
    with pytest.raises(SettingsConfigurationError, match="OPENAI_EMBEDDING_MODEL"):
        Settings.from_environment()


def test_ranking_has_independent_45_50_second_defaults(monkeypatch):
    monkeypatch.setenv("LLM_MODEL_TIMEOUT_SECONDS", "2")
    monkeypatch.setenv("LLM_RUN_TIMEOUT_SECONDS", "3")
    settings = Settings.from_environment()
    assert settings.llm_ranking_model_timeout_seconds == 45
    assert settings.llm_ranking_run_timeout_seconds == 50
    assert (settings.llm_model_timeout_seconds, settings.llm_run_timeout_seconds) == (2, 3)


def test_ranking_accepts_values_over_30_without_changing_other_agents(monkeypatch):
    monkeypatch.setenv("LLM_RANKING_MODEL_TIMEOUT_SECONDS", " 55.5 ")
    monkeypatch.setenv("LLM_RANKING_RUN_TIMEOUT_SECONDS", "60")
    settings = Settings.from_environment()
    assert settings.llm_ranking_model_timeout_seconds == 55.5
    assert settings.llm_ranking_run_timeout_seconds == 60


def test_combination_review_accepts_its_independent_timeout_budget(monkeypatch):
    monkeypatch.setenv("LLM_MODEL_TIMEOUT_SECONDS", "2")
    monkeypatch.setenv("LLM_RUN_TIMEOUT_SECONDS", "3")
    monkeypatch.setenv("LLM_COMBINATION_REVIEW_MODEL_TIMEOUT_SECONDS", " 75.5 ")
    monkeypatch.setenv("LLM_COMBINATION_REVIEW_RUN_TIMEOUT_SECONDS", "90")

    settings = Settings.from_environment()

    assert settings.llm_combination_review_model_timeout_seconds == 75.5
    assert settings.llm_combination_review_run_timeout_seconds == 90
    assert (settings.llm_model_timeout_seconds, settings.llm_run_timeout_seconds) == (2, 3)


@pytest.mark.parametrize("name", [
    "LLM_COMBINATION_REVIEW_MODEL_TIMEOUT_SECONDS",
    "LLM_COMBINATION_REVIEW_RUN_TIMEOUT_SECONDS",
])
@pytest.mark.parametrize("value", ["", "private-invalid-setting", "0", "-1", "nan", "inf", "-inf", "120.01"])
def test_invalid_combination_review_timeouts_fail_startup(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(SettingsConfigurationError, match=name) as captured:
        Settings.from_environment()
    assert "private-invalid-setting" not in str(captured.value)


@pytest.mark.parametrize("model,run", [(60, 60), (70, 60), (120, 120)])
def test_combination_review_model_deadline_must_be_less_than_run_deadline(monkeypatch, model, run):
    monkeypatch.setenv("LLM_COMBINATION_REVIEW_MODEL_TIMEOUT_SECONDS", str(model))
    monkeypatch.setenv("LLM_COMBINATION_REVIEW_RUN_TIMEOUT_SECONDS", str(run))
    with pytest.raises(SettingsConfigurationError, match="must be less than"):
        Settings.from_environment()


@pytest.mark.parametrize("name", ["LLM_RANKING_MODEL_TIMEOUT_SECONDS", "LLM_RANKING_RUN_TIMEOUT_SECONDS"])
@pytest.mark.parametrize("value", ["", "private-invalid-setting", "0", "-1", "nan", "inf", "-inf", "60.01"])
def test_invalid_ranking_timeouts_fail_startup_instead_of_silently_reverting(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(SettingsConfigurationError, match=name) as captured:
        Settings.from_environment()
    assert "private-invalid-setting" not in str(captured.value)


@pytest.mark.parametrize("model,run", [(45, 45), (50, 45), (60, 60)])
def test_ranking_model_deadline_must_be_less_than_run_deadline(monkeypatch, model, run):
    monkeypatch.setenv("LLM_RANKING_MODEL_TIMEOUT_SECONDS", str(model))
    monkeypatch.setenv("LLM_RANKING_RUN_TIMEOUT_SECONDS", str(run))
    with pytest.raises(SettingsConfigurationError, match="must be less than"):
        Settings.from_environment()


@pytest.mark.parametrize("value", [0, -1, float("inf"), float("nan"), 61, True])
def test_direct_settings_construction_also_rejects_invalid_ranking_timeout(value):
    with pytest.raises(SettingsConfigurationError):
        Settings(openai_api_key="test-key", openai_model="test-model", llm_model_timeout_seconds=25,
                 llm_run_timeout_seconds=30, llm_ranking_model_timeout_seconds=value)


@pytest.mark.parametrize("value", [0, -1, float("inf"), float("nan"), 121, True])
def test_direct_settings_construction_also_rejects_invalid_combination_review_timeout(value):
    with pytest.raises(SettingsConfigurationError):
        Settings(openai_api_key="test-key", openai_model="test-model", llm_model_timeout_seconds=25,
                 llm_run_timeout_seconds=30, llm_combination_review_model_timeout_seconds=value)
