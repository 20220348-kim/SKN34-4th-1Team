import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from .model_fixture import make_model
from fastapi.testclient import TestClient

from app.application_preparation.agent import ApplicationPreparationAgent
from app.application_preparation.document import DocumentPlacement, DocumentRequest, DocumentSelection, validate_document
from app.application_preparation.service import ApplicationPreparationService
from app.config import Settings
from app.main import create_app
from .test_interpretation import FIXTURES


def request_data():
    return json.loads((FIXTURES / "document-contract-request.json").read_text(encoding="utf-8"))


def selection_data():
    data = json.loads((FIXTURES / "document-contract-response.json").read_text(encoding="utf-8"))
    del data["contractVersion"]
    return data


def test_native_document_contract_and_agent_without_answer_rewriting():
    model = make_model(selection_data())
    agent = ApplicationPreparationAgent(model=model, run_timeout_seconds=3)
    result = asyncio.run(ApplicationPreparationService(agent, "test-model").place_document(DocumentRequest.model_validate(request_data())))
    assert result == json.loads((FIXTURES / "document-contract-response.json").read_text(encoding="utf-8"))
    assert len(model.calls) == 1


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "invented-fact", "invented-target", "coordinates-for-hwp"])
def test_rejects_incomplete_or_invalid_placements(mutation):
    data = selection_data()
    placement = data["placements"][0]
    if mutation == "missing":
        data["placements"] = []
    elif mutation == "duplicate":
        data["placements"].append(placement)
    elif mutation == "invented-fact":
        placement["factId"] = "invented"
    elif mutation == "invented-target":
        placement["targetId"] = "invented"
    else:
        placement["box"] = {"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2}
    with pytest.raises(ValueError):
        validate_document(DocumentRequest.model_validate(request_data()), DocumentSelection.model_validate(data))


def test_unmapped_fact_is_explicit_and_not_silently_dropped():
    output = DocumentSelection(placements=[], unmappedFactIds=["company:name"])
    validate_document(DocumentRequest.model_validate(request_data()), output)


@pytest.mark.parametrize("mutation", ["valid", "missing-cleanup", "invented-cleanup", "duplicate-cleanup", "black-label"])
def test_blue_examples_require_explicit_bounded_cleanup(mutation):
    request = request_data()
    target = request["targets"][0]
    target["text"] = "업체명: 예시 회사"
    target["exampleText"] = "예시 회사"
    output = selection_data()
    output["clearExampleTargetIds"] = [target["id"]]
    if mutation == "missing-cleanup":
        output["clearExampleTargetIds"] = []
    elif mutation == "invented-cleanup":
        output["clearExampleTargetIds"] = ["invented"]
    elif mutation == "duplicate-cleanup":
        output["clearExampleTargetIds"] *= 2
    elif mutation == "black-label":
        target["exampleText"] = ""
    if mutation == "valid":
        validate_document(DocumentRequest.model_validate(request), DocumentSelection.model_validate(output))
    else:
        with pytest.raises(ValueError):
            validate_document(DocumentRequest.model_validate(request), DocumentSelection.model_validate(output))


def test_agent_transmits_example_metadata_and_returns_cleanup_without_rewriting():
    request = request_data()
    request["targets"][0]["exampleText"] = "예시 회사"
    output = selection_data()
    output["clearExampleTargetIds"] = [request["targets"][0]["id"]]
    model = make_model(output)
    agent = ApplicationPreparationAgent(model=model, run_timeout_seconds=3)
    result = asyncio.run(ApplicationPreparationService(agent, "test-model").place_document(DocumentRequest.model_validate(request)))
    assert result["clearExampleTargetIds"] == output["clearExampleTargetIds"]
    assert result["placements"] == output["placements"]


def test_repairs_invalid_example_classification_without_repeating_placements():
    request = request_data()
    request["targets"][0]["exampleText"] = "예시 회사"
    invalid = selection_data()
    invalid["clearExampleTargetIds"] = ["invented-example"]
    classification = DocumentSelection(
        placements=[], unmappedFactIds=[], clearExampleTargetIds=[request["targets"][0]["id"]],
    )
    agent = SimpleNamespace(place_document=AsyncMock(side_effect=[DocumentSelection.model_validate(invalid), classification]))

    result = asyncio.run(ApplicationPreparationService(agent, "test-model").place_document(DocumentRequest.model_validate(request)))

    assert result["placements"] == selection_data()["placements"]
    assert result["clearExampleTargetIds"] == [request["targets"][0]["id"]]
    assert agent.place_document.await_count == 2
    assert agent.place_document.await_args_list[1].args[0].facts == []


@pytest.mark.parametrize("mutation", ["valid", "omitted", "overlap", "duplicate", "invented"])
def test_every_blue_paragraph_is_classified_including_unanswered_sections(mutation):
    request = request_data()
    request["targets"] += [
        {"id": "unanswered", "text": "차별화 전략 등에 대하여 작성", "context": "미응답 사업계획 칸", "exampleText": "차별화 전략 등에 대하여 작성"},
        {"id": "title", "text": "사업계획서", "context": "문서 제목", "exampleText": "사업계획서"},
    ]
    output = selection_data()
    output["clearExampleTargetIds"] = ["unanswered"]
    output["preserveExampleTargetIds"] = ["title"]
    if mutation == "omitted":
        output["clearExampleTargetIds"] = []
    elif mutation == "overlap":
        output["preserveExampleTargetIds"].append("unanswered")
    elif mutation == "duplicate":
        output["preserveExampleTargetIds"] *= 2
    elif mutation == "invented":
        output["preserveExampleTargetIds"].append("unknown")
    if mutation == "valid":
        validate_document(DocumentRequest.model_validate(request), DocumentSelection.model_validate(output))
    else:
        with pytest.raises(ValueError, match="EXAMPLE_CLASSIFICATION_COVERAGE"):
            validate_document(DocumentRequest.model_validate(request), DocumentSelection.model_validate(output))


def test_cleanup_only_request_when_core_already_placed_all_checkbox_answers():
    request = request_data()
    request["facts"] = []
    request["targets"][0]["exampleText"] = "구현 방법을 작성"
    output = DocumentSelection(placements=[], unmappedFactIds=[], clearExampleTargetIds=[request["targets"][0]["id"]])
    validate_document(DocumentRequest.model_validate(request), output)


@pytest.mark.parametrize("validation", [True, False])
def test_document_diagnostics_log_stage_and_fixed_reason_without_private_text(caplog, validation):
    output = DocumentSelection(placements=[], unmappedFactIds=[])
    agent = SimpleNamespace(place_document=AsyncMock(return_value=output, side_effect=None if validation else RuntimeError("private answer secret")))
    with pytest.raises(RuntimeError):
        asyncio.run(ApplicationPreparationService(agent, "test-model").place_document(DocumentRequest.model_validate(request_data())))
    assert ("stage=validation" if validation else "stage=model") in caplog.text
    assert ("reason=FACT_COVERAGE" if validation else "reason=NONE") in caplog.text
    assert "private answer secret" not in caplog.text
    assert "새봄" not in caplog.text


def test_rejects_combining_two_distinct_answers_in_one_native_cell():
    request = request_data()
    request["facts"].append({"id": "company:role", "label": "역할", "value": "기획"})
    output = selection_data()
    output["placements"].append({"factId": "company:role", "targetId": request["targets"][0]["id"], "box": None})
    with pytest.raises(ValueError, match="SHARED_ANSWER_TARGET"):
        validate_document(DocumentRequest.model_validate(request), DocumentSelection.model_validate(output))


def test_repairs_shared_native_target_once_and_revalidates_the_full_selection():
    request = request_data()
    request["facts"].append({"id": "company:role", "label": "역할", "value": "기획"})
    request["targets"].append({"id": "second-target", "text": "", "context": "역할 입력란", "exampleText": ""})
    rejected = DocumentSelection.model_validate(selection_data())
    rejected.placements.append(DocumentPlacement(factId="company:role", targetId=request["targets"][0]["id"], box=None))
    repaired_role = DocumentSelection.model_validate({
        "placements": [{"factId": "company:role", "targetId": "second-target", "box": None}], "unmappedFactIds": [],
    })
    agent = SimpleNamespace(place_document=AsyncMock(side_effect=[rejected, repaired_role]))

    result = asyncio.run(ApplicationPreparationService(agent, "test-model").place_document(DocumentRequest.model_validate(request)))

    assert result["placements"] == [selection_data()["placements"][0], repaired_role.placements[0].model_dump()]
    assert result["clearExampleTargetIds"] == []
    assert agent.place_document.await_count == 2
    role_request, excluded, rejected_repair = agent.place_document.await_args_list[1].args
    assert [fact.id for fact in role_request.facts] == ["company:role"]
    assert excluded == {request["targets"][0]["id"]}
    assert [placement.factId for placement in rejected_repair.placements] == ["company:role"]


def test_reuses_valid_repair_classification_without_an_extra_call():
    request = request_data()
    request["facts"].append({"id": "company:role", "label": "역할", "value": "기획"})
    request["targets"][0]["exampleText"] = "예시 회사"
    request["targets"].append({"id": "second-target", "text": "", "context": "역할 입력란", "exampleText": ""})
    rejected_data = selection_data()
    rejected_data["placements"].append({"factId": "company:role", "targetId": request["targets"][0]["id"], "box": None})
    rejected_data["clearExampleTargetIds"] = ["invented-example"]
    rejected = DocumentSelection.model_validate(rejected_data)
    repaired_role = DocumentSelection.model_validate({
        "placements": [{"factId": "company:role", "targetId": "second-target", "box": None}], "unmappedFactIds": [],
        "clearExampleTargetIds": [request["targets"][0]["id"]],
    })
    agent = SimpleNamespace(place_document=AsyncMock(side_effect=[rejected, repaired_role]))

    result = asyncio.run(ApplicationPreparationService(agent, "test-model").place_document(DocumentRequest.model_validate(request)))

    assert result["clearExampleTargetIds"] == [request["targets"][0]["id"]]
    assert agent.place_document.await_count == 2


def test_fails_explicitly_when_shared_target_repair_is_still_invalid():
    request = request_data()
    request["facts"].append({"id": "company:role", "label": "역할", "value": "기획"})
    rejected_data = selection_data()
    rejected_data["placements"].append({"factId": "company:role", "targetId": request["targets"][0]["id"], "box": None})
    rejected = DocumentSelection.model_validate(rejected_data)
    agent = SimpleNamespace(place_document=AsyncMock(return_value=rejected))

    with pytest.raises(RuntimeError, match="APPLICATION_PREPARATION_FAILED"):
        asyncio.run(ApplicationPreparationService(agent, "test-model").place_document(DocumentRequest.model_validate(request)))

    assert agent.place_document.await_count == 2


def test_rejects_a_repair_that_reuses_a_kept_target():
    request = request_data()
    request["facts"].append({"id": "company:role", "label": "역할", "value": "기획"})
    rejected_data = selection_data()
    rejected_data["placements"].append({"factId": "company:role", "targetId": request["targets"][0]["id"], "box": None})
    rejected = DocumentSelection.model_validate(rejected_data)
    reused = DocumentSelection.model_validate({
        "placements": [{"factId": "company:role", "targetId": request["targets"][0]["id"], "box": None}],
        "unmappedFactIds": [],
    })
    agent = SimpleNamespace(place_document=AsyncMock(side_effect=[rejected, reused]))

    with pytest.raises(RuntimeError, match="APPLICATION_PREPARATION_FAILED"):
        asyncio.run(ApplicationPreparationService(agent, "test-model").place_document(DocumentRequest.model_validate(request)))


@pytest.mark.parametrize(("failure", "status"), [(None, 200), (TimeoutError(), 504), (RuntimeError(), 503)])
def test_document_route_and_failure_status(failure, status):
    app = create_app(settings=Settings(openai_api_key="unused", openai_model="test-model", llm_model_timeout_seconds=2, llm_run_timeout_seconds=3))
    agent = SimpleNamespace(place_document=AsyncMock(return_value=DocumentSelection.model_validate(selection_data()), side_effect=failure))
    app.state.container.application_preparation_service = ApplicationPreparationService(agent, "test-model")
    with TestClient(app) as client:
        result = client.post("/internal/v1/application-preparations/document", json=request_data())
        assert result.status_code == status
    assert agent.place_document.call_count == 1
