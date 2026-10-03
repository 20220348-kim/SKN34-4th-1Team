"""Read-only inspection of anonymous Google Forms responder HTML.

The responder page embeds every page of questions, with the entry numbers used by pre-filled links, in
`FB_PUBLIC_LOAD_DATA_`. The reader parses only that JSON and fails explicitly when its shape changes.
"""
from __future__ import annotations

import hashlib
import http.client
import ipaddress
import json
import re
import socket
import ssl
from urllib.parse import urljoin, urlsplit, urlunsplit

CONTRACT = "google-public-form-reader-v2"
PARSER_VERSION = "fb-public-load-data-v1"
MAX_HTML = 4 * 1024 * 1024
MAX_OUTPUT = 1024 * 1024
SPACE = re.compile(r"\s+")
INLINE_SPACE = re.compile(r"[^\S\n]+")
BLANK_LINES = re.compile(r"\n{3,}")
TRAILING_STAR = re.compile(r"\s*\*+$")
DOCS_PATH = re.compile(r"/forms/(?:u/[0-9]+/)?d/(?:e/)?[A-Za-z0-9_-]+/viewform/?")
SHORT_PATH = re.compile(r"/[A-Za-z0-9_-]+/?")
CLOSED_PATH = re.compile(r"/forms/(?:u/[0-9]+/)?d/(?:e/)?[A-Za-z0-9_-]+/closedform/?")
LOAD_DATA = re.compile(r"FB_PUBLIC_LOAD_DATA_\s*=\s*(\[.*?\]);\s*</script>", re.S)
# Google Forms item type numbers. Layout items carry no answer; the remaining unsupported types are kept as
# UNKNOWN questions so the user still sees them and answers them in Google Forms.
KINDS = {0: "SHORT_TEXT", 1: "LONG_TEXT", 2: "SINGLE_CHOICE", 3: "DROPDOWN", 4: "MULTI_CHOICE"}
LAYOUT = frozenset({6, 8, 11, 12})
UNSUPPORTED = {5: "SCALE", 7: "GRID", 9: "DATE", 10: "TIME", 13: "FILE_UPLOAD", 18: "RATING"}
MAX_TEXT = 5000
MAX_OPTIONS = 300


class FormReaderError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def normalize(value: str) -> str:
    return SPACE.sub(" ", value).strip()


def canonical_url(raw: str, *, final: bool = False) -> str:
    if not isinstance(raw, str) or len(raw) > 2048 or raw != raw.strip():
        raise FormReaderError("INVALID_URL")
    try:
        uri = urlsplit(raw)
        port = uri.port
    except ValueError as error:
        raise FormReaderError("INVALID_URL") from error
    host = (uri.hostname or "").lower()
    if uri.scheme != "https" or uri.username is not None or uri.password is not None or port is not None or uri.fragment:
        raise FormReaderError("INVALID_URL")
    if host == "docs.google.com":
        if not DOCS_PATH.fullmatch(uri.path):
            raise FormReaderError("INVALID_URL")
    elif host == "forms.gle" and not final:
        if not SHORT_PATH.fullmatch(uri.path):
            raise FormReaderError("INVALID_URL")
    else:
        raise FormReaderError("INVALID_URL")
    return urlunsplit(("https", host, uri.path, "", ""))


def public_addresses(host: str) -> list[str]:
    """Every resolved address must be public. IPv4 comes first because containers often have no IPv6 route."""
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
    except OSError as error:
        raise FormReaderError("SOURCE_UNAVAILABLE") from error
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise FormReaderError("INVALID_URL")
    return sorted(addresses, key=lambda address: (ipaddress.ip_address(address).version, address))


class PinnedConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, addresses: list[str]):
        super().__init__(host, timeout=10, context=ssl.create_default_context())
        self.addresses = addresses

    def connect(self):
        # Only the already-validated addresses are tried, in order, until one accepts the connection.
        error: OSError | None = None
        for address in self.addresses:
            try:
                raw = socket.create_connection((address, 443), timeout=5)
                break
            except OSError as failure:
                error = failure
        else:
            raise error or OSError("no address")
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def fetch_html(raw_url: str) -> tuple[str, str]:
    source_url = canonical_url(raw_url)
    current = source_url
    for redirect in range(4):
        uri = urlsplit(current)
        connection = PinnedConnection(uri.hostname or "", public_addresses(uri.hostname or ""))
        try:
            connection.request("GET", uri.path, headers={"Host": uri.hostname or "", "Accept": "text/html", "User-Agent": "GovBizPublicFormReader/1"})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                if redirect >= 3:
                    raise FormReaderError("REDIRECT_LIMIT")
                location = response.getheader("Location")
                if not location:
                    raise FormReaderError("SOURCE_UNAVAILABLE")
                target = urlsplit(urljoin(current, location))
                # Sign-in-only forms send anonymous readers to Google accounts; closed forms to /closedform.
                if target.scheme == "https" and (target.hostname or "").lower() == "accounts.google.com":
                    raise FormReaderError("LOGIN_REQUIRED")
                if target.scheme == "https" and (target.hostname or "").lower() == "docs.google.com" and CLOSED_PATH.fullmatch(target.path):
                    raise FormReaderError("CLOSED")
                current = canonical_url(urlunsplit(target))
                continue
            if response.status == 401:
                raise FormReaderError("LOGIN_REQUIRED")
            if response.status != 200:
                raise FormReaderError("SOURCE_UNAVAILABLE")
            if not (response.getheader("Content-Type") or "").lower().startswith("text/html"):
                raise FormReaderError("UNSUPPORTED")
            body = response.read(MAX_HTML + 1)
            if len(body) > MAX_HTML:
                raise FormReaderError("LIMIT_EXCEEDED")
            final_url = canonical_url(current, final=True)
            return final_url, body.decode("utf-8", "replace")
        except (OSError, ssl.SSLError, TimeoutError) as error:
            raise FormReaderError("SOURCE_UNAVAILABLE") from error
        finally:
            connection.close()
    raise FormReaderError("REDIRECT_LIMIT")


