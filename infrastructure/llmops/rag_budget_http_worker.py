"""무료 MySQL 통합 검사 전용 AI 프로세스. 모델 전송을 모두 대역으로 막는다."""

import json
import os
import sys
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "rag-http-integration-only-" + "a" * 40


def synthetic_cases():
    chunks = [
        {
            "id": sha256(f"rag-http-{index}".encode()).hexdigest(),
            "documentId": "BIZINFO:TEST",
            "order": index,
            "text": text,
            "contentHash": sha256(text.encode()).hexdigest(),
        }
        for index, text in enumerate(("서울 법인 지원", "사업비 백만원"))
    ]
    return [
        {"case_id": f"R{index}", "chunks": chunks, "question": "지원 대상?", "limit": 2}
        for index in range(2)
    ]


def run_session(config):
    import httpx2
    import serve_flow
    from budget_client import BudgetClient, BudgetUnavailable
    from fastapi.testclient import TestClient
    from qdrant_client import AsyncQdrantClient
    from rag_budget import RagBudget

    parsed = urlsplit(config["ops_url"])
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port:
        raise ValueError("Only the isolated loopback Ops test server is allowed")
    os.environ.update(
        OPENAI_API_KEY="offline-rag-http-key-never-sent",
        OPENAI_BASE_URL="https://forbidden.invalid/v1",
        LLMOPS_OPS_API_URL=config["ops_url"],
        LLMOPS_BUDGET_TOKEN=TOKEN,
    )
    counts = {"embedding": 0, "answer": 0, "input_count": 0}
    scenario = config["scenario"]

    def model_response(request):
        # No passthrough transport: even an unexpected SDK URL cannot leave this process.
        if request.method != "POST" or str(request.url) not in {
            "https://api.openai.com/v1/embeddings",
            "https://api.openai.com/v1/responses",
            "https://api.openai.com/v1/responses/input_tokens",
        }:
            raise AssertionError("Test model endpoint is not allowlisted")
        body = json.loads(request.content)
        if request.url.path.endswith("input_tokens"):
            counts["input_count"] += 1
            return httpx2.Response(
                200, json={"object": "response.input_tokens", "input_tokens": 100}
            )
        if request.url.path.endswith("embeddings"):
            counts["embedding"] += 1
            return httpx2.Response(
                200,
                headers={"x-request-id": f"req_{config['run_id']}_{counts['embedding']}"},
                json={
                    "model": body["model"],
                    "usage": {
                        "prompt_tokens": len(body["input"]),
                        "total_tokens": len(body["input"]),
                    },
                    "data": [
                        {"index": index, "embedding": [1.0] + [0.0] * 1535}
                        for index in range(len(body["input"]))
                    ],
                },
            )
        counts["answer"] += 1
        if scenario == "model-timeout":
            raise httpx2.ReadTimeout("synthetic response loss", request=request)
        return httpx2.Response(
            200,
            json={
                "id": f"resp_{config['run_id']}_{counts['answer']}",
                "object": "response",
                "created_at": 0,
                "model": body["model"],
                "status": "completed",
                "error": None,
                "incomplete_details": None,
                "parallel_tool_calls": False,
                "tool_choice": "none",
                "tools": [],
                "output": [
                    {
                        "id": "msg_test",
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [
                            {
                                "type": "output_text",
                                "annotations": [],
                                "text": json.dumps(
                                    {
                                        "answer": "서울 법인이 대상입니다.",
                                        "answerStatus": "ANSWERED",
                                        "citationChunkIndexes": [
                                            999 if scenario == "invalid-citation" else 0
                                        ],
                                    }
                                ),
                            }
                        ],
                    }
                ],
                "usage": None
                if scenario == "unknown-usage"
                else {
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "total_tokens": 120,
                },
            },
        )

    original_init = httpx2.AsyncClient.__init__

    def offline_init(self, *args, **kwargs):
        kwargs["transport"] = httpx2.MockTransport(model_response)
        kwargs["trust_env"] = False
        original_init(self, *args, **kwargs)

    output = Path(config["results"]) / config["run_id"] / "capture"
    output.parent.mkdir(parents=True, exist_ok=True)
    budget = BudgetClient(config["run_id"], config["flow_id"], config["spec_hash"])
    guard = RagBudget(budget, config["spec"], receipt_directory=output)
    result = {
        "counts": counts,
        "worker_id": budget.identity["worker_id"],
        "statuses": [],
    }
    prefix = "/internal/v1/support-program-evidence/"
    with (
        patch.object(httpx2.AsyncClient, "__init__", offline_init),
        patch.object(
            serve_flow.bootstrap,
            "AsyncQdrantClient",
            lambda **_: AsyncQdrantClient(":memory:"),
        ),
    ):
        app = serve_flow.build_evaluation_app(
            output,
            "http://127.0.0.1:1",
            len(config["spec"]["model_operations"]),
            rag_budget=guard,
        )
        try:
            with TestClient(app, raise_server_exceptions=False) as client:
                for case in config["spec"]["rag_cases"]:
                    response = None
                    calls = (
                        ("PUT", "chunks", {"chunks": case["chunks"]}),
                        (
                            "POST",
                            "search",
                            {
                                "question": case["question"],
                                "limit": case["limit"],
                                "eligibleChunks": [
                                    {k: v for k, v in chunk.items() if k != "text"}
                                    for chunk in case["chunks"]
                                ],
                            },
                        ),
                        ("POST", "answers", None),
                    )
                    for method, path, payload in calls:
                        if path == "answers":
                            by_id = {chunk["id"]: chunk for chunk in case["chunks"]}
                            payload = {
                                "question": case["question"],
                                "chunks": [
                                    {
                                        k: v
                                        for k, v in by_id[match["id"]].items()
                                        if k != "contentHash"
                                    }
                                    for match in response.json()["matches"]
                                ],
                            }
                        response = client.request(method, prefix + path, json=payload)
                        result["statuses"].append(response.status_code)
                        if response.status_code != 200:
                            result["blocked_status"] = client.put(
                                prefix + "chunks", json={"chunks": case["chunks"]}
                            ).status_code
                            break
                    if response.status_code != 200:
                        break
        except BudgetUnavailable:
            result["lifecycle_error"] = True
    return result


if __name__ == "__main__":
    sys.path.insert(0, str(ROOT / "evaluation/support-program-evidence"))
    sys.path.insert(0, str(ROOT / "backend/ai-service"))
    if sys.argv[1:] == ["spec"]:
        from rag_budget import make_rag_spec

        print(json.dumps(make_rag_spec(synthetic_cases())))
    elif sys.argv[1:] == ["run"]:
        print(json.dumps(run_session(json.load(sys.stdin))))
    else:
        raise SystemExit("Expected spec or run")
