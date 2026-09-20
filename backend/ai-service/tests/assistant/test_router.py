import asyncio
import json
import logging
import re

import pytest
from agents.testing import ModelStep, ScriptedModel, assistant_message
from fastapi.testclient import TestClient

from app.assistant.agent import AssistantAgent
from app.assistant.models import SCHEMA_VERSION
from app.config import Settings
from app.main import create_app


SETTINGS = Settings(openai_api_key="test-key-never-sent", openai_model="test-model",
                    llm_model_timeout_seconds=1, llm_run_timeout_seconds=2)
PATH = "/internal/v1/assistant/answers"


def test_http_to_service_to_agent_to_response(request_data, output_data):
    model = ScriptedModel([[assistant_message(json.dumps(output_data, ensure_ascii=False))]])
    agent = AssistantAgent(model=model, model_timeout_seconds=1, run_timeout_seconds=2)
    with TestClient(create_app(settings=SETTINGS, assistant_agent=agent)) as client:
        response = client.post(PATH, json=request_data)
    assert response.status_code == 200
    assert response.json() == {"schemaVersion": SCHEMA_VERSION, **output_data}
    assert len(model.calls) == 1
    # The model receives the request as-is: help entries, session and screen context included.
    assert json.loads(model.first_call.input[0]["content"]) == request_data


@pytest.mark.parametrize("mutation", [{"message": " "}, {"schemaVersion": "v0"}, {"helpEntries": []}, {"turns": []}])
def test_invalid_internal_request_keeps_existing_fastapi_422_policy(request_data, mutation):
    request_data.update(mutation)
    model = ScriptedModel([])
    agent = AssistantAgent(model=model, model_timeout_seconds=1, run_timeout_seconds=2)
    with TestClient(create_app(settings=SETTINGS, assistant_agent=agent)) as client:
        response = client.post(PATH, json=request_data)
    assert response.status_code == 422
    assert not model.calls


@pytest.mark.parametrize("kind", ["invalid_json", "unknown_citation", "help_without_citation"])
def test_invalid_upstream_output_returns_safe_503(request_data, output_data, kind, caplog):
    if kind == "unknown_citation":
        output_data["citations"] = ["private-fabricated-entry"]
    if kind == "help_without_citation":
        output_data["citations"] = []
    output = "private non-json output" if kind == "invalid_json" else json.dumps(output_data, ensure_ascii=False)
    model = ScriptedModel([[assistant_message(output)]])
    agent = AssistantAgent(model=model, model_timeout_seconds=1, run_timeout_seconds=2)
    with TestClient(create_app(settings=SETTINGS, assistant_agent=agent)) as client:
        response = client.post(PATH, json=request_data)
    assert response.status_code == 503
    assert response.json() == {"detail": "Assistant answer is temporarily unavailable."}
    assert "private" not in response.text
    assert len(model.calls) == 1
    records = [record for record in caplog.records if record.name.endswith("assistant.router")]
    assert len(records) == 1
    record = records[0]
    assert record.levelno == logging.WARNING
    assert record.exc_info is None
    assert re.fullmatch(r"assistant_answer_failed failure_kind=execution error_type=\w+ elapsed_ms=\d+", record.getMessage())
    assert request_data["message"] not in record.getMessage()


@pytest.mark.parametrize("deadline", ["model", "run"])
def test_deadline_returns_safe_504_without_retry(request_data, deadline, caplog):
    async def hang_forever(_):
        await asyncio.Event().wait()
        return []
    model = ScriptedModel([ModelStep.respond(hang_forever)])
    agent = AssistantAgent(model=model,
        model_timeout_seconds=0.01 if deadline == "model" else 1,
        run_timeout_seconds=1 if deadline == "model" else 0.01)
    with TestClient(create_app(settings=SETTINGS, assistant_agent=agent)) as client:
        response = client.post(PATH, json=request_data)
    assert response.status_code == 504
    assert response.json() == {"detail": "Assistant answer timed out."}
    assert len(model.calls) <= 1
    records = [record for record in caplog.records if record.name.endswith("assistant.router")]
    assert len(records) == 1
    cause = "ModelTimeoutError" if deadline == "model" else "TimeoutError"
    assert re.fullmatch(rf"assistant_answer_failed failure_kind=timeout error_type={cause} elapsed_ms=\d+", records[0].getMessage())
    assert records[0].exc_info is None


def test_agent_log_never_contains_message_or_answer_text(request_data, output_data, caplog):
    model = ScriptedModel([[assistant_message(json.dumps(output_data, ensure_ascii=False))]])
    agent = AssistantAgent(model=model, model_timeout_seconds=1, run_timeout_seconds=2)
    with caplog.at_level(logging.INFO, logger="app.assistant.agent"):
        with TestClient(create_app(settings=SETTINGS, assistant_agent=agent)) as client:
            assert client.post(PATH, json=request_data).status_code == 200
    records = [record for record in caplog.records if record.name.endswith("assistant.agent")]
    assert len(records) == 1
    message = records[0].getMessage()
    assert message.startswith("assistant_answer_run outcome=completed ")
    assert request_data["message"] not in message
    assert output_data["answer"] not in message
