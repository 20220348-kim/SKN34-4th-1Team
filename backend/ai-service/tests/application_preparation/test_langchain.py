import asyncio
import json

import pytest
from openai import InternalServerError

from app.application_preparation.agent import ApplicationPreparationAgent
from app.application_preparation.models import DraftRequest, DiscoverFormsRequest, InterpretRequest
from app.application_preparation.document import DocumentRequest
from .model_fixture import make_model
from .test_interpretation import request_data, selection_data, discovery_request_data, discovery_selection_data
from .test_draft import request_data as draft_request
from .test_document import request_data as document_request, selection_data as document_selection


def test_hwp_discovery_keeps_successful_prompt_separate_from_hwpx_columns(monkeypatch):
    from unittest.mock import AsyncMock
    from app.application_preparation.discovery_prompt import HWP_DISCOVERY_INSTRUCTIONS, DISCOVERY_INSTRUCTIONS
    request = DiscoverFormsRequest.model_validate(discovery_request_data())
    for document in request.documents:
        document.format = "HWP"
    agent = ApplicationPreparationAgent(model=None, run_timeout_seconds=1)
    invoke = AsyncMock()
    monkeypatch.setattr(agent, "_invoke", invoke)
    asyncio.run(agent.discover(request))
    assert invoke.await_args.args[1] == HWP_DISCOVERY_INSTRUCTIONS
    assert invoke.await_args.args[3] == 5000
    request.documents[0].format = "HWPX"
    asyncio.run(agent.discover(request))
    assert invoke.await_args.args[1] == DISCOVERY_INSTRUCTIONS
    assert invoke.await_args.args[3] == 16000


def test_discovery_receives_native_layout_but_never_sends_source_base64_to_model(monkeypatch):
    import base64
    import hashlib
    from unittest.mock import AsyncMock
    from app.application_preparation.service import ApplicationPreparationService
    from app.application_preparation.models import FormDiscoverySelection
    payload = discovery_request_data()
    source = b"PK native source only inside the service"
    payload["documents"][0].update(sourceBase64=base64.b64encode(source).decode(),
                                  sourceSha256=hashlib.sha256(source).hexdigest())
    request = DiscoverFormsRequest.model_validate(payload)
    layout = {0: [{"targetId": "t1.r1.c0", "text": "", "structure": {"row": 1, "col": 0}}]}
    prepare = AsyncMock(return_value=layout)
    monkeypatch.setattr("app.application_preparation.hwpx_form_analysis.discovery_layouts", prepare)
    async def invoke(_schema, _prompt, content, *_args, **_kwargs):
        document = json.loads(content)["documents"][0]
        assert document["nativeLayout"] == layout[0]
        assert "sourceBase64" not in document and "sourceSha256" not in document
        assert base64.b64encode(source).decode() not in content
        return FormDiscoverySelection.model_validate(discovery_selection_data())
    agent = ApplicationPreparationAgent(model=None, run_timeout_seconds=1)
    monkeypatch.setattr(agent, "_invoke", invoke)
    asyncio.run(ApplicationPreparationService(agent, "test-model").discover(request))
    prepare.assert_awaited_once_with(request)


def test_native_discovery_source_requires_matching_hash_and_hwpx_format():
    import base64
    from pydantic import ValidationError
    payload = discovery_request_data()
    payload["documents"][0].update(sourceBase64=base64.b64encode(b"PK test").decode(), sourceSha256="0" * 64)
    with pytest.raises(ValidationError, match="hash mismatch"):
        DiscoverFormsRequest.model_validate(payload)


