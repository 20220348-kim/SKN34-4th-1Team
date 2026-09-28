"""Dedicated stdio MCP exposing one read-only public responder inspection tool."""
import asyncio
import json

import mcp_types as types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from app.application_preparation.public_google_form_reader import FormReaderError, inspect_public_google_form

TOOL = "inspect_public_google_form"
SCHEMA = {"type": "object", "properties": {"url": {"type": "string", "maxLength": 2048}},
          "required": ["url"], "additionalProperties": False}


async def list_tools(_context, _params):
    return types.ListToolsResult(tools=[types.Tool(name=TOOL, description="Read public Google Forms responder questions via GET only", inputSchema=SCHEMA)])


async def call_tool(_context, params):
    if params.name != TOOL or not isinstance(params.arguments, dict) or set(params.arguments) != {"url"} or not isinstance(params.arguments["url"], str):
        return types.CallToolResult(content=[types.TextContent(type="text", text="INVALID_TOOL")], isError=True)
    try:
        result = inspect_public_google_form(params.arguments["url"])
        return types.CallToolResult(content=[types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False))], structuredContent=result)
    except FormReaderError as error:
        return types.CallToolResult(content=[types.TextContent(type="text", text=error.code)], isError=True)
    except Exception:
        return types.CallToolResult(content=[types.TextContent(type="text", text="PARSER_FAILED")], isError=True)


server = Server("Google Public Form Reader MCP", on_list_tools=list_tools, on_call_tool=call_tool)


async def main():
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