def bounded_text(value: object, *, required: bool, lines: bool = False) -> str:
    """Collapses whitespace. With `lines`, keeps single blank-line paragraph breaks so long consent text stays readable."""
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        raise FormReaderError("SOURCE_CHANGED")
    if lines:
        rows = value.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        text = BLANK_LINES.sub("\n\n", "\n".join(INLINE_SPACE.sub(" ", row).strip() for row in rows)).strip()
    else:
        text = normalize(value)
    if len(text) > MAX_TEXT:
        raise FormReaderError("LIMIT_EXCEEDED")
    return text


def parse_question(item: object, order: int) -> dict | None:
    if not isinstance(item, list) or len(item) < 4 or type(item[3]) is not int:
        raise FormReaderError("SOURCE_CHANGED")
    if item[3] in LAYOUT:
        return None  # A page break may end right after its type number.
    if len(item) < 5:
        raise FormReaderError("SOURCE_CHANGED")
    # An untitled question is still answerable, so it is shown with a neutral label instead of failing the form.
    # Owners often type their own trailing "*"; the required flag already says that.
    label = TRAILING_STAR.sub("", bounded_text(item[1], required=False, lines=True)) or "제목 없는 문항"
    description = bounded_text(item[2], required=False, lines=True)
    answers = item[4]
    if not isinstance(answers, list) or not answers or any(not isinstance(a, list) or len(a) < 3 for a in answers):
        raise FormReaderError("SOURCE_CHANGED")
    required = any(answer[2] == 1 for answer in answers)
    kind = KINDS.get(item[3], "UNKNOWN")
    entry_id, options, allows_other = None, [], False
    if kind != "UNKNOWN":
        if len(answers) != 1 or type(answers[0][0]) is not int or answers[0][0] <= 0:
            raise FormReaderError("SOURCE_CHANGED")
        entry_id = str(answers[0][0])
    if kind in ("SINGLE_CHOICE", "MULTI_CHOICE", "DROPDOWN"):
        for option in answers[0][1] or []:
            if not isinstance(option, list) or not option or not isinstance(option[0], str):
                raise FormReaderError("SOURCE_CHANGED")
            if len(option) > 4 and option[4] == 1:
                allows_other = True  # The free-text "other" choice has no fixed option text.
                continue
            # Pre-filled links match the option text exactly, including repeated spaces, so it is kept verbatim.
            if not option[0].strip() or len(option[0]) > 1000:
                raise FormReaderError("SOURCE_CHANGED")
            options.append(option[0])
        if not options or len(options) > MAX_OPTIONS or len(set(options)) != len(options):
            raise FormReaderError("LIMIT_EXCEEDED" if len(options) > MAX_OPTIONS else "SOURCE_CHANGED")
    identity = json.dumps([order, label, kind, options], ensure_ascii=False, separators=(",", ":"))
    return {"order": order, "controlId": f"gpub-v1:{order}:{hashlib.sha256(identity.encode()).hexdigest()[:16]}",
            "entryId": entry_id, "label": label, "description": description, "required": required, "kind": kind,
            "options": options, "allowsOther": allows_other, "supported": kind != "UNKNOWN",
            "unsupportedReason": None if kind != "UNKNOWN" else UNSUPPORTED.get(item[3], "UNRECOGNIZED_CONTROL")}


def parse_html(source_url: str, final_url: str, html: str) -> dict:
    match = LOAD_DATA.search(html)
    if not match:
        raise FormReaderError("SOURCE_CHANGED")
    try:
        data = json.loads(match.group(1))
        form = data[1]
        items = form[1] or []
        title = bounded_text(form[8] or data[3], required=True)
    except (ValueError, TypeError, IndexError, KeyError) as error:
        raise FormReaderError("PARSER_FAILED") from error
    if not title or len(title) > 1000 or not isinstance(items, list):
        raise FormReaderError("SOURCE_CHANGED")
    questions = []
    for item in items:
        question = parse_question(item, len(questions) + 1)
        if question is not None:
            questions.append(question)
    if not questions:
        # A form left with only its description (e.g. "budget exhausted") has nothing to answer.
        raise FormReaderError("NO_QUESTIONS")
    if len(questions) > 200:
        raise FormReaderError("LIMIT_EXCEEDED")
    if len({q["entryId"] for q in questions if q["entryId"]}) != len([q for q in questions if q["entryId"]]):
        raise FormReaderError("SOURCE_CHANGED")
    fingerprint_input = json.dumps([title, [(q["label"], q["required"], q["kind"], q["options"]) for q in questions]],
                                   ensure_ascii=False, separators=(",", ":"))
    result = {"contractVersion": CONTRACT, "parserVersion": PARSER_VERSION, "sourceUrl": source_url,
              "finalUrl": final_url, "formTitle": title,
              "semanticFingerprint": hashlib.sha256(fingerprint_input.encode()).hexdigest(), "questions": questions}
    if len(json.dumps(result, ensure_ascii=False).encode()) > MAX_OUTPUT:
        raise FormReaderError("LIMIT_EXCEEDED")
    return result


def inspect_public_google_form(url: str) -> dict:
    final_url, html = fetch_html(url)
    return parse_html(canonical_url(url), final_url, html)