def test_hwpx_mapping_has_one_assignment_and_one_scope_decision_per_native_target():
    import base64
    from app.application_preparation.document_contract import DocumentMap, MapDocumentRequest, NativeTarget, digest
    source = b"PK test source"
    request = MapDocumentRequest(sourceBase64=base64.b64encode(source).decode(), sourceSha256=digest(source),
        format="hwpx", scope="신청서", fields=[
            {"id": "company:name", "label": "회사명", "guidance": "", "required": True},
            {"id": "company:seal", "label": "날인", "guidance": "", "required": False}])
    document = DocumentMap(sourceSha256=request.sourceSha256, format="hwpx", engineVersion="test",
        targets=[NativeTarget(targetId=key, nativeLocator={}, kind="paragraph", currentText="")
                 for key in ("p1", "p2", "p3")])
    model = make_model({"assignments": {"company:name": {"targetId": "p1"}, "company:seal": {"targetId": None}},
                        "scope": {"p1": True, "p2": False, "p3": True}})
    result = asyncio.run(ApplicationPreparationAgent(model=model, run_timeout_seconds=3).map_document(request, document))
    assert [(b.factId, b.targetId) for b in result.bindings] == [("company:name", "p1")]
    assert result.unmappedFieldIds == ["company:seal"]
    assert result.scopeTargetIds == ["p1", "p3"]
    schema = json.loads(model.calls[0].content)["text"]["format"]["schema"]
    scope = schema["$defs"]["NativeScope"]
    assert set(scope["required"]) == {"p1", "p2", "p3"}
    assert all(item["type"] == "boolean" for item in scope["properties"].values())
    assert scope["additionalProperties"] is False


CASES = [
    ("interpret", InterpretRequest, request_data, selection_data, 2500),
    ("discover", DiscoverFormsRequest, discovery_request_data, discovery_selection_data, 16000),
    ("draft", DraftRequest, draft_request,
     lambda: {"content": "새봄테크", "usedFieldKeys": ["company-name"]}, 5000),
    ("place_document", DocumentRequest, document_request, document_selection, 10000),
]


@pytest.mark.parametrize("method,request_type,request_factory,selection_factory,tokens", CASES)
def test_responses_contract_and_limits(method, request_type, request_factory, selection_factory, tokens):
    model = make_model(selection_factory())
    agent = ApplicationPreparationAgent(model=model, run_timeout_seconds=3)
    asyncio.run(getattr(agent, method)(request_type.model_validate(request_factory())))
    assert len(model.calls) == 1
    call = model.calls[0]
    body = json.loads(call.content)
    assert call.url.path == "/v1/responses"
    assert call.extensions["timeout"]["read"] == (210 if method == "discover" else 2)
    assert body["max_output_tokens"] == tokens
    assert body["store"] is False
    assert body["reasoning"] == {"effort": "none"}
    assert not body.get("tools")
    assert body["text"]["format"]["strict"] is True


@pytest.mark.parametrize("method,request_type,request_factory,selection_factory,tokens", CASES)
@pytest.mark.parametrize("failure", ["incomplete", "invalid", "refusal", "http", "transport_timeout", "deadline"])
def test_model_failure_is_not_a_success(method, request_type, request_factory, selection_factory, tokens, failure):
    options = {
        "incomplete": {"status": "incomplete"},
        "invalid": {"content": [{"type": "output_text", "text": "{", "annotations": []}]},
        "refusal": {"content": [{"type": "refusal", "refusal": "cannot comply"}]},
        "http": {"http_status": 500},
        "transport_timeout": {"transport_timeout": True},
        "deadline": {"delay": 1},
    }[failure]
    model = make_model(selection_factory(), **options)
    agent = ApplicationPreparationAgent(model=model, run_timeout_seconds=0.3 if failure == "deadline" else 3,
        discovery_model_timeout_seconds=0.1, discovery_run_timeout_seconds=0.3 if failure == "deadline" else 3)
    expected_error = (TimeoutError if failure in ("transport_timeout", "deadline")
                      else InternalServerError if failure == "http" else ValueError)
    with pytest.raises(expected_error):
        asyncio.run(getattr(agent, method)(request_type.model_validate(request_factory())))
    assert len(model.calls) == 1


def test_document_images_and_repair_are_preserved():
    data = document_request()
    data["pageImages"] = ["iVBORw0KGgo="]
    data["targets"][0]["id"] = "page-0"
    request = DocumentRequest.model_validate(data)
    model = make_model(document_selection())
    agent = ApplicationPreparationAgent(model=model, run_timeout_seconds=3)
    asyncio.run(agent.place_document(request, excluded_target_ids={"excluded"}))
    body = json.loads(model.calls[0].content)
    content = next(item["content"] for item in body["input"] if item["role"] == "user")
    image = next(item for item in content if item["type"] == "input_image")
    assert image["image_url"] == "data:image/png;base64,iVBORw0KGgo="
    assert image["detail"] == "high"
    texts = [json.loads(item["text"]) for item in content if item["type"] == "input_text"]
    assert "pageImages" not in texts[0]
    assert texts[1]["repair"]["excludedPlacementTargetIds"] == ["excluded"]


