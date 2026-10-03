import json

import pytest

from app.application_preparation.public_google_form_reader import (
    FormReaderError, canonical_url, parse_html, public_addresses,
)
from app.application_preparation.online_form_mcp import OnlineFormMcpError, validate_result

URL = "https://docs.google.com/forms/d/e/abc_123/viewform"


def form_html(items: list, title: str = "신청 양식") -> str:
    """Responder HTML shaped like Google's: the questions live in FB_PUBLIC_LOAD_DATA_."""
    data = [None, ["설명", items, None, None, None, None, None, None, title], "/forms", "문서 제목"]
    return ("<html><head><title>" + title + "</title></head><body><script type='text/javascript' nonce='n'>"
            "var FB_PUBLIC_LOAD_DATA_ = " + json.dumps(data, ensure_ascii=False) + ";</script></body></html>")


def item(label, kind, answers, description=None):
    return [abs(hash(label)) % 10**9, label, description, kind, answers]


def choices(*texts, other=False):
    return [[text, None, None, None, 0] for text in texts] + ([["", None, None, None, 1]] if other else [])


QUESTIONS = [
    item("업체명", 0, [[101, None, 1]], "사업자등록증의 상호"),
    item("설명", 1, [[102, None, 0]]),
    [9, "안내 문구", "읽어 주세요", 6, None],
    item("지역", 2, [[103, choices("서울", "부산", other=True), 1]]),
    [10, None, None, 8],
    item("분야", 4, [[104, choices("AI  [특강]", "제조"), 0]]),
    item("업종", 3, [[105, choices("서비스"), 0]]),
    item("설립일", 9, [[106, None, 1]]),
]


def test_types_entries_options_and_every_page():
    first = parse_html(URL, URL, form_html(QUESTIONS))
    second = parse_html(URL, URL, form_html(QUESTIONS).replace("<body>", "<body><script nonce='random'>var noise = 123;</script>"))
    assert first == second
    questions = first["questions"]
    assert first["contractVersion"] == "google-public-form-reader-v2" and first["formTitle"] == "신청 양식"
    # 안내 문구(6)와 페이지 나눔(8)은 문항이 아니며, 페이지 뒤의 문항도 모두 읽는다.
    assert [q["kind"] for q in questions] == ["SHORT_TEXT", "LONG_TEXT", "SINGLE_CHOICE", "MULTI_CHOICE", "DROPDOWN", "UNKNOWN"]
    assert [q["entryId"] for q in questions] == ["101", "102", "103", "104", "105", None]
    assert [q["required"] for q in questions] == [True, False, True, False, False, True]
    assert questions[0]["description"] == "사업자등록증의 상호"
    assert questions[2]["options"] == ["서울", "부산"] and questions[2]["allowsOther"] is True
    # 미리 채운 링크는 선택지 문구가 정확히 같아야 체크되므로 공백을 줄이지 않는다.
    assert questions[3]["options"] == ["AI  [특강]", "제조"]
    assert questions[5]["supported"] is False and questions[5]["unsupportedReason"] == "DATE"
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


def test_prefers_ipv4_and_falls_back_to_the_next_validated_address(monkeypatch):
    from app.application_preparation import public_google_form_reader as reader
    monkeypatch.setattr("socket.getaddrinfo", lambda *args, **kwargs: [
        (10, 1, 6, "", ("2404:6800:400b:c005::64", 443, 0, 0)), (2, 1, 6, "", ("142.250.21.101", 443)), (2, 1, 6, "", ("142.250.21.100", 443))])
    assert public_addresses("docs.google.com") == ["142.250.21.100", "142.250.21.101", "2404:6800:400b:c005::64"]
    tried = []

    def connect(address, timeout):
        tried.append(address[0])
        raise OSError(101, "Network is unreachable")

    monkeypatch.setattr("socket.create_connection", connect)
    with pytest.raises(OSError):
        reader.PinnedConnection("docs.google.com", ["142.250.21.100", "2404:6800:400b:c005::64"]).connect()
    assert tried == ["142.250.21.100", "2404:6800:400b:c005::64"]


