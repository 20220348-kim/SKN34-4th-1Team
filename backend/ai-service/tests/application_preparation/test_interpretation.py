import asyncio
import json
import os
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from .model_fixture import make_model
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.application_preparation.agent import ApplicationPreparationAgent
from app.application_preparation.discovery_prompt import DISCOVERY_PROMPT_VERSION
from app.application_preparation.models import (
    DiscoverFormsRequest,
    FormDiscoverySelection,
    InterpretRequest,
    InterpretationSelection,
)
from app.application_preparation.prompt import PROMPT_VERSION
from app.application_preparation.service import ApplicationPreparationError, ApplicationPreparationService
from app.config import Settings
from app.main import create_app

FIXTURES = (
    Path(os.environ["GOVBIZ_TEST_APPLICATION_PREPARATION_CONTRACT_DIR"])
    if "GOVBIZ_TEST_APPLICATION_PREPARATION_CONTRACT_DIR" in os.environ
    else Path(__file__).resolve().parents[4] / "backend/core-service/src/test/resources/applicationpreparation"
)


def request_data():
    return {
        "contractVersion": "application-preparation-interpret-v1",
        "preparationId": 7,
        "inputRevision": 2,
        "formVersionId": "verified-form-v1",
        "sectionKey": "company-overview",
        "serviceField": "TECHNICAL_SUPPORT",
        "userMessage": "업체명은 새봄테크이고 담당자는 아직 미정입니다.",
        "currentFacts": [],
        "fieldOptions": [
            {"fieldKey": "company-name", "label": "업체명", "guidance": "공식 업체명", "required": True},
            {"fieldKey": "contact-person", "label": "담당자", "guidance": "담당자 이름과 역할", "required": True},
            {"fieldKey": "main-products", "label": "주요 생산품", "guidance": "핵심 제품", "required": True},
        ],
    }


def selection_data():
    return {
        "suggestions": [
            {"fieldKey": "company-name", "status": "PROVIDED", "value": "새봄테크", "evidenceQuote": "업체명은 새봄테크"},
            {"fieldKey": "contact-person", "status": "UNKNOWN", "value": None, "evidenceQuote": "담당자는 아직 미정"},
        ],
        "missingFields": ["main-products"],
        "nextQuestion": "현재 제공하는 주요 제품이나 서비스는 무엇인가요?",
    }


def discovery_request_data():
    return json.loads((FIXTURES / "discovery-contract-request.json").read_text(encoding="utf-8"))


def discovery_response_data():
    data = json.loads((FIXTURES / "discovery-contract-response.json").read_text(encoding="utf-8"))
    data["promptVersion"] = DISCOVERY_PROMPT_VERSION
    for form in data["forms"]:
        for section in form["sections"]:
            for field in section["fields"]:
                field.setdefault("options", [])
    return data


def discovery_selection_data():
    data = discovery_response_data()
    for name in ("contractVersion", "model", "promptVersion"):
        data.pop(name)
    section = data["forms"][0]["sections"][0]
    section["title"] = "  사업\n계획  "
    section["description"] = " 사업 개요와\r\n추진 방법을 작성합니다. "
    section["fields"][0]["label"] = " 사업\t개요 "
    section["fields"][0]["guidance"] = " 사업의 목적과\n주요 내용을 입력합니다. "
    section["fields"][0]["evidenceQuote"] = "사업 개요"
    return data


def make_service(data=None):
    model = make_model(data or selection_data())
    agent = ApplicationPreparationAgent(model=model, run_timeout_seconds=3)
    return ApplicationPreparationService(agent, "test-model"), model


def test_langchain_returns_validated_suggestions_without_confirming_them():
    service, model = make_service()
    result = asyncio.run(service.interpret(InterpretRequest.model_validate(request_data())))
    assert result["suggestions"] == selection_data()["suggestions"]
    assert result["inputRevision"] == 2
    assert result["promptVersion"] == PROMPT_VERSION
    assert len(model.calls) == 1


