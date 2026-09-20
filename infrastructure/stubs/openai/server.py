"""Deterministic HTTP test double; never a production AI fallback or quality benchmark."""

import json
import re
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def topic(text: str) -> int:
    if "AI" in text or "인공지능" in text:
        return 1
    if "수출" in text or "해외 진출" in text:
        return 0
    return 2


def conversation_output(payload: dict) -> dict | None:
    """C02의 정해진 smoke 사례만 응답한다. 자연어 해석 품질 대역이 아니다."""
    message = payload["message"]
    updates = []
    question = None
    if message == "부산으로 변경":
        updates = [{"field": "REGION", "operation": "SET", "value": "부산", "evidence": "부산"}]
    elif message == "지원금 위주":
        updates = [
            {"field": "QUERY", "operation": "SET", "value": "사업화 지원금", "evidence": "지원금"},
            {"field": "SUPPORT_PURPOSE", "operation": "SET", "value": "지원금", "evidence": "지원금"},
        ]
    elif message == "사업화 말고 수출 지원으로 바꿔줘":
        updates = [
            {"field": "QUERY", "operation": "SET", "value": "수출 지원", "evidence": "수출 지원"},
            {"field": "SUPPORT_PURPOSE", "operation": "SET", "value": "수출", "evidence": "수출"},
        ]
    elif message == "사업화 지원을 찾고 싶어요":
        updates = [{"field": "QUERY", "operation": "SET", "value": "사업화 지원", "evidence": "사업화 지원"}]
    elif message == "지역 조건 삭제":
        updates = [{"field": "REGION", "operation": "CLEAR", "value": None, "evidence": message}]
    elif message == "전체 초기화":
        updates = [{"field": field, "operation": "CLEAR", "value": None, "evidence": message}
                   for field in ("QUERY", "REGION", "INDUSTRY", "ESTABLISHED_ON", "SUPPORT_PURPOSE", "ACCEPTING_ONLY")]
        question = "어떤 지원사업을 찾으시나요?"
    elif message in ("설립 2년", "부산이나 대구로"):
        question = "정확한 설립일을 YYYY-MM-DD 형식으로 알려주세요." if message == "설립 2년" else "현재 소재지가 부산인가요, 대구인가요?"
    elif payload.get("pendingClarification") and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", message):
        updates = [{"field": "ESTABLISHED_ON", "operation": "SET", "value": date.fromisoformat(message).isoformat(), "evidence": message}]
    else:
        return None
    base = payload["pendingClarification"]["draftContext"] if payload.get("pendingClarification") else payload["context"]
    query = next((update["value"] for update in updates if update["field"] == "QUERY"), base["query"])
    if query is None and question is None:
        question = "어떤 지원사업을 찾으시나요?"
    return {"status": "READY" if question is None else "CLARIFICATION_REQUIRED",
            "updates": updates, "clarificationQuestion": question}


