import asyncio
import json

import httpx2
from langchain_openai import ChatOpenAI
from langsmith import get_tracing_context


def make_model(data=None, *, status="completed", content=None, http_status=200, delay=0,
                 transport_timeout=False):
    calls = []

    async def handle(request):
        assert get_tracing_context()["enabled"] is False
        calls.append(request)
        if transport_timeout:
            raise httpx2.ReadTimeout("private timeout detail", request=request)
        if delay:
            await asyncio.sleep(delay)
        if http_status != 200:
            return httpx2.Response(http_status, json={"error": {"message": "private upstream detail"}})
        body = {
            "id": "resp_test", "object": "response", "created_at": 0, "model": "test-model",
            "status": status, "error": None,
            "incomplete_details": {"reason": "max_output_tokens"} if status == "incomplete" else None,
            "output": [{"id": "msg_test", "type": "message", "role": "assistant", "status": "completed",
                        "content": content if content is not None else [{
                            "type": "output_text", "text": json.dumps(data, ensure_ascii=False),
                            "annotations": [],
                        }]}],
        }
        return httpx2.Response(200, json=body)

    model = ChatOpenAI(
        model="test-model", api_key="test-key", base_url="https://openai.test/v1/",
        use_responses_api=True, store=False, reasoning={"effort": "none"},
        max_tokens=6000, timeout=2, max_retries=0,
        http_async_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handle)),
    )
    object.__setattr__(model, "calls", calls)
    return model