def test_langchain_discovers_only_fields_with_exact_document_evidence():
    model = make_model(discovery_selection_data())
    agent = ApplicationPreparationAgent(model=model, run_timeout_seconds=3)
    service = ApplicationPreparationService(agent, "test-model")
    result = asyncio.run(service.discover(DiscoverFormsRequest.model_validate(discovery_request_data())))
    assert result == discovery_response_data()
    assert result["promptVersion"] == DISCOVERY_PROMPT_VERSION
    assert result["forms"][0]["sections"][0]["fields"][0]["evidenceQuote"] == "사업\n개요"
    assert len(model.calls) == 1


@pytest.mark.parametrize(("source_code", "source_program_id", "file_format", "document_index"), [
    ("BIZINFO", "PBLN_123", "HWPX", 0),
    ("KSTARTUP", "177911", "HWP", 1),
    ("MSIT", "3186573", "PDF", 6),
    ("CNTRADE_NOTICE", "3862", "HWPX", 7),
])
def test_discovery_contract_accepts_every_supported_provider_and_document_format(
    source_code, source_program_id, file_format, document_index,
):
    data = discovery_request_data()
    data["sourceCode"] = source_code
    data["sourceProgramId"] = source_program_id
    data["documents"][0]["documentIndex"] = document_index
    data["documents"][0]["format"] = file_format
    data["documents"][0]["blocks"][0]["blockId"] = f"D{document_index}-B0"

    request = DiscoverFormsRequest.model_validate(data)

    assert request.sourceCode == source_code
    assert request.documents[0].format == file_format


@pytest.mark.parametrize(("source_code", "source_program_id"), [
    ("BIZINFO", "177911"),
    ("KSTARTUP", "PBLN_123"),
    ("MSIT", "0"),
    ("CNTRADE_NOTICE", "01"),
])
def test_discovery_contract_rejects_provider_mismatched_ids(source_code, source_program_id):
    data = discovery_request_data()
    data["sourceCode"] = source_code
    data["sourceProgramId"] = source_program_id
    with pytest.raises(ValidationError):
        DiscoverFormsRequest.model_validate(data)


def test_discovery_normalizes_display_text_and_whitespace_only_quote_differences():
    request_data = discovery_request_data()
    output = discovery_selection_data()
    section = output["forms"][0]["sections"][0]
    agent = SimpleNamespace(discovery_model_timeout_seconds=210.0, discovery_run_timeout_seconds=240.0, discover=AsyncMock(return_value=FormDiscoverySelection.model_validate(output)))

    result = asyncio.run(ApplicationPreparationService(agent, "test-model").discover(
        DiscoverFormsRequest.model_validate(request_data),
    ))

    normalized = result["forms"][0]["sections"][0]
    assert normalized["title"] == "사업 계획"
    assert normalized["description"] == "사업 개요와 추진 방법을 작성합니다."
    assert normalized["fields"][0]["label"] == "사업 개요"
    assert normalized["fields"][0]["guidance"] == "사업의 목적과 주요 내용을 입력합니다."
    assert normalized["fields"][0]["evidenceQuote"] == "사업\n개요"


def test_discovery_rejects_non_layout_control_or_format_characters_with_a_safe_path():
    output = discovery_selection_data()
    output["forms"][0]["sections"][0]["fields"][0]["guidance"] = "사업\u200b내용"
    agent = SimpleNamespace(discovery_model_timeout_seconds=210.0, discovery_run_timeout_seconds=240.0, discover=AsyncMock(return_value=FormDiscoverySelection.model_validate(output)))

    with pytest.raises(ApplicationPreparationError, match="APPLICATION_PREPARATION_FAILED") as failure:
        asyncio.run(ApplicationPreparationService(agent, "test-model").discover(
            DiscoverFormsRequest.model_validate(discovery_request_data()),
        ))

    cause = failure.value.__cause__
    assert cause.reason == "FORBIDDEN_DISPLAY_CHARACTER"
    assert cause.path == "forms[0].sections[0].fields[0].guidance"
    assert cause.code_point_count == 5
    assert cause.forbidden_character_count == 1


