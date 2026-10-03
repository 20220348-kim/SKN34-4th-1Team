"""Short-lived, exact-tool MCP host for public Google Forms."""
import asyncio
from contextlib import asynccontextmanager
import json
import logging
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from jsonschema import validate, ValidationError as SchemaValidationError
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from app.application_preparation.public_google_form_reader import (
    CONTRACT, MAX_OPTIONS, MAX_OUTPUT, MAX_TEXT, canonical_url, FormReaderError,
)

logger = logging.getLogger(__name__)
TOOL = "inspect_public_google_form"


class OnlineFormMcpError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def validate_result(value: object) -> dict:
    if not isinstance(value, dict) or value.get("contractVersion") != CONTRACT:
        raise OnlineFormMcpError("SOURCE_CHANGED")
    try:
        if canonical_url(value.get("sourceUrl")) != value["sourceUrl"] or canonical_url(value.get("finalUrl"), final=True) != value["finalUrl"]:
            raise OnlineFormMcpError("SOURCE_CHANGED")
    except (FormReaderError, KeyError, TypeError):
        raise OnlineFormMcpError("SOURCE_CHANGED") from None
    if len(json.dumps(value, ensure_ascii=False).encode()) > MAX_OUTPUT:
        raise OnlineFormMcpError("LIMIT_EXCEEDED")
    if not isinstance(value.get("formTitle"), str) or not 1 <= len(value["formTitle"]) <= 1000:
        raise OnlineFormMcpError("SOURCE_CHANGED")
    if not isinstance(value.get("semanticFingerprint"), str) or len(value["semanticFingerprint"]) != 64:
        raise OnlineFormMcpError("SOURCE_CHANGED")
    questions = value.get("questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= 200:
        raise OnlineFormMcpError("SOURCE_CHANGED")
    ids = set()
    for index, question in enumerate(questions, 1):
        if not isinstance(question, dict) or question.get("order") != index:
            raise OnlineFormMcpError("SOURCE_CHANGED")
        if not isinstance(question.get("controlId"), str) or not 1 <= len(question["controlId"]) <= 100:
            raise OnlineFormMcpError("SOURCE_CHANGED")
        if question["controlId"] in ids:
            raise OnlineFormMcpError("SOURCE_CHANGED")
        ids.add(question["controlId"])
        if not isinstance(question.get("label"), str) or not 1 <= len(question["label"]) <= MAX_TEXT:
            raise OnlineFormMcpError("SOURCE_CHANGED")
        if not isinstance(question.get("description"), str) or len(question["description"]) > MAX_TEXT:
            raise OnlineFormMcpError("SOURCE_CHANGED")
        if type(question.get("required")) is not bool or question.get("kind") not in {"SHORT_TEXT", "LONG_TEXT", "SINGLE_CHOICE", "MULTI_CHOICE", "DROPDOWN", "UNKNOWN"}:
            raise OnlineFormMcpError("SOURCE_CHANGED")
        options = question.get("options")
        if not isinstance(options, list) or len(options) > MAX_OPTIONS or any(not isinstance(x, str) or not 1 <= len(x) <= 1000 for x in options):
            raise OnlineFormMcpError("SOURCE_CHANGED")
        if type(question.get("supported")) is not bool or (question["kind"] == "UNKNOWN") == question["supported"]:
            raise OnlineFormMcpError("SOURCE_CHANGED")
        # Only answerable questions carry the numeric entry used by a pre-filled link.
        entry_id = question.get("entryId")
        if (entry_id is None) == question["supported"] or (entry_id is not None and (not isinstance(entry_id, str) or not entry_id.isascii() or not entry_id.isdigit() or len(entry_id) > 20)):
            raise OnlineFormMcpError("SOURCE_CHANGED")
        if type(question.get("allowsOther")) is not bool or (question["allowsOther"] and question["kind"] not in {"SINGLE_CHOICE", "MULTI_CHOICE"}):
            raise OnlineFormMcpError("SOURCE_CHANGED")
    return value


@asynccontextmanager
async def online_form_session():
    root = Path(__file__).resolve().parents[2]
    with TemporaryDirectory(prefix="gpub-mcp-") as temporary:
        env = {k: v for k, v in os.environ.items() if k in {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"}}
        env.update({"HOME": temporary, "USERPROFILE": temporary, "TMP": temporary, "TEMP": temporary,
                    "TMPDIR": temporary, "PYTHONIOENCODING": "utf-8"})
        parameters = StdioServerParameters(command=sys.executable,
                                           args=["-m", "app.application_preparation.public_google_form_mcp_server"],
                                           cwd=str(root), env=env)
        try:
            with open(os.devnull, "w") as stderr:
                async with asyncio.timeout(35):
                    async with stdio_client(parameters, errlog=stderr) as (read, write):
                        async with ClientSession(read, write, read_timeout_seconds=25.0) as session:
                            await session.initialize()
                            tools = (await session.list_tools()).tools
                            if {tool.name for tool in tools} != {TOOL}:
                                raise OnlineFormMcpError("MCP_NOT_READY")
                            yield session, tools[0].input_schema
        except OnlineFormMcpError:
            raise
        except BaseException as error:
            if isinstance(error, asyncio.CancelledError):
                raise
            def known_failure(item):
                if isinstance(item, OnlineFormMcpError):
                    return item
                for child in getattr(item, "exceptions", []):
                    found = known_failure(child)
                    if found is not None:
                        return found
                return None
            known = known_failure(error)
            if known is not None:
                raise known from None
            logger.warning("online_form_mcp_failed type=%s", type(error).__name__)
            raise OnlineFormMcpError("MCP_FAILED") from None


async def inspect_via_mcp(url: str) -> dict:
    arguments = {"url": url}
    async with online_form_session() as (session, schema):
        try:
            validate(arguments, schema)
        except SchemaValidationError:
            raise OnlineFormMcpError("MCP_NOT_READY") from None
        result = await session.call_tool(TOOL, arguments)
        if result.is_error:
            codes = {"INVALID_URL", "SOURCE_UNAVAILABLE", "SOURCE_CHANGED", "PARSER_FAILED", "UNSUPPORTED", "REDIRECT_LIMIT", "LIMIT_EXCEEDED",
                     "LOGIN_REQUIRED", "CLOSED", "NO_QUESTIONS"}
            reason = next((block.text for block in result.content if block.type == "text" and block.text in codes), "MCP_FAILED")
            raise OnlineFormMcpError(reason)
        payload = result.structured_content
        if payload is None:
            try:
                payload = json.loads("".join(block.text for block in result.content if block.type == "text"))
            except (ValueError, TypeError):
                raise OnlineFormMcpError("MCP_FAILED") from None
        if isinstance(payload, dict) and set(payload) == {"result"}:
            payload = payload["result"]
        return validate_result(payload)