def test_rejects_private_dns(monkeypatch):
    monkeypatch.setattr("socket.getaddrinfo", lambda *args, **kwargs: [(2, 1, 6, "", ("127.0.0.1", 443))])
    with pytest.raises(FormReaderError, match="INVALID_URL"):
        public_addresses("docs.google.com")


def test_unknown_control_is_not_guessed():
    grid = item("만족도", 7, [[201, [["1"], ["2"]], 1], [202, [["1"], ["2"]], 1]])
    result = parse_html(URL, URL, form_html([grid]))
    question = result["questions"][0]
    assert question["kind"] == "UNKNOWN" and question["entryId"] is None and question["unsupportedReason"] == "GRID"


def test_labels_keep_paragraphs_and_drop_the_owners_trailing_star():
    consent = "개인정보 수집에 동의하시겠습니까?\r\n\r\n\r\n■ 수집 항목 ■\n  성명,   연락처  \n\n\n*"
    question = parse_html(URL, URL, form_html([item(consent, 2, [[1, choices("네", "아니요"), 1]], "  안내\n\n\n\n끝  ")]))["questions"][0]
    assert question["label"] == "개인정보 수집에 동의하시겠습니까?\n\n■ 수집 항목 ■\n성명, 연락처"
    assert question["description"] == "안내\n\n끝"


def test_untitled_question_keeps_a_neutral_label():
    assert parse_html(URL, URL, form_html([item(None, 0, [[1, None, 0]])]))["questions"][0]["label"] == "제목 없는 문항"


@pytest.mark.parametrize("body,code", [
    ("<html><title>Login</title></html>", "SOURCE_CHANGED"),
    (form_html([]), "NO_QUESTIONS"),
    (form_html([[10, None, None, 8]]), "NO_QUESTIONS"),
    (form_html([]).replace('["설명", []', '["설명", null'), "NO_QUESTIONS"),
    ("<script>var FB_PUBLIC_LOAD_DATA_ = [null, {];</script>", "PARSER_FAILED"),
    (form_html([item("업체명", 0, [[0, None, 1]])]), "SOURCE_CHANGED"),
    (form_html([item("업체명", 0, [[7, None, 1]]), item("대표자", 0, [[7, None, 1]])]), "SOURCE_CHANGED"),
    (form_html([item("지역", 2, [[3, [], 1]])]), "SOURCE_CHANGED"),
    (form_html([item("지역", 2, [[3, choices(*[str(n) for n in range(301)]), 1]])]), "LIMIT_EXCEEDED"),
])
def test_incomplete_or_changed_form_fails(body, code):
    with pytest.raises(FormReaderError, match=code):
        parse_html(URL, URL, body)


def test_rejects_duplicate_control_ids():
    result = parse_html(URL, URL, form_html([item("업체명", 0, [[1, None, 0]])]))
    result["questions"].append(dict(result["questions"][0], order=2))
    with pytest.raises(OnlineFormMcpError):
        validate_result(result)


@pytest.mark.parametrize("change", [{"entryId": None}, {"entryId": "12a"}, {"allowsOther": True}, {"description": None}])
def test_validate_rejects_missing_entry_or_inconsistent_fields(change):
    result = parse_html(URL, URL, form_html([item("업체명", 0, [[1, None, 0]])]))
    result["questions"][0].update(change)
    with pytest.raises(OnlineFormMcpError, match="SOURCE_CHANGED"):
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

@pytest.mark.parametrize("response,code", [
    (FakeResponse(401), "LOGIN_REQUIRED"),
    (FakeResponse(302, location="https://accounts.google.com/v3/signin/identifier?continue=x"), "LOGIN_REQUIRED"),
    (FakeResponse(302, location="/forms/d/e/abc_123/closedform"), "CLOSED"),
])
def test_fetch_reports_sign_in_only_and_closed_forms(monkeypatch, response, code):
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
        return parse_html(URL, URL, form_html(QUESTIONS))

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
        assert response.json()["questions"][0]["entryId"] == "101"
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