def test_discovery_merges_repeated_document_candidates_and_makes_generated_keys_unique():
    output = discovery_selection_data()
    duplicate = deepcopy(output["forms"][0])
    duplicate["sections"][0]["title"] = "두 번째 사업 계획"
    output["forms"].append(duplicate)
    agent = SimpleNamespace(discovery_model_timeout_seconds=210.0, discovery_run_timeout_seconds=240.0, discover=AsyncMock(return_value=FormDiscoverySelection.model_validate(output)))

    result = asyncio.run(ApplicationPreparationService(agent, "test-model").discover(
        DiscoverFormsRequest.model_validate(discovery_request_data()),
    ))

    forms = result["forms"]
    assert len(forms) == 1
    assert [section["sectionKey"] for section in forms[0]["sections"]] == ["business-plan", "business-plan-2"]


def test_discovery_recovers_a_verbatim_quote_from_the_grounded_field_label():
    output = discovery_selection_data()
    output["forms"][0]["sections"][0]["fields"][0]["evidenceQuote"] = "문서에 없는 항목"
    agent = SimpleNamespace(discovery_model_timeout_seconds=210.0, discovery_run_timeout_seconds=240.0, discover=AsyncMock(return_value=FormDiscoverySelection.model_validate(output)))

    result = asyncio.run(ApplicationPreparationService(agent, "test-model").discover(
        DiscoverFormsRequest.model_validate(discovery_request_data()),
    ))

    assert result["forms"][0]["sections"][0]["fields"][0]["evidenceQuote"] == "사업\n개요"


def test_discovery_recovers_the_original_punctuation_in_a_field_quote():
    request = discovery_request_data()
    output = discovery_selection_data()
    block = request["documents"][0]["blocks"][0]
    field = output["forms"][0]["sections"][0]["fields"][0]
    block["text"] += "\n사업명(국문)을 작성해 주세요."
    field.update(label="사업명(국문)", evidenceQuote="사업명【국문】")
    agent = SimpleNamespace(discovery_model_timeout_seconds=210.0, discovery_run_timeout_seconds=240.0, discover=AsyncMock(return_value=FormDiscoverySelection.model_validate(output)))

    result = asyncio.run(ApplicationPreparationService(agent, "test-model").discover(
        DiscoverFormsRequest.model_validate(request),
    ))

    assert result["forms"][0]["sections"][0]["fields"][0]["evidenceQuote"] == "사업명(국문)"


def test_discovery_still_rejects_a_field_without_any_source_anchor():
    output = discovery_selection_data()
    field = output["forms"][0]["sections"][0]["fields"][0]
    field.update(label="원문에 없는 문항", evidenceQuote="원문에 없는 근거")
    agent = SimpleNamespace(discovery_model_timeout_seconds=210.0, discovery_run_timeout_seconds=240.0, discover=AsyncMock(return_value=FormDiscoverySelection.model_validate(output)))
    with pytest.raises(ApplicationPreparationError, match="APPLICATION_PREPARATION_FAILED"):
        asyncio.run(ApplicationPreparationService(agent, "test-model").discover(
            DiscoverFormsRequest.model_validate(discovery_request_data()),
        ))


@pytest.mark.parametrize("change", [
    lambda data: data.update(contractVersion="unknown"),
    lambda data: data.update(userMessage=""),
    lambda data: data["currentFacts"].append({"fieldKey": "not-allowed", "status": "UNKNOWN", "value": None}),
    lambda data: data["fieldOptions"].append(deepcopy(data["fieldOptions"][0])),
])
def test_invalid_requests_are_rejected_before_the_agent(change):
    data = request_data()
    change(data)
    with pytest.raises(ValidationError):
        InterpretRequest.model_validate(data)


