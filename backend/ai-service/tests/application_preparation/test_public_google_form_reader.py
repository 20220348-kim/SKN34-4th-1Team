import pytest

from app.application_preparation.public_google_form_reader import (
    FormReaderError, canonical_url, parse_html, public_addresses,
)
from app.application_preparation.online_form_mcp import OnlineFormMcpError, validate_result

URL = "https://docs.google.com/forms/d/e/abc_123/viewform"


def html(items: str, extra: str = "") -> str:
    return f"<html><head><title>신청 양식</title></head><body><div role='list'>{items}</div>{extra}</body></html>"


def item(label: str, control: str) -> str:
    return f"<div role='listitem'><div role='heading' aria-level='3'>{label}</div>{control}</div>"


def test_semantic_types_required_options_and_stable_identity():
    body = html("".join([
        item("업체명", "<input type='text' required>"),
        item("설명", "<textarea aria-label='설명'></textarea>"),
        item("지역", "<div role='radiogroup' aria-required='true'><div role='radio' aria-label='서울'></div><div role='radio' aria-label='부산'></div></div>"),
        item("분야", "<div role='checkbox' aria-label='AI'></div><div role='checkbox' aria-label='제조'></div>"),
        item("업종", "<div role='listbox'><div role='option'>선택</div><div role='option' data-value='1'>서비스</div></div>"),
    ]) + "<div role='listitem'><div role='heading' aria-level='2'>추가 안내</div></div>")
    first = parse_html(URL, URL, body)
    second = parse_html(URL, URL, body.replace("<body>", "<body><script nonce='random'>var noise = 123;</script>"))
    assert first == second
    assert [q["kind"] for q in first["questions"]] == ["SHORT_TEXT", "LONG_TEXT", "SINGLE_CHOICE", "MULTI_CHOICE", "DROPDOWN"]
    assert [q["required"] for q in first["questions"]] == [True, False, True, False, False]
    assert first["questions"][2]["options"] == ["서울", "부산"]
    assert first["questions"][4]["options"] == ["서비스"]
    validate_result(first)


@pytest.mark.parametrize("url", [
    "http://docs.google.com/forms/d/e/a/viewform",
    "https://user@docs.google.com/forms/d/e/a/viewform",
    "https://docs.google.com:444/forms/d/e/a/viewform",
    "https://127.0.0.1/forms/d/e/a/viewform",
    "https://localhost/forms/d/e/a/viewform",
    "https://evil.example/forms/d/e/a/viewform",
    "https://docs.google.com/forms/d/e/a/edit",
])
def test_rejects_non_responder_urls(url):
    with pytest.raises(FormReaderError):
        canonical_url(url)


def test_removes_query_without_using_prefill_values():
    assert canonical_url(URL + "?entry.123=private") == URL


def test_rejects_private_dns(monkeypatch):
    monkeypatch.setattr("socket.getaddrinfo", lambda *args, **kwargs: [(2, 1, 6, "", ("127.0.0.1", 443))])
    with pytest.raises(FormReaderError, match="INVALID_URL"):
        public_addresses("docs.google.com")


def test_unknown_control_is_not_guessed():
    result = parse_html(URL, URL, html(item("날짜", "<div role='spinbutton'></div>")))
    assert result["questions"][0]["kind"] == "UNKNOWN"
    assert result["questions"][0]["supported"] is False


@pytest.mark.parametrize("body", [html(""), html(item("업체명", "<input type='text'>"), "<button>Next</button>"), "<html><title>Login</title></html>"])
def test_incomplete_or_unavailable_form_fails(body):
    with pytest.raises(FormReaderError):
        parse_html(URL, URL, body)


def test_rejects_duplicate_control_ids():
    result = parse_html(URL, URL, html(item("업체명", "<input type='text'>")))
    result["questions"].append(dict(result["questions"][0], order=2))
    with pytest.raises(OnlineFormMcpError):
        validate_result(result)

class FakeResponse:
    def __init__(self, status=200, content_type="text/html", location=None, body=b"<html><title>Form</title></html>"):
        self.status, self.content_type, self.location, self.body = status, content_type, location, body

    def getheader(self, name):
        return {"Content-Type": self.content_type, "Location": self.location}.get(name)

    def read(self, limit):
        return self.body[:limit]


def test_fetch_only_get_and_rejects_foreign_redirect(monkeypatch):
    from app.application_preparation import public_google_form_reader as reader
    calls = []

    class FakeConnection:
        def __init__(self, host, address):
            calls.append((host, address))

        def request(self, method, path, headers):
            calls.append((method, path, headers))

        def getresponse(self):
            return FakeResponse(302, location="https://evil.example/form")

        def close(self):
            pass

    monkeypatch.setattr(reader, "public_addresses", lambda host: ["8.8.8.8"])
    monkeypatch.setattr(reader, "PinnedConnection", FakeConnection)
    with pytest.raises(FormReaderError, match="INVALID_URL"):
        reader.fetch_html(URL)
    assert [call[0] for call in calls if call[0] == "GET"] == ["GET"]


