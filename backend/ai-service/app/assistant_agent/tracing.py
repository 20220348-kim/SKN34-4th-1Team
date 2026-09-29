"""두 도우미 그래프의 노드에서 본문 없이 단계·버전·검증 결과만 기록한다."""

from hashlib import sha256
from inspect import isawaitable

from app.tracing import LLMTracing


def traced_node(tracing: LLMTracing, name: str, operation, *, model=None, prompt: str | None = None):
    # 그래프 상태, 모델 입력/출력, 문서·계정 식별자는 exporter에 넘기지 않는다.
    metadata = {}
    if model is not None:
        metadata["model"] = getattr(model, "model_name", type(model).__name__)
    if prompt is not None:
        metadata["prompt_sha256"] = sha256(prompt.encode()).hexdigest()

    async def run(state):
        with tracing.observation(name, metadata=metadata) as observation:
            result = operation(state)
            if isawaitable(result):
                result = await result
            summary = {}
            degraded = False
            if "verified" in result:
                summary["validation_passed"] = result["verified"]
                degraded = not result["verified"]
            if "tool_results" in result:
                summary["tool_calls"] = len(result["tool_results"])
                summary["tool_failures"] = sum(not item["ok"] for item in result["tool_results"])
                degraded |= summary["tool_failures"] > 0
            if "retrieved" in result:
                summary["retrieved_documents"] = len(result["retrieved"])
                summary["retrieved_chunks"] = sum(len(chunks) for chunks in result["retrieved"].values())
                summary["retrieval_failed"] = result["retrieval_failed"]
                degraded |= result["retrieval_failed"]
            if "findings" in result:
                # 원문이 없어 호출하지 않은 문서는 모델 실패로 세지 않는다.
                summary["map_failures"] = sum(
                    finding is None and bool(state.get("retrieved", {}).get(identifier))
                    for identifier, finding in result["findings"].items()
                )
                degraded |= summary["map_failures"] > 0
            summary["result_status"] = "degraded" if degraded else "completed"
            tracing.update(
                observation,
                metadata=summary,
                **({"level": "WARNING", "status_message": "degraded"} if degraded else {}),
            )
            return result

    return run