@pytest.mark.parametrize("change", [
    lambda data: data["suggestions"][0].update(fieldKey="invented-field"),
    lambda data: data["suggestions"][0].update(evidenceQuote="사용자가 말하지 않은 내용"),
    lambda data: data.update(missingFields=[]),
    lambda data: data.update(nextQuestion=None),
])
def test_invented_or_inconsistent_output_is_a_technical_failure(change):
    data = selection_data()
    change(data)
    agent = SimpleNamespace(interpret=AsyncMock(return_value=InterpretationSelection.model_validate(data)))
    with pytest.raises(ApplicationPreparationError, match="APPLICATION_PREPARATION_FAILED"):
        asyncio.run(ApplicationPreparationService(agent, "test-model").interpret(InterpretRequest.model_validate(request_data())))


def test_timeout_is_not_returned_as_an_empty_success():
    agent = SimpleNamespace(interpret=AsyncMock(side_effect=TimeoutError()))
    with pytest.raises(ApplicationPreparationError, match="APPLICATION_PREPARATION_TIMEOUT"):
        asyncio.run(ApplicationPreparationService(agent, "test-model").interpret(InterpretRequest.model_validate(request_data())))


def test_fastapi_contract_hides_private_failures():
    app = create_app(settings=Settings(openai_api_key="unused", openai_model="test-model", llm_model_timeout_seconds=2, llm_run_timeout_seconds=3))
    service, _ = make_service()
    app.state.container.application_preparation_service = service
    with TestClient(app) as client:
        assert client.get("/internal/v1/application-preparations/configuration").json() == service.configuration()
        assert client.get("/internal/v1/application-preparations/discovery/configuration").json() == service.discovery_configuration()
        response = client.post("/internal/v1/application-preparations/interpret", json=request_data())
        assert response.status_code == 200
        service.agent = SimpleNamespace(discovery_model_timeout_seconds=210.0, discovery_run_timeout_seconds=240.0, discover=AsyncMock(return_value=FormDiscoverySelection.model_validate(discovery_selection_data())))
        discovered = client.post("/internal/v1/application-preparations/discovery", json=discovery_request_data())
        assert discovered.status_code == 200
        assert discovered.json()["forms"][0]["documentIndex"] == 0
        service.agent = SimpleNamespace(interpret=AsyncMock(side_effect=RuntimeError("private failure")))
        failure = client.post("/internal/v1/application-preparations/interpret", json=request_data())
        assert failure.status_code == 503
        assert failure.json() == {"detail": {"code": "APPLICATION_PREPARATION_FAILED"}}
        assert "private failure" not in failure.text


def test_discovery_failure_log_keeps_only_safe_path_and_counts(caplog):
    output = discovery_selection_data()
    private_guidance = "민감한\u200b진단 원문"
    output["forms"][0]["sections"][0]["fields"][0]["guidance"] = private_guidance
    app = create_app(settings=Settings(
        openai_api_key="unused",
        openai_model="test-model",
        llm_model_timeout_seconds=2,
        llm_run_timeout_seconds=3,
    ))
    app.state.container.application_preparation_service = ApplicationPreparationService(
        SimpleNamespace(discovery_model_timeout_seconds=210.0, discovery_run_timeout_seconds=240.0, discover=AsyncMock(return_value=FormDiscoverySelection.model_validate(output))),
        "test-model",
    )
    caplog.set_level("WARNING", logger="app.application_preparation.router")

    with TestClient(app) as client:
        response = client.post("/internal/v1/application-preparations/discovery", json=discovery_request_data())

    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "APPLICATION_FORM_AI_INVALID_RESPONSE"}}
    assert "validation_reason=FORBIDDEN_DISPLAY_CHARACTER" in caplog.text
    assert "validation_path=forms[0].sections[0].fields[0].guidance" in caplog.text
    assert "code_point_count=9" in caplog.text
    assert "forbidden_character_count=1" in caplog.text
    assert "document_count=1" in caplog.text
    assert "block_count=1" in caplog.text
    assert private_guidance not in caplog.text
    assert discovery_request_data()["documents"][0]["blocks"][0]["text"] not in caplog.text