@pytest.mark.parametrize("response,code", [
    (FakeResponse(404), "SOURCE_UNAVAILABLE"),
    (FakeResponse(429), "SOURCE_UNAVAILABLE"),
    (FakeResponse(503), "SOURCE_UNAVAILABLE"),
    (FakeResponse(200, "application/json"), "UNSUPPORTED"),
    (FakeResponse(200, body=b"x" * (4 * 1024 * 1024 + 1)), "LIMIT_EXCEEDED"),
])
def test_fetch_rejects_bad_http_responses(monkeypatch, response, code):
    from app.application_preparation import public_google_form_reader as reader

    class FakeConnection:
        def __init__(self, host, address):
            pass

        def request(self, method, path, headers):
            assert method == "GET"

        def getresponse(self):
            return response

        def close(self):
            pass

    monkeypatch.setattr(reader, "public_addresses", lambda host: ["8.8.8.8"])
    monkeypatch.setattr(reader, "PinnedConnection", FakeConnection)
    with pytest.raises(FormReaderError, match=code):
        reader.fetch_html(URL)

def test_internal_endpoint_auth_and_bounded_request(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.application_preparation.router import router
    from app.application_preparation import online_form_mcp
    import asyncio

    async def fake_inspect(url):
        assert url == URL
        return parse_html(URL, URL, html(item("업체명", "<input type='text'>")))

    monkeypatch.setattr(online_form_mcp, "inspect_via_mcp", fake_inspect)
    monkeypatch.setenv("DOCUMENT_INTERNAL_TOKEN", "t" * 32)
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        path = "/internal/v1/application-preparations/online-form/inspect"
        assert client.post(path, json={"url": URL}).status_code == 401
        assert client.post(path, json={"url": URL}, headers={"Authorization": "Bearer wrong"}).status_code == 401
        response = client.post(path, json={"url": URL}, headers={"Authorization": "Bearer " + "t" * 32})
        assert response.status_code == 200
        assert response.json()["questions"][0]["kind"] == "SHORT_TEXT"
        assert client.post(path, content=b"x" * 4097, headers={"Authorization": "Bearer " + "t" * 32}).status_code == 413

def test_redirect_limit_and_no_cookie_or_auth_headers(monkeypatch):
    from app.application_preparation import public_google_form_reader as reader
    headers_seen = []

    class FakeConnection:
        def __init__(self, host, address):
            pass

        def request(self, method, path, headers):
            assert method == "GET"
            headers_seen.append(headers)

        def getresponse(self):
            return FakeResponse(302, location=URL)

        def close(self):
            pass

    monkeypatch.setattr(reader, "public_addresses", lambda host: ["8.8.8.8"])
    monkeypatch.setattr(reader, "PinnedConnection", FakeConnection)
    with pytest.raises(FormReaderError, match="REDIRECT_LIMIT"):
        reader.fetch_html(URL)
    assert len(headers_seen) == 4
    assert all("Cookie" not in h and "Authorization" not in h for h in headers_seen)


def test_network_timeout_is_explicit(monkeypatch):
    from app.application_preparation import public_google_form_reader as reader

    class FakeConnection:
        def __init__(self, host, address):
            pass

        def request(self, method, path, headers):
            raise TimeoutError()

        def close(self):
            pass

    monkeypatch.setattr(reader, "public_addresses", lambda host: ["8.8.8.8"])
    monkeypatch.setattr(reader, "PinnedConnection", FakeConnection)
    with pytest.raises(FormReaderError, match="SOURCE_UNAVAILABLE"):
        reader.fetch_html(URL)

def test_stdio_mcp_preserves_fixed_validation_error():
    import asyncio
    from app.application_preparation.online_form_mcp import inspect_via_mcp
    with pytest.raises(OnlineFormMcpError, match="INVALID_URL"):
        asyncio.run(inspect_via_mcp("https://example.com/form"))

def test_mcp_child_environment_drops_application_secrets(monkeypatch):
    import asyncio
    from contextlib import asynccontextmanager
    from app.application_preparation import online_form_mcp

    monkeypatch.setenv("DOCUMENT_INTERNAL_TOKEN", "internal-secret")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-secret")
    monkeypatch.setenv("DATABASE_PASSWORD", "database-secret")
    monkeypatch.setenv("GOOGLE_REFRESH_TOKEN", "google-secret")
    observed = {}

    @asynccontextmanager
    async def inspect_parameters(parameters, errlog):
        observed.update(parameters.env)
        raise RuntimeError("stop before child start")
        yield

    monkeypatch.setattr(online_form_mcp, "stdio_client", inspect_parameters)
    with pytest.raises(OnlineFormMcpError, match="MCP_FAILED"):
        asyncio.run(online_form_mcp.inspect_via_mcp(URL))
    assert not {"DOCUMENT_INTERNAL_TOKEN", "OPENAI_API_KEY", "DATABASE_PASSWORD", "GOOGLE_REFRESH_TOKEN"} & observed.keys()
