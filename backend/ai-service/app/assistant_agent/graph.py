"""LangGraph 조립: (resume|classify) → (조건) plan ⇄ tools → answer → verify → finalize, 또는 saved_programs 서브그래프 → finalize."""

from functools import partial

from langchain_core.language_models import BaseChatModel
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from app.assistant_agent.nodes.answer import answer
from app.assistant_agent.nodes.classify import classify, resume, route_after_classify, route_start
from app.assistant_agent.nodes.plan import plan, route_after_plan
from app.assistant_agent.nodes.tools import route_after_tools, run_tools
from app.assistant_agent.nodes.verify import finalize, route_after_verify, verify
from app.assistant_agent.retriever import EvidenceRetriever
from app.assistant_agent.state import AgentState
from app.assistant_agent.subgraphs.saved_programs_question import build_saved_programs_subgraph, make_saved_programs_node
from app.assistant_agent.tools import CoreToolClient


def build_assistant_agent_graph(
    *, classify_model: BaseChatModel, agent_model: BaseChatModel, tool_client: CoreToolClient, max_tool_calls: int,
    retriever: EvidenceRetriever,
) -> CompiledStateGraph:
    if not 1 <= max_tool_calls <= 6:
        raise ValueError("max_tool_calls must be 1~6")
    graph: StateGraph = StateGraph(AgentState)
    graph.add_node("classify", partial(classify, model=classify_model))
    graph.add_node("resume", resume)
    graph.add_node("plan", partial(plan, model=agent_model, tool_client=tool_client, max_tool_calls=max_tool_calls))
    graph.add_node("tools", partial(run_tools, tool_client=tool_client, max_tool_calls=max_tool_calls))
    graph.add_node("answer", partial(answer, model=agent_model))
    graph.add_node("verify", verify)
    # 관심 공고 묶음 질문: 공고마다 싼 모델(분류 모델)이 근거를 판단하고 답 모델이 합친다.
    graph.add_node("saved_programs", make_saved_programs_node(
        build_saved_programs_subgraph(map_model=classify_model, reduce_model=agent_model, retriever=retriever),
    ))
    graph.add_node("finalize", finalize)

    graph.add_conditional_edges(START, route_start, {"classify": "classify", "resume": "resume"})
    graph.add_conditional_edges("classify", route_after_classify, {"plan": "plan", "saved_programs": "saved_programs", "finalize": "finalize"})
    graph.add_conditional_edges("resume", route_after_classify, {"plan": "plan", "saved_programs": "saved_programs", "finalize": "finalize"})
    graph.add_conditional_edges("plan", route_after_plan, {"tools": "tools", "answer": "answer"})
    graph.add_conditional_edges(
        "tools", partial(route_after_tools, max_tool_calls=max_tool_calls), {"plan": "plan", "answer": "answer"},
    )
    graph.add_edge("answer", "verify")
    graph.add_conditional_edges("verify", route_after_verify, {"answer": "answer", "finalize": "finalize"})
    graph.add_edge("saved_programs", "finalize")
    graph.add_edge("finalize", END)
    # 체크포인터 없음: 턴마다 새 상태. 대화 맥락은 요청의 history 6개로 충분하다.
    return graph.compile()