def assistant_agent_output(request: dict, payload: dict) -> tuple[str, object]:
    """도우미 도구 에이전트(LangGraph)의 분류·계획·답 단계를 문구로 흉내 낸다. 계획 단계는 도구 호출 항목을 돌려준다."""
    step = payload.get("step")
    message = payload.get("message", "")
    if step == "classify":
        empty = {"answer": None, "citations": [], "clarificationQuestion": None, "searchQuery": None, "accountTopic": None}
        if "모집글" in message or "파트너" in message or "협업" in message:
            return "message", {**empty, "intent": "PARTNER_MATCH"}
        if "담은 공고" in message or "관심 공고들" in message or "담아둔" in message:
            return "message", {**empty, "intent": "SAVED_PROGRAMS_QUESTION"}
        return "message", assistant_output(payload)
    if step == "plan":
        outputs = [item for item in request["input"] if isinstance(item, dict) and item.get("type") == "function_call_output"]
        intent = payload.get("intent")
        if intent == "PARTNER_MATCH":
            if not outputs:
                return "tool_calls", [("get_my_company_profile", {})]
            if len(outputs) == 1:
                profile = json.loads(outputs[0]["output"])
                roles = profile.get("roles") or []
                return "tool_calls", [("search_partner_recruitments", {
                    "region": None, "seekingRole": "PARTICIPANT" if "PARTICIPANT" in roles or not roles else "LEAD", "keyword": None,
                })]
        elif not outputs:
            tool = "get_my_company_profile" if payload.get("accountTopic") == "COMPANY_PROFILE" else "list_saved_programs"
            return "tool_calls", [(tool, {})]
        return "message", "READY"
    if step == "map":
        chunks = payload.get("chunks") or []
        if not chunks:
            return "message", {"verdict": "UNKNOWN", "value": None, "quote": None, "confidence": "LOW"}
        # 첫 청크 원문을 글자 그대로 인용해 Core·AI Service의 대조를 통과하게 한다.
        return "message", {"verdict": "YES", "value": "온라인 접수", "quote": chunks[0]["text"][:200], "confidence": "HIGH"}
    if step == "reduce":
        programs = payload.get("programs") or []
        matched = [program for program in programs if program.get("finding") and program["finding"].get("verdict") == "YES"]
        unfetched = [program for program in programs if not program.get("fetched")]
        answer = f"관심 공고 {len(programs)}건 중 {len(matched)}건이 질문에 해당해요."
        if unfetched:
            answer += f" {len(unfetched)}건은 원문을 확인하지 못했어요."
        return "message", {
            "answer": answer,
            "cards": [{"documentId": program["documentId"], "reason": f"{program['finding'].get('value') or '해당'}으로 확인됐어요."} for program in matched[:5]],
            "navigation": "SAVED_PROGRAMS" if programs else "CHAT",
        }
    if step == "answer":
        data = payload.get("data", {})
        intent = payload.get("intent")
        if intent == "PARTNER_MATCH":
            profile = data.get("companyProfile") or {}
            if not profile.get("registered", False):
                return "message", {"answer": "먼저 프로필에서 기업을 등록하면 맞는 모집글을 찾아드릴게요.", "cards": [], "navigation": "PROFILE"}
            recruitments = data.get("recruitments") or []
            cards = [{"kind": "RECRUITMENT", "id": str(item["id"]), "reason": "테스트 대역이 고른 모집글입니다."} for item in recruitments[:3]]
            answer = (f"모집 중인 글 {len(recruitments)}건 중 {len(cards)}건을 골랐어요. 카드에서 상세를 확인해 보세요."
                      if cards else "지금은 맞는 모집글이 없어요. 파트너 모집 화면에서 직접 살펴보거나 조건을 바꿔 물어봐 주세요.")
            return "message", {"answer": answer, "cards": cards, "navigation": "PARTNERS"}
        programs = data.get("savedPrograms") or []
        cards = [{"kind": "PROGRAM", "id": f"{item['sourceCode']}:{item['sourceProgramId']}", "reason": "테스트 대역이 고른 공고입니다."}
                 for item in programs[:2]]
        if data.get("errors"):
            return "message", {"answer": "지금은 자료를 확인하지 못했어요. 잠시 뒤 다시 물어봐 주세요.", "cards": [], "navigation": "NONE"}
        if payload.get("accountTopic") == "COMPANY_PROFILE":
            profile = data.get("companyProfile") or {}
            answer = f"{profile.get('companyName')}이(가) 등록되어 있어요." if profile.get("registered") else "아직 기업이 등록되지 않았어요."
            return "message", {"answer": answer, "cards": [], "navigation": "PROFILE"}
        answer = f"관심 공고 {len(programs)}건이 있어요." if programs else "관심 공고함이 비어 있어요."
        return "message", {"answer": answer, "cards": cards, "navigation": "SAVED_PROGRAMS"}
    return "message", {"error": "unsupported assistant agent step"}


def assistant_output(payload: dict) -> dict:
    """도우미 자유 질문의 의도를 문구로 고른다. 실제 모델처럼 도움말 항목 안에서만 인용한다."""
    message = payload["message"]
    entries = payload.get("helpEntries", [])
    empty = {"answer": None, "citations": [], "clarificationQuestion": None, "searchQuery": None, "accountTopic": None}
    if "관심 공고" in message or "관심공고" in message:
        return {**empty, "intent": "ACCOUNT_STATE", "accountTopic": "SAVED_PROGRAMS"}
    if "제안" in message:
        return {**empty, "intent": "ACCOUNT_STATE", "accountTopic": "RECEIVED_PROPOSALS"}
    if "내 기업" in message or "기업 등록됐" in message:
        return {**empty, "intent": "ACCOUNT_STATE", "accountTopic": "COMPANY_PROFILE"}
    if "이 공고" in message:
        return {**empty, "intent": "PROGRAM_QUESTION"}
    if "찾아" in message or "검색해" in message:
        query = message.replace("찾아줘", "").replace("찾아 줘", "").replace("검색해줘", "").replace("검색해 줘", "").strip()
        return {**empty, "intent": "SEARCH", "searchQuery": query or message}
    if "날씨" in message:
        return {**empty, "intent": "OUT_OF_SCOPE", "answer": "날씨는 이 도우미가 답할 수 있는 범위가 아닙니다. 지원사업 검색과 화면 사용법을 물어봐 주세요."}
    for entry in entries:
        keyword = entry["question"].replace("?", "").split()[0]
        if keyword and keyword in message:
            return {**empty, "intent": "PRODUCT_HELP", "answer": entry["summary"], "citations": [entry["id"]]}
    return {**empty, "intent": "UNCLEAR", "clarificationQuestion": "어떤 화면의 사용법이 궁금하신가요, 아니면 공고를 찾으시나요?"}


