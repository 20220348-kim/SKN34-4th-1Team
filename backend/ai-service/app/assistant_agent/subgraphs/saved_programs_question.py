"""관심 공고 묶음 질문 서브그래프: retrieve(multi-doc) → map(공고마다 싼 모델, 병렬) → reduce(답 모델) → verify."""

import asyncio
import json
import logging
import operator
from functools import partial
from typing import Annotated, Any, TypedDict
from urllib.parse import urlencode

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from pydantic import ValidationError

from app.assistant_agent.models import (
    PROGRAM_DETAIL_ROUTE, AssistantAgentRequest, AssistantCard, ProgramFinding, SavedProgramDocument, SavedProgramsAnswer,
)
from app.assistant_agent.nodes.common import request_payload, structured_call
from app.assistant_agent.prompts import MAP_INSTRUCTIONS, REDUCE_INSTRUCTIONS
from app.assistant_agent.retriever import EvidenceRetriever, RetrievedChunk


logger = logging.getLogger(__name__)

PER_DOCUMENT_LIMIT = 4
MAX_ANSWER_ATTEMPTS = 2


class SavedProgramsState(TypedDict, total=False):
    request: AssistantAgentRequest
    documents: list[SavedProgramDocument]
    retrieved: dict[str, list[RetrievedChunk]]
    retrieval_failed: bool
    findings: dict[str, ProgramFinding | None]
    answer_output: SavedProgramsAnswer | None
    answer_attempts: Annotated[int, operator.add]
    verified: bool
    verified_cards: list[AssistantCard]
    model_calls: Annotated[int, operator.add]
    input_tokens: Annotated[int, operator.add]
    output_tokens: Annotated[int, operator.add]


async def retrieve(state: SavedProgramsState, *, retriever: EvidenceRetriever) -> dict:
    """문서 id 허용 목록 안에서 질문과 가까운 청크를 공고마다 최대 4개 찾는다. 검색 실패는 전부 '원문 미확인'으로 강등한다."""
    request = state["request"]
    try:
        retrieved = await retriever.retrieve(request.message, state["documents"], PER_DOCUMENT_LIMIT)
        return {"retrieved": retrieved, "retrieval_failed": False}
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001 - 검색 장애는 답을 강등할 뿐 요청을 실패시키지 않는다.
        logger.warning("assistant_agent_retrieval_failed error_type=%s", type(error).__name__)
        return {"retrieved": {}, "retrieval_failed": True}


async def map_findings(state: SavedProgramsState, *, model: BaseChatModel) -> dict:
    """청크가 있는 공고마다 싼 모델이 판단을 낸다. 병렬이며 하나가 실패해도 그 공고만 UNKNOWN이다."""
    request = state["request"]
    retrieved = state.get("retrieved", {})
    targets = [document for document in state["documents"] if retrieved.get(document.document_id)]

    async def judge(document: SavedProgramDocument) -> tuple[str, ProgramFinding | None, dict[str, int]]:
        chunks = retrieved[document.document_id]
        messages = [
            SystemMessage(MAP_INSTRUCTIONS),
            HumanMessage(request_payload(
                request, "map",
                program={"title": document.title, "applicationEndDate": document.application_end_date},
                chunks=[{"order": chunk.order, "text": chunk.text} for chunk in sorted(chunks, key=lambda item: item.order)],
            )),
        ]
        try:
            parsed, counts = await structured_call(model, ProgramFinding, messages)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001
            logger.warning("assistant_agent_map_failed error_type=%s", type(error).__name__)
            return document.document_id, None, {"model_calls": 1, "input_tokens": 0, "output_tokens": 0}
        return document.document_id, parsed, counts

    outcomes = await asyncio.gather(*(judge(document) for document in targets))
    findings: dict[str, ProgramFinding | None] = {document.document_id: None for document in state["documents"]}
    totals = {"model_calls": 0, "input_tokens": 0, "output_tokens": 0}
    for document_id, finding, counts in outcomes:
        findings[document_id] = finding
        for key in totals:
            totals[key] += counts[key]
    return {"findings": findings, **totals}


