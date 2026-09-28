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
        asyncio.run(client.settle(0, None))
    assert calls == [("settle", {"sequence": 0, "usage": None})]