@pytest.mark.parametrize("error, expected_status", [(TimeoutError("lost response"), 504), (RuntimeError("execution unknown"), 503)])
def test_discovery_execution_errors_are_not_reported_as_confirmed_validation_failures(error, expected_status):
    app = create_app(settings=Settings(openai_api_key="unused", openai_model="test-model", llm_model_timeout_seconds=2, llm_run_timeout_seconds=3))
    app.state.container.application_preparation_service = ApplicationPreparationService(
        SimpleNamespace(discovery_model_timeout_seconds=210.0, discovery_run_timeout_seconds=240.0, discover=AsyncMock(side_effect=error)), "test-model",
    )
    with TestClient(app) as client:
        response = client.post("/internal/v1/application-preparations/discovery", json=discovery_request_data())
    assert response.status_code == expected_status
    assert response.json()["detail"]["code"] != "APPLICATION_FORM_AI_INVALID_RESPONSE"


def test_discovery_evidence_mismatch_returns_confirmed_validation_failure():
    output = discovery_selection_data()
    field = output["forms"][0]["sections"][0]["fields"][0]
    field.update(label="원문에 없는 문항", evidenceQuote="원문에 없는 근거")
    app = create_app(settings=Settings(openai_api_key="unused", openai_model="test-model", llm_model_timeout_seconds=2, llm_run_timeout_seconds=3))
    app.state.container.application_preparation_service = ApplicationPreparationService(
        SimpleNamespace(discovery_model_timeout_seconds=210.0, discovery_run_timeout_seconds=240.0, discover=AsyncMock(return_value=FormDiscoverySelection.model_validate(output))), "test-model",
    )
    with TestClient(app) as client:
        response = client.post("/internal/v1/application-preparations/discovery", json=discovery_request_data())
    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "APPLICATION_FORM_AI_INVALID_RESPONSE"}}


@pytest.mark.parametrize("options,valid", [(["기술", "생활"], True), (["기술", "임의 분야"], False), (["기술", "기술"], False)])
def test_discovery_choices_must_be_present_in_the_exact_field_quote(options, valid):
    from app.application_preparation.models import validate_discovery, FormDiscoveryValidationError
    request = discovery_request_data()
    output = discovery_selection_data()
    field = output["forms"][0]["sections"][0]["fields"][0]
    quote = "사업 개요 분야 (택1): 기술, 생활"
    block = next(block for block in request["documents"][0]["blocks"] if block["blockId"] == field["evidenceBlockId"])
    block["text"] += " " + quote
    field.update(options=options, evidenceQuote=quote)
    request = DiscoverFormsRequest.model_validate(request)
    output = FormDiscoverySelection.model_validate(output)
    if valid:
        validate_discovery(request, output)
        assert output.forms[0].sections[0].fields[0].options == options
    else:
        with pytest.raises(FormDiscoveryValidationError):
            validate_discovery(request, output)


def test_discovery_recovers_a_choice_quote_from_the_grounded_label_and_options():
    from app.application_preparation.models import validate_discovery
    request = discovery_request_data()
    output = discovery_selection_data()
    field = output["forms"][0]["sections"][0]["fields"][0]
    block = next(block for block in request["documents"][0]["blocks"] if block["blockId"] == field["evidenceBlockId"])
    block["text"] += "\n신청 유형: 신규 / 계속"
    field.update(
        label="신청 유형",
        options=["신규", "계속"],
        evidenceQuote="신청 유형은 신규 또는 계속 중 선택",
    )
    request = DiscoverFormsRequest.model_validate(request)
    output = FormDiscoverySelection.model_validate(output)

    validate_discovery(request, output)

    repaired = output.forms[0].sections[0].fields[0]
    assert repaired.evidenceQuote == "신청 유형: 신규 / 계속"
    assert repaired.options == ["신규", "계속"]