@pytest.mark.parametrize("options,stage", [({"transport_timeout": True}, "AI_MODEL"), ({"delay": 1}, "AI_RUN")])
def test_discovery_timeout_stage_and_separate_deadlines(options, stage):
    from app.application_preparation.agent import ApplicationFormDiscoveryTimeoutError
    model = make_model(discovery_selection_data(), **options)
    agent = ApplicationPreparationAgent(model=model, run_timeout_seconds=0.01,
        discovery_model_timeout_seconds=0.1, discovery_run_timeout_seconds=0.2)
    with pytest.raises(ApplicationFormDiscoveryTimeoutError) as caught:
        asyncio.run(agent.discover(DiscoverFormsRequest.model_validate(discovery_request_data())))
    assert caught.value.stage == stage
    assert agent._run_timeout_seconds == 0.01
    assert model.request_timeout == 2


def test_discovery_timeout_settings_do_not_change_global_defaults(monkeypatch):
    from app.config import Settings, SettingsConfigurationError
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.setenv("APPLICATION_FORM_DISCOVERY_MODEL_TIMEOUT_SECONDS", "210")
    monkeypatch.setenv("APPLICATION_FORM_DISCOVERY_RUN_TIMEOUT_SECONDS", "240")
    settings = Settings.from_environment()
    assert settings.application_form_discovery_model_timeout_seconds == 210
    assert settings.application_form_discovery_run_timeout_seconds == 240
    monkeypatch.setenv("APPLICATION_FORM_DISCOVERY_RUN_TIMEOUT_SECONDS", "200")
    with pytest.raises(SettingsConfigurationError):
        Settings.from_environment()


@pytest.mark.parametrize("method", ["map_document", "plan_document"])
@pytest.mark.parametrize("failure", [None, "transport_timeout", "deadline"])
def test_document_analysis_uses_long_budget_and_preserves_timeout_reason(method, failure):
    import base64
    from app.application_preparation.document_contract import (
        DocumentError, DocumentMap, MapDocumentRequest, GenerateDocumentRequest, NativeTarget, digest,
    )
    source = b"test document bytes"
    req = GenerateDocumentRequest(sourceBase64=base64.b64encode(source).decode(), sourceSha256=digest(source),
        format="hwpx", answerRevision=1, scope="신청서", facts=[{"id": "company:name", "label": "회사명", "value": "가상기업"}])
    selection = {"operations": [], "scopeTargetIds": [], "unresolvedTargets": []}
    if method == "map_document":
        req = MapDocumentRequest(**req.model_dump(exclude={"facts", "answerRevision"}),
            fields=[{"id": "company:name", "label": "회사명", "guidance": "", "required": True}])
        selection = {"assignments": {"company:name": {"targetId": None}}, "scope": {"p1": False}}
    options = {"transport_timeout": True} if failure == "transport_timeout" else {"delay": 0.1}
    model = make_model(selection, **options)
    agent = ApplicationPreparationAgent(model=model, run_timeout_seconds=0.01,
        discovery_model_timeout_seconds=0.02 if failure == "deadline" else 210,
        discovery_run_timeout_seconds=0.03 if failure == "deadline" else 240)
    document = DocumentMap(sourceSha256=req.sourceSha256, format="hwpx", engineVersion="test",
        targets=[NativeTarget(targetId="p1", nativeLocator={}, kind="paragraph", currentText="")])
    if failure:
        with pytest.raises(DocumentError) as error:
            asyncio.run(getattr(agent, method)(req, document))
        assert error.value.code == "APPLICATION_DOCUMENT_PLAN_TIMEOUT"
        assert error.value.reason == ("AI_MODEL_TIMEOUT" if failure == "transport_timeout" else "AI_RUN_TIMEOUT")
    else:
        asyncio.run(getattr(agent, method)(req, document))
        assert model.calls[0].extensions["timeout"]["read"] == 210
    assert agent._run_timeout_seconds == 0.01
    assert model.request_timeout == 2
