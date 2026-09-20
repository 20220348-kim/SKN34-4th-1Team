import importlib.util
from io import BytesIO
from pathlib import Path

import httpx2
import pytest
from langchain_openai import ChatOpenAI
from openai import AsyncOpenAI

from app.application_preparation.agent import ApplicationPreparationAgent
from app.application_preparation.models import DiscoverFormsRequest, InterpretRequest
from app.application_preparation.service import ApplicationPreparationService


@pytest.mark.anyio
async def test_actual_compose_stub_through_langchain_and_service(monkeypatch):
    stub_path = Path(__file__).resolve().parents[4] / "infrastructure/stubs/openai/server.py"
    spec = importlib.util.spec_from_file_location("application_preparation_compose_stub", stub_path)
    stub = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stub)
    request = InterpretRequest.model_validate({
        "contractVersion": "application-preparation-interpret-v1",
        "preparationId": 1,
        "inputRevision": 1,
        "formVersionId": "verified-form-v1",
        "sectionKey": "company-overview",
        "serviceField": "TECHNICAL_SUPPORT",
        "userMessage": "업체명은 새봄테크입니다.",
        "currentFacts": [],
        "fieldOptions": [
            {"fieldKey": "company-name", "label": "업체명", "guidance": "공식 업체명", "required": True},
            {"fieldKey": "contact-person", "label": "담당자", "guidance": "담당자", "required": True},
        ],
    })

    def handle(http_request):
        handler = object.__new__(stub.Handler)
        handler.path = http_request.url.path
        handler.headers = {"Content-Length": str(len(http_request.content))}
        handler.rfile = BytesIO(http_request.content)
        responses = []
        monkeypatch.setattr(handler, "respond", lambda code, body: responses.append(httpx2.Response(code, json=body)))
        handler.do_POST()
        return responses[0]

    client = AsyncOpenAI(
        api_key="test-key",
        base_url="https://openai.test/v1/",
        max_retries=0,
        http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handle)),
    )
    agent = ApplicationPreparationAgent(
        model=ChatOpenAI(
            model="gpt-5.6-luna", api_key="test-key", use_responses_api=True,
            store=False, reasoning={"effort": "none"}, timeout=4, max_retries=0,
            root_async_client=client, async_client=client.chat.completions,
        ),
        run_timeout_seconds=5,
    )
    try:
        service = ApplicationPreparationService(agent, "gpt-5.6-luna")
        result = await service.interpret(request)
        discovery = await service.discover(DiscoverFormsRequest.model_validate({
            "contractVersion": "application-form-discovery-v1",
            "sourceCode": "BIZINFO",
            "sourceProgramId": "PBLN_1",
            "programTitle": "지원사업",
            "documents": [{
                "documentIndex": 0,
                "fileName": "사업계획서.hwpx",
                "format": "HWPX",
                "blocks": [{"blockId": "D0-B0", "locator": "HWPX paragraph 1", "text": "사업 개요를 작성합니다."}],
            }],
        }))
    finally:
        await client.close()
    assert result["suggestions"][0]["value"] == "새봄테크"
    assert result["missingFields"] == ["contact-person"]
    assert discovery["forms"][0]["sections"][0]["fields"][0]["evidenceQuote"] == "사업 개요"
