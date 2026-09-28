"""Read-only inspection of anonymous Google Forms responder HTML."""
from __future__ import annotations

import hashlib
from html.parser import HTMLParser
import http.client
import ipaddress
import json
import re
import socket
import ssl
from urllib.parse import urljoin, urlsplit, urlunsplit

CONTRACT = "google-public-form-reader-v1"
PARSER_VERSION = "semantic-dom-v1"
MAX_HTML = 4 * 1024 * 1024
MAX_OUTPUT = 1024 * 1024
SPACE = re.compile(r"\s+")
DOCS_PATH = re.compile(r"/forms/(?:u/[0-9]+/)?d/(?:e/)?[A-Za-z0-9_-]+/viewform/?")
SHORT_PATH = re.compile(r"/[A-Za-z0-9_-]+/?")


class FormReaderError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class Node:
    def __init__(self, tag: str, attrs: dict[str, str], parent: Node | None = None):
        self.tag, self.attrs, self.parent = tag, attrs, parent
        self.children: list[Node | str] = []

    def descendants(self):
        for child in self.children:
            if isinstance(child, Node):
                yield child
                yield from child.descendants()

    def text(self) -> str:
        return normalize(" ".join(child if isinstance(child, str) else child.text() for child in self.children))

    def find(self, *, role: str | None = None, tag: str | None = None) -> list[Node]:
        return [node for node in self.descendants() if (role is None or node.attrs.get("role") == role)
                and (tag is None or node.tag == tag)]


class Tree(HTMLParser):
    VOID = frozenset({"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"})

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root", {})
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs), self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.stack.pop()

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data):
        if not any(node.tag in ("script", "style") for node in self.stack):
            self.stack[-1].children.append(data)


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
    try:
        addresses = sorted({item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
    except OSError as error:
        raise FormReaderError("SOURCE_UNAVAILABLE") from error
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise FormReaderError("INVALID_URL")
    return addresses


class PinnedConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, address: str):
        super().__init__(host, timeout=10, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        raw = socket.create_connection((self.address, 443), timeout=5)
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
        address = public_addresses(uri.hostname or "")[-1]
        connection = PinnedConnection(uri.hostname or "", address)
        try:
            connection.request("GET", uri.path, headers={"Host": uri.hostname or "", "Accept": "text/html", "User-Agent": "GovBizPublicFormReader/1"})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                if redirect >= 3:
                    raise FormReaderError("REDIRECT_LIMIT")
                location = response.getheader("Location")
                if not location:
                    raise FormReaderError("SOURCE_UNAVAILABLE")
                current = canonical_url(urljoin(current, location))
                continue
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


def parse_html(source_url: str, final_url: str, html: str) -> dict:
    tree = Tree()
    try:
        tree.feed(html)
        tree.close()
    except (ValueError, AssertionError) as error:
        raise FormReaderError("PARSER_FAILED") from error
    titles = tree.root.find(tag="title")
    title = titles[0].text() if titles else ""
    if not title or len(title) > 1000:
        raise FormReaderError("SOURCE_CHANGED")
    # Only the first, complete responder page is in scope. A visible Next control means later questions are missing.
    buttons = [n.text().lower() for n in tree.root.find(tag="button")]
    if any(text in ("next", "다음", "suivant", "siguiente") for text in buttons):
        raise FormReaderError("UNSUPPORTED")
    items = [n for n in tree.root.find(role="listitem") if n.find(role="heading")]
    if len([n for n in tree.root.find(role="heading") if n.attrs.get("aria-level") == "3"]) != len([n for n in items if n.find(role="heading")[0].attrs.get("aria-level") == "3"]):
        raise FormReaderError("SOURCE_CHANGED")
    questions = []
    for item in items:
        headings = item.find(role="heading")
        if len(headings) != 1:
            raise FormReaderError("SOURCE_CHANGED")
        heading = headings[0]
        if heading.attrs.get("aria-level") != "3":
            continue  # Section heading, not a question.
        label = heading.text()
        if label.endswith("*"):
            label = label[:-1].rstrip()
        if not label or len(label) > 1000:
            raise FormReaderError("SOURCE_CHANGED")
        radios = item.find(role="radio")
        checks = item.find(role="checkbox")
        boxes = item.find(role="listbox")
        textareas = item.find(tag="textarea")
        inputs = [n for n in item.find(tag="input") if n.attrs.get("type") in ("text", "email", "number")]
        kinds = [bool(radios), bool(checks), bool(boxes), bool(textareas), bool(inputs)]
        if sum(kinds) > 1:
            raise FormReaderError("SOURCE_CHANGED")
        if radios:
            kind, controls = "SINGLE_CHOICE", radios
        elif checks:
            kind, controls = "MULTI_CHOICE", checks
        elif boxes:
            kind, controls = "DROPDOWN", [n for n in boxes[0].find(role="option") if n.attrs.get("data-value") is not None]
        elif textareas:
            kind, controls = "LONG_TEXT", textareas
        elif inputs:
            kind, controls = "SHORT_TEXT", inputs
        else:
            kind, controls = "UNKNOWN", []
        options = []
        if kind in ("SINGLE_CHOICE", "MULTI_CHOICE", "DROPDOWN"):
            for control in controls:
                option = normalize(control.attrs.get("aria-label") or control.text() or (control.parent.text() if control.parent else ""))
                if not option or len(option) > 1000:
                    raise FormReaderError("SOURCE_CHANGED")
                options.append(option)
            if not options or len(options) > 100:
                raise FormReaderError("LIMIT_EXCEEDED")
        required = any(n.attrs.get("aria-required") == "true" or "required" in n.attrs for n in [*item.descendants()])
        order = len(questions) + 1
        identity = json.dumps([order, label, kind, options], ensure_ascii=False, separators=(",", ":"))
        control_id = f"gpub-v1:{order}:{hashlib.sha256(identity.encode()).hexdigest()[:16]}"
        questions.append({"order": order, "controlId": control_id, "label": label, "required": required,
                          "kind": kind, "options": options, "supported": kind != "UNKNOWN",
                          "unsupportedReason": None if kind != "UNKNOWN" else "UNRECOGNIZED_CONTROL"})
    if not questions:
        raise FormReaderError("SOURCE_CHANGED")
    if len(questions) > 200:
        raise FormReaderError("LIMIT_EXCEEDED")
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
