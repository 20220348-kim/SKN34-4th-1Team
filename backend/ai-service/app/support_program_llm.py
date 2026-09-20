"""지원사업 Agent의 LangChain 프롬프트 실행과 엄격한 구조화 응답 검증."""

import asyncio
import json
from typing import TypeVar

from langchain_core.messages import AIMessage
from langchain_core.messages.ai import UsageMetadata
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import Runnable
from langsmith import tracing_context
from openai import pydantic_function_tool
from pydantic import BaseModel


Output = TypeVar("Output", bound=BaseModel)


async def invoke_support_program_model(
    model: Runnable,
    *,
    instructions: str,
    payload: dict,
    output_type: type[BaseModel],
    timeout_seconds: float,
) -> AIMessage:
    # 검색 원문 안의 중괄호·명령은 템플릿/시스템 지침이 아닌 사용자 데이터로 전달한다.
    prompt = ChatPromptTemplate.from_messages([
        ("system", "{instructions}"), ("human", "{payload}"),
    ])
    # strict 스키마 변환만 사용한다. 도구를 등록하지 않고 $defs를 유지해
    # 후보 20개의 동일한 판정 스키마/설명이 반복 전송되지 않게 한다.
    schema = pydantic_function_tool(output_type)["function"]
    chain = prompt | model.bind(response_format={
        "type": "json_schema",
        "json_schema": {"name": schema["name"], "strict": True, "schema": schema["parameters"]},
    })
    async with asyncio.timeout(timeout_seconds):
        with tracing_context(enabled=False):
            return await chain.ainvoke({
                "instructions": instructions,
                "payload": json.dumps(payload, ensure_ascii=False),
            })


def validate_support_program_output(message: AIMessage, output_type: type[Output]) -> Output:
    if (
        not isinstance(message, AIMessage)
        or message.response_metadata.get("status") != "completed"
        or message.tool_calls
        or message.invalid_tool_calls
        or message.additional_kwargs.get("refusal")
        or any(isinstance(block, dict) and block.get("type") == "refusal" for block in message.content)
    ):
        raise ValueError("Support program model did not complete a structured response")
    # JSON 자동 복구·문자열/숫자 강제 변환 없이 원문 전체를 검증한다.
    return output_type.model_validate_json(message.text, strict=True)



def get_support_program_usage_details(usage: UsageMetadata | None) -> tuple[int | None, int | None]:
    """기본·priority·flex의 캐시/추론 사용량을 합산하고 미제공 값은 None으로 유지한다."""
    if usage is None:
        return None, None
    input_details = usage.get("input_token_details", {})
    output_details = usage.get("output_token_details", {})
    # 등급 이름만 있는 키는 비캐시/비추론 잔여량이므로 합산하지 않는다.
    cached = [input_details[key] for key in ("cache_read", "priority_cache_read", "flex_cache_read")
              if key in input_details]
    reasoning = [output_details[key] for key in ("reasoning", "priority_reasoning", "flex_reasoning")
                 if key in output_details]
    return sum(cached) if cached else None, sum(reasoning) if reasoning else None
