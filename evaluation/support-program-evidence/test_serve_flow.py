import json
from pathlib import Path
from unittest.mock import AsyncMock

import httpx2
from fastapi.testclient import TestClient
import pytest

import evaluate
import serve_flow


@pytest.mark.parametrize("url", [
    "https://127.0.0.1:6333", "http://example.com:6333", "http://127.0.0.1",
    "http://user:secret@127.0.0.1:6333", "http://127.0.0.1:6333/path",
    "http://127.0.0.1:6333?key=secret", "http://127.0.0.1:6333#fragment",
])
def test_requires_explicit_local_qdrant(url):
    with pytest.raises(ValueError):
        serve_flow.require_loopback_url(url)


def test_requires_key_budget_and_new_output_dir(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ValueError):
        serve_flow.build_evaluation_app(tmp_path / "absent", "http://127.0.0.1:6333", 1)
    assert not (tmp_path / "absent").exists()
    monkeypatch.setenv("OPENAI_API_KEY", "fake-key")
    with pytest.raises(ValueError):
        serve_flow.build_evaluation_app(tmp_path / "absent", "http://127.0.0.1:6333", 21)
    with pytest.raises(FileExistsError):
        serve_flow.build_evaluation_app(tmp_path, "http://127.0.0.1:6333", 1)


@pytest.mark.parametrize("mode", ["success", "invalid-citation", "rate-limit"])
def test_real_app_with_mock_http_enforces_budget_and_records_only_safe_data(tmp_path, monkeypatch, mode):
    _, prepared, _ = evaluate.load_fixture(evaluate.HERE / "fixture.json")
    request = prepared[0][1]
    calls = []
    original_init = httpx2.AsyncClient.__init__
    original_write = Path.write_text

    def write_with_legacy_default(path, text, encoding=None, **kwargs):
        return original_write(path, text, encoding=encoding or "cp949", **kwargs)

    monkeypatch.setattr(Path, "write_text", write_with_legacy_default)

    def respond(http_request):
        assert str(http_request.url) == "https://api.openai.com/v1/responses"
        calls.append(json.loads(http_request.content))
        assert calls[-1]["store"] is False
        if mode == "rate-limit":
            return httpx2.Response(429, json={"error": {"message": "PRIVATE-ERROR-DETAIL"}})
        answer = {"answer": "서울 소프트웨어 개발업 법인이 대상입니다. 🔎", "answerStatus": "ANSWERED",
                  "citationChunkIndexes": [0 if mode == "success" else 4]}
        return httpx2.Response(200, json={
            "id": "resp_mock", "created_at": 0, "model": evaluate.DEFAULT_OPENAI_MODEL,
            "object": "response", "status": "completed", "error": None, "incomplete_details": None,
            "parallel_tool_calls": False, "tool_choice": "none", "tools": [],
            "output": [{"id": "msg_mock", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "annotations": [], "text": json.dumps(answer, ensure_ascii=False)}]}],
            "usage": {"input_tokens": 100, "output_tokens": 30, "total_tokens": 130},
        })

    def init_with_mock_transport(self, *args, **kwargs):
        kwargs["transport"] = httpx2.MockTransport(respond)
        original_init(self, *args, **kwargs)

    # Keep class identity: SDK/LangChain subclasses must still pass isinstance checks.
    monkeypatch.setattr(httpx2.AsyncClient, "__init__", init_with_mock_transport)
    monkeypatch.setenv("OPENAI_API_KEY", "fake-key-never-sent")
    # An ambient base URL must not redirect the key or fixture outside the official endpoint.
    monkeypatch.setenv("OPENAI_BASE_URL", "https://not-openai.invalid/v1")
    output = tmp_path / "run"
    app = serve_flow.build_evaluation_app(output, "http://127.0.0.1:1", 1)
    with TestClient(app) as client:
        assert client.get("/health").json()["calls"] == 0
        assert client.post("/internal/v1/support-program-rankings", json={}).status_code == 404
        first = client.post("/internal/v1/support-program-evidence/answers", json=request.model_dump(by_alias=True))
        assert first.status_code == (200 if mode == "success" else 503)
        second = client.post("/internal/v1/support-program-evidence/answers", json=request.model_dump(by_alias=True))
        assert second.status_code == 503
        assert client.get("/health").json()["stopped"]
    assert len(calls) == 1
    saved = (output / "api-capture.json").read_text(encoding="utf-8")
    assert "PRIVATE-ERROR-DETAIL" not in saved and "fake-key" not in saved
    trace = json.loads(saved)
    if mode == "success":
        assert "서울 소프트웨어 개발업 법인이 대상입니다. 🔎" in saved
    assert trace["calls"][0]["response"]["httpStatus"] == (429 if mode == "rate-limit" else 200)
    assert trace["stopped"]


def test_unexpected_service_error_stops_the_run_and_preserves_http_500(tmp_path, monkeypatch):
    _, prepared, _ = evaluate.load_fixture(evaluate.HERE / "fixture.json")
    original_init = httpx2.AsyncClient.__init__

    def forbidden(request):
        pytest.fail("a service error test must not invoke an external API")

    def init_with_mock_transport(self, *args, **kwargs):
        kwargs["transport"] = httpx2.MockTransport(forbidden)
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx2.AsyncClient, "__init__", init_with_mock_transport)
    monkeypatch.setenv("OPENAI_API_KEY", "offline-test-key")
    output = tmp_path / "run"
    app = serve_flow.build_evaluation_app(output, "http://127.0.0.1:1", 1)
    answer = AsyncMock(side_effect=RuntimeError("PRIVATE-UNEXPECTED-ERROR"))
    monkeypatch.setattr(app.state.container.support_program_evidence_answer_service, "answer", answer)

    with TestClient(app, raise_server_exceptions=False) as client:
        payload = prepared[0][1].model_dump(by_alias=True)
        first = client.post("/internal/v1/support-program-evidence/answers", json=payload)
        assert first.status_code == 500
        assert client.get("/health").json() == {"status": "ready", "calls": 0, "stopped": True}
        second = client.post("/internal/v1/support-program-evidence/answers", json=payload)
        assert second.status_code == 503

    answer.assert_awaited_once()
    saved = (output / "api-capture.json").read_text(encoding="utf-8")
    assert json.loads(saved)["stopped"] is True
    assert "PRIVATE-UNEXPECTED-ERROR" not in saved