def application_preparation_output(payload: dict) -> dict | None:
    """신청 문서 입력의 한 가지 연결 smoke만 제공하며 자연어 품질을 대신하지 않는다."""
    if payload.get("userMessage") != "업체명은 새봄테크입니다.":
        return None
    options = payload["fieldOptions"]
    allowed = {item["fieldKey"] for item in options}
    if "company-name" not in allowed:
        return None
    answered = {item["fieldKey"] for item in payload["currentFacts"]} | {"company-name"}
    missing = [item["fieldKey"] for item in options if item["required"] and item["fieldKey"] not in answered]
    return {
        "suggestions": [{
            "fieldKey": "company-name",
            "status": "PROVIDED",
            "value": "새봄테크",
            "evidenceQuote": "업체명은 새봄테크",
        }],
        "missingFields": missing,
        "nextQuestion": "다음 필수 정보를 알려주세요." if missing else None,
    }


def application_form_discovery_output(payload: dict) -> dict | None:
    """공식 첨부 문항 발견의 계약 연결만 검증하는 고정 응답입니다."""
    documents = payload.get("documents", [])
    if not documents:
        return None
    document = documents[0]
    block = next((item for item in document.get("blocks", []) if "사업 개요" in item.get("text", "")), None)
    if block is None:
        return {"forms": []}
    return {"forms": [{
        "documentIndex": document["documentIndex"],
        "sections": [{
            "sectionKey": "business-plan",
            "title": "사업 계획",
            "description": "사업 개요를 작성합니다.",
            "fields": [{
                "fieldKey": "business-overview",
                "label": "사업 개요",
                "guidance": "사업의 목적과 내용을 입력합니다.",
                "required": False,
                "evidenceBlockId": block["blockId"],
                "evidenceQuote": "사업 개요",
            }],
        }],
    }]}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.respond(200, {"status": "up"})

    def do_POST(self) -> None:
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.rstrip("/") == "/v1/embeddings":
            inputs = request["input"]
            if isinstance(inputs, str):
                inputs = [inputs]
            if not all(isinstance(value, str) for value in inputs):
                self.respond(400, {"error": {"message": "fixture expects string input"}})
                return
            dimensions = request.get("dimensions", 1536)
            data = []
            for index, value in enumerate(inputs):
                vector = [0.0] * dimensions
                vector[topic(value)] = 1.0
                data.append({"object": "embedding", "index": index, "embedding": vector})
            self.respond(200, {"object": "list", "model": request["model"], "data": data,
                               "usage": {"prompt_tokens": len(inputs), "total_tokens": len(inputs)}})
            return
        if self.path.rstrip("/") == "/v1/responses":
            messages = request["input"]
            if isinstance(messages, str):
                payload = json.loads(messages)
            else:
                user = next(message for message in reversed(messages) if message.get("role") == "user")
                content = user["content"]
                text = content if isinstance(content, str) else "".join(part.get("text", "") for part in content)
                payload = json.loads(text)
            if payload.get("schemaVersion") == "govbiz-assistant-agent-v1":
                kind, output = assistant_agent_output(request, payload)
                if kind == "tool_calls":
                    self.respond_tool_calls(request, output)
                elif isinstance(output, str):
                    self.respond_model_text(request, output)
                else:
                    self.respond_model_output(request, output)
                return
            if payload.get("schemaVersion") == "govbiz-assistant-v1":
                self.respond_model_output(request, assistant_output(payload))
                return
            if payload.get("schemaVersion") == "govbiz-support-program-conversation-v1":
                output = conversation_output(payload)
                if output is None:
                    self.respond(400, {"error": {"message": "unsupported conversation fixture message"}})
                    return
                self.respond_model_output(request, output)
                return
            if payload.get("contractVersion") == "application-preparation-interpret-v1":
                output = application_preparation_output(payload)
                if output is None:
                    self.respond(400, {"error": {"message": "unsupported application preparation fixture message"}})
                    return
                self.respond_model_output(request, output)
                return
            if payload.get("contractVersion") == "application-form-discovery-v1":
                output = application_form_discovery_output(payload)
                if output is None:
                    self.respond(400, {"error": {"message": "unsupported application form discovery fixture"}})
                    return
                self.respond_model_output(request, output)
                return
            # Match the Agent's keyed assessment contract. The production Service
            # attaches program IDs and calculates totals; the model does neither.
            rankings = {}
            for candidate in payload["candidates"]:
                relevant = topic(candidate["title"] + " " + candidate["summary"]) == topic(payload["originalQuery"])
                option_fields = {option["field"] for option in candidate["evidenceOptions"]}
                confirmed = (relevant and not candidate.get("sourceTextTruncated", False)
                             and {"SUMMARY", "TARGET_DESCRIPTION"} <= option_fields)
                rankings[candidate["id"]] = {
                    "semanticRelevance": 40 if relevant else 0,
                    "targetAssessment": {
                        "eligibility": "MATCH" if confirmed else "UNKNOWN",
                        "evidence": [next(option["index"] for option in candidate["evidenceOptions"]
                                          if option["field"] == "TARGET_DESCRIPTION")] if confirmed else [],
                        "explanation": "테스트 대역의 본문 인용이며 실제 자격 판정이 아닙니다." if confirmed else "지원 대상 조건을 확인해야 합니다.",
                    },
                    "regionAssessment": {
                        "eligibility": "MATCH" if confirmed else "UNKNOWN",
                        "evidence": [next(option["index"] for option in candidate["evidenceOptions"]
                                          if option["field"] == "SUMMARY")] if confirmed else [],
                        "explanation": "테스트 대역의 본문 인용이며 실제 자격 판정이 아닙니다." if confirmed else "지역 조건을 확인해야 합니다.",
                    },
                    "supportTypeFit": 10 if relevant else 0,
                    "recommendationReasons": [candidate["title"][:100]],
                }
            self.respond_model_output(request, {"rankings": rankings})
            return
        self.respond(404, {"error": {"message": "unexpected fixture path"}})

    def respond_model_text(self, request: dict, text: str) -> None:
        self.respond(200, {
                "id": "resp_fixture", "created_at": 0, "object": "response", "model": request["model"],
                "error": None, "incomplete_details": None, "status": "completed", "parallel_tool_calls": False,
                "tool_choice": "none", "tools": [], "output": [{"id": "msg_fixture", "type": "message",
                    "role": "assistant", "status": "completed", "content": [{"type": "output_text",
                    "annotations": [], "text": text}]}],
            })

    def respond_tool_calls(self, request: dict, calls: list) -> None:
        self.respond(200, {
                "id": "resp_fixture", "created_at": 0, "object": "response", "model": request["model"],
                "error": None, "incomplete_details": None, "status": "completed", "parallel_tool_calls": True,
                "tool_choice": "auto", "tools": [], "output": [
                    {"id": f"fc_fixture_{index}", "type": "function_call", "call_id": f"call_fixture_{index}", "name": name,
                     "arguments": json.dumps(arguments, ensure_ascii=False), "status": "completed"}
                    for index, (name, arguments) in enumerate(calls)
                ],
            })

    def respond_model_output(self, request: dict, output: dict) -> None:
        self.respond(200, {
                "id": "resp_fixture", "created_at": 0, "object": "response", "model": request["model"],
                "error": None, "incomplete_details": None, "status": "completed", "parallel_tool_calls": False,
                "tool_choice": "none", "tools": [], "output": [{"id": "msg_fixture", "type": "message",
                    "role": "assistant", "status": "completed", "content": [{"type": "output_text",
                    "annotations": [], "text": json.dumps(output, ensure_ascii=False)}]}],
            })

    def respond(self, status: int, value: dict) -> None:
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, _format: str, *_args: object) -> None:
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8002), Handler).serve_forever()
