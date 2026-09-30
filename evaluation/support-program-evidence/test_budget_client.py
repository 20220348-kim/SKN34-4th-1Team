import asyncio
import json
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from uuid import uuid4

import pytest

import budget_client


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("LLMOPS_BUDGET_TOKEN", "offline-test-budget-token-32-characters")
    monkeypatch.setenv("LLMOPS_OPS_API_URL", "http://ops-service:8000")
    return budget_client.BudgetClient(str(uuid4()), str(uuid4()), "a" * 64)


@pytest.mark.parametrize("url", ["https://attacker:secret@ops", "ftp://ops", "http://ops?x=1", "http://ops/path", "http://ops#x"])
def test_untrusted_budget_url_is_rejected(monkeypatch, client, url):
    monkeypatch.setenv("LLMOPS_OPS_API_URL", url)
    with pytest.raises(budget_client.BudgetUnavailable):
        budget_client.BudgetClient(str(uuid4()), str(uuid4()), "a" * 64)


def test_secret_is_required_and_redirects_are_not_followed(monkeypatch, client):
    monkeypatch.delenv("LLMOPS_BUDGET_TOKEN")
    with pytest.raises(budget_client.BudgetUnavailable):
        budget_client.BudgetClient(str(uuid4()), str(uuid4()), "a" * 64)
    assert budget_client.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other") is None


@pytest.mark.parametrize("outcome", ["success", "denied", "timeout", "invalid-json", "wrong-result"])
def test_http_contract_does_not_retry_or_expose_secrets(monkeypatch, client, outcome):
    calls = []
    class Response:
        status = 200
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def read(self, limit):
            assert limit == 8193
            return b"{" if outcome == "invalid-json" else json.dumps(
                {"accepted": False} if outcome == "wrong-result" else {"accepted": True}).encode()
    def send(request, timeout):
        calls.append(request)
        assert timeout == 3
        assert request.headers["Authorization"] == "Bearer " + client.token
        assert json.loads(request.data) == client.identity
        if outcome == "denied":
            raise HTTPError(request.full_url, 409, "private", {}, None)
        if outcome == "timeout":
            raise URLError("private")
        return Response()
    monkeypatch.setattr(budget_client, "build_opener", lambda *_: SimpleNamespace(open=send))
    if outcome == "success":
        client.claim()
    else:
        with pytest.raises(budget_client.BudgetUnavailable) as error:
            client.claim()
        assert client.token not in str(error.value) and "private" not in str(error.value)
    assert len(calls) == 1


def test_unknown_usage_is_recorded_but_never_allows_more_calls(monkeypatch, client):
    calls = []
    monkeypatch.setattr(client, "request", lambda action, **fields: calls.append((action, fields)))
    with pytest.raises(budget_client.BudgetUnavailable):
        asyncio.run(client.settle(0, None, operation_id="answer:TC01"))
    assert calls == [("settle", {"sequence": 0, "usage": None, "operation_id": "answer:TC01"})]


def test_approval_and_settlement_send_the_same_explicit_operation(monkeypatch, client):
    calls = []
    monkeypatch.setattr(client, "request", lambda action, **fields: calls.append((action, fields)))
    usage = {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30}
    asyncio.run(client.authorize(0, "test-model", 2000, operation_id="answer:TC01"))
    asyncio.run(client.settle(0, usage, operation_id="answer:TC01"))
    assert calls == [
        ("authorize", {"sequence": 0, "model": "test-model", "max_output_tokens": 2000,
                       "operation_id": "answer:TC01"}),
        ("settle", {"sequence": 0, "usage": usage, "operation_id": "answer:TC01"}),
    ]


def test_receipt_is_exclusive_signed_and_omits_response_content(client, tmp_path):
    import hashlib
    import hmac
    body = {"id": "resp_test", "status": "completed", "usage": {
        "input_tokens": 10, "output_tokens": 20, "total_tokens": 30,
    }, "output": [{"text": "private-answer"}], "secret": "private-key"}
    client.record_usage_receipt(tmp_path, 0, "test-model", 2000, 200, body)
    raw = (tmp_path / "usage-0.json").read_bytes()
    envelope = json.loads(raw)
    canonical = json.dumps(envelope["payload"], sort_keys=True, separators=(",", ":")).encode()
    assert hmac.compare_digest(envelope["signature"], hmac.new(
        client.token.encode(), b"govbiz-budget-usage-v1\n" + canonical, hashlib.sha256).hexdigest())
    assert envelope["payload"]["run_id"] == client.run_id
    assert b"private" not in raw and client.token.encode() not in raw
    with pytest.raises(budget_client.BudgetUnavailable):
        client.record_usage_receipt(tmp_path, 0, "test-model", 2000, 200, body)
    assert (tmp_path / "usage-0.json").read_bytes() == raw
    assert not list(tmp_path.glob("*.tmp"))


@pytest.mark.parametrize("change", [
    {"usage": None}, {"id": "bad"}, {"status": "in_progress"},
    {"usage": {"input_tokens": True, "output_tokens": 1, "total_tokens": 2}},
    {"usage": {"input_tokens": 0, "output_tokens": 2001, "total_tokens": 2001}},
])
def test_invalid_response_never_creates_usage_evidence(client, tmp_path, change):
    body = {"id": "resp_test", "status": "completed", "usage": {
        "input_tokens": 10, "output_tokens": 20, "total_tokens": 30,
    }, **change}
    client.record_usage_receipt(tmp_path, 0, "test-model", 2000, 200, body)
    assert not list(tmp_path.iterdir())


def test_receipt_write_failure_is_explicit_and_does_not_attempt_settlement(client, tmp_path, monkeypatch):
    from unittest.mock import Mock
    request = Mock()
    monkeypatch.setattr(client, "request", request)
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr(budget_client.os, "fsync", fail)
    with pytest.raises(budget_client.BudgetUnavailable, match="preserved"):
        client.record_usage_receipt(tmp_path, 0, "test-model", 2000, 200, {
            "id": "resp_test", "status": "completed", "usage": {
                "input_tokens": 10, "output_tokens": 20, "total_tokens": 30,
            },
        })
    request.assert_not_called()
    assert not list(tmp_path.iterdir())
