"""실제 LangChain/OpenAI 직렬화를 실행하고 HTTP 응답만 대체하는 테스트 도우미."""

import inspect
import json
from types import SimpleNamespace

import httpx2
from langchain_openai import ChatOpenAI
from langsmith import get_tracing_context
from openai import AsyncOpenAI


def chat_model(*, model, openai_client):
    return ChatOpenAI(
        model=model, api_key="test-key-never-sent", use_responses_api=True, max_retries=0,
        root_async_client=openai_client, async_client=openai_client.chat.completions,
    )


def response_message(text):
    return {"id": "msg_test", "role": "assistant", "status": "completed", "type": "message",
            "content": [{"annotations": [], "text": text, "type": "output_text"}]}


def user_payload(body):
    content = next(item["content"] for item in body["input"] if item["role"] == "user")
    return content if isinstance(content, str) else content[0]["text"]


class ResponsesChatStub:
    clients = []

    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = []

        async def handle(request):
            assert request.url.path == "/v1/responses"
            body = json.loads(request.content)
            call = SimpleNamespace(
                body=body, input=[{"content": user_payload(body)}],
                system_instructions=next(item["content"] for item in body["input"] if item["role"] == "system"),
                schema=body["text"]["format"]["schema"],
                timeout=request.extensions["timeout"]["read"],
                tracing_disabled=get_tracing_context()["enabled"] is False,
            )
            self.calls.append(call)
            assert self.outputs, "Unexpected extra model request"
            output = self.outputs.pop(0)
            if callable(output):
                output = output(call)
                if inspect.isawaitable(output):
                    output = await output
            return httpx2.Response(200, json={
                "id": "resp_test", "created_at": 0, "error": None, "incomplete_details": None,
                "model": body["model"], "object": "response", "status": "completed",
                "output": output, "parallel_tool_calls": False, "tool_choice": "none", "tools": [],
            })

        client = AsyncOpenAI(
            api_key="test-key-never-sent", base_url="https://openai.test/v1/", max_retries=0,
            http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handle)),
        )
        self.clients.append(client)
        self.model = chat_model(model="test-model", openai_client=client)

    @property
    def first_call(self):
        return self.calls[0]

    def assert_complete(self):
        assert not self.outputs