async def reduce_answer(state: SavedProgramsState, *, model: BaseChatModel) -> dict:
    """판단 결과만 보고 비교 문장과 카드 순서를 정한다. 원문 청크는 다시 주지 않는다."""
    request = state["request"]
    findings = state.get("findings", {})
    programs = [
        {
            "documentId": document.document_id, "title": document.title, "applicationEndDate": document.application_end_date,
            "fetched": document.fetched and bool(state.get("retrieved", {}).get(document.document_id)),
            "finding": finding.model_dump(by_alias=True) if (finding := findings.get(document.document_id)) is not None else None,
        }
        for document in state["documents"]
    ]
    messages = [
        SystemMessage(REDUCE_INSTRUCTIONS),
        HumanMessage(request_payload(
            request, "reduce", programs=programs,
            unfetchedCount=sum(1 for program in programs if not program["fetched"]),
            retrievalFailed=bool(state.get("retrieval_failed")),
        )),
    ]
    parsed, counts = await structured_call(model, SavedProgramsAnswer, messages)
    return {"answer_output": parsed, "answer_attempts": 1, **counts}


def verify(state: SavedProgramsState) -> dict:
    """카드는 관심 공고 문서 id 안에서만, 인용은 그 공고의 검색 청크 원문 안에 글자 그대로 있어야 남긴다."""
    output = state.get("answer_output")
    if output is None:
        return {"verified": False, "verified_cards": []}
    documents = {document.document_id: document for document in state["documents"]}
    retrieved = state.get("retrieved", {})
    findings = state.get("findings", {})
    cards: list[AssistantCard] = []
    try:
        for choice in output.cards:
            document = documents.get(choice.document_id)
            if document is None:
                return {"verified": False, "verified_cards": []}
            finding = findings.get(document.document_id)
            quote = finding.quote if finding is not None else None
            if quote is not None and not any(quote in chunk.text for chunk in retrieved.get(document.document_id, [])):
                # 대조에 실패한 인용은 카드에서 뺀다. 판단 이유는 남는다.
                quote = None
            cards.append(AssistantCard(
                kind="PROGRAM", id=document.document_id, title=document.title, subtitle=_subtitle(document),
                reason=choice.reason, quote=quote,
                to=f"{PROGRAM_DETAIL_ROUTE}?{urlencode({'sourceCode': document.source_code, 'sourceProgramId': document.source_program_id})}",
            ))
    except ValidationError:
        return {"verified": False, "verified_cards": []}
    return {"verified": True, "verified_cards": cards}


def route_after_verify(state: SavedProgramsState) -> str:
    if not state.get("verified") and state.get("answer_attempts", 0) < MAX_ANSWER_ATTEMPTS:
        return "reduce"
    return END


def _subtitle(document: SavedProgramDocument) -> str | None:
    if document.application_end_date is None:
        return None
    return f"{document.application_end_date} 마감"


def build_saved_programs_subgraph(
    *, map_model: BaseChatModel, reduce_model: BaseChatModel, retriever: EvidenceRetriever,
) -> CompiledStateGraph:
    graph: StateGraph = StateGraph(SavedProgramsState)
    graph.add_node("retrieve", partial(retrieve, retriever=retriever))
    graph.add_node("map", partial(map_findings, model=map_model))
    graph.add_node("reduce", partial(reduce_answer, model=reduce_model))
    graph.add_node("verify", verify)
    graph.add_edge(START, "retrieve")
    graph.add_edge("retrieve", "map")
    graph.add_edge("map", "reduce")
    graph.add_edge("reduce", "verify")
    graph.add_conditional_edges("verify", route_after_verify, {"reduce": "reduce", END: END})
    return graph.compile()


def make_saved_programs_node(subgraph: CompiledStateGraph):
    """메인 그래프의 노드: 서브그래프를 돌리고 답·카드·호출 수를 메인 상태로 옮긴다."""

    async def saved_programs(state: dict[str, Any]) -> dict:
        request: AssistantAgentRequest = state["request"]
        documents = request.saved_program_documents or []
        result = await subgraph.ainvoke({
            "request": request, "documents": documents, "answer_attempts": 0,
            "model_calls": 0, "input_tokens": 0, "output_tokens": 0,
        })
        output = result.get("answer_output")
        return {
            "agent_answer": output.answer if output is not None else None,
            "agent_navigation": output.navigation if output is not None else None,
            "verified": bool(result.get("verified")),
            "verified_cards": list(result.get("verified_cards", [])),
            "answer_attempts": int(result.get("answer_attempts", 0)),
            "model_calls": int(result.get("model_calls", 0)),
            "input_tokens": int(result.get("input_tokens", 0)),
            "output_tokens": int(result.get("output_tokens", 0)),
        }

    return saved_programs
