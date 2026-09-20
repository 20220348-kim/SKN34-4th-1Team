"""에이전트 평가용 가짜 Core 도구 서버와 가짜 근거 검색. 모델만 실제로 부르고 회원 자료·원문 청크는 여기 고정값이다.

가상 회사(서울, 정보통신업, PARTICIPANT, 라벨링)·모집글 2건·관심 공고 3건(원문 2건)은 AI가 만든 예시이며 실제 자료가 아니다.
"""

from hashlib import sha256

import httpx

from app.assistant_agent.retriever import RetrievedChunk

SECRET = "assistant-eval-secret-0123456789abcdef0123456789"
TOKEN = "7.1900000000.eval"
ACCOUNT_ID = 7

COMPANY_PROFILE = {
    "registered": True, "companyName": "데이터브릿지 주식회사", "region": "서울특별시", "industry": "정보통신업", "foundedYear": 2021,
    "roles": ["PARTICIPANT"], "interestAreas": ["AI", "데이터"], "introduction": "데이터 구축과 라벨링 운영을 합니다.", "capabilities": ["라벨링", "데이터 구축"],
}
RECRUITMENTS = [
    {
        "id": 21, "title": "AI 실증 참여기관 구합니다", "companyName": "서울AI 주식회사", "companyRegion": "서울특별시", "companyIndustry": "정보통신업",
        "ownRole": "LEAD", "seekingRole": "PARTICIPANT", "seekingCount": 1, "region": "서울", "minimumCompanyAgeYears": None,
        "capabilities": ["라벨링"], "recruitmentDeadline": "2026-09-20", "programTitle": "서울 AI 실증 지원사업",
        "programApplicationEndDate": "2026-09-30", "body": "라벨링 운영을 맡아 주실 참여기관을 찾습니다.",
    },
    {
        "id": 22, "title": "스마트공장 참여기관 모집", "companyName": "경기제조 주식회사", "companyRegion": "경기도", "companyIndustry": "제조업",
        "ownRole": "LEAD", "seekingRole": "PARTICIPANT", "seekingCount": 2, "region": "경기", "minimumCompanyAgeYears": 3,
        "capabilities": ["PLC"], "recruitmentDeadline": "2026-09-25", "programTitle": "스마트공장 고도화",
        "programApplicationEndDate": None, "body": "PLC 경험이 있는 참여기관을 찾습니다.",
    },
]
SAVED_PROGRAMS = [
    {"sourceCode": "BIZINFO", "sourceProgramId": "PBLN_000000000000001", "title": "서울 AI 실증 지원사업", "organization": "서울경제진흥원",
     "applicationEndDate": "2026-09-30", "status": "OPEN", "documentId": "BIZINFO:PBLN_000000000000001"},
    {"sourceCode": "BIZINFO", "sourceProgramId": "PBLN_000000000000002", "title": "경기 데이터 바우처", "organization": "경기도",
     "applicationEndDate": "2026-10-10", "status": "OPEN", "documentId": "BIZINFO:PBLN_000000000000002"},
    {"sourceCode": "BIZINFO", "sourceProgramId": "PBLN_000000000000003", "title": "부산 창업 지원", "organization": "부산광역시",
     "applicationEndDate": "2026-10-15", "status": "OPEN", "documentId": None},
]
RECRUITMENT_IDS = {str(item["id"]) for item in RECRUITMENTS}
SAVED_PROGRAM_IDS = {f"{item['sourceCode']}:{item['sourceProgramId']}" for item in SAVED_PROGRAMS}

_CHUNK_TEXTS = {
    "BIZINFO:PBLN_000000000000001": [
        "신청방법: 기업마당 온라인 신청 후 사업계획서를 제출합니다. 접수 마감은 2026년 9월 30일 18시입니다.",
        "제출서류: 사업계획서(지정 양식), 사업자등록증 사본, 최근 2개년 재무제표.",
        "지원대상: 서울 소재 AI 분야 중소기업으로 설립 7년 이내 기업.",
    ],
    "BIZINFO:PBLN_000000000000002": [
        "신청방법: 경기도청 방문 접수만 가능하며 온라인 접수는 받지 않습니다.",
        "제출서류: 신청서 1부, 사업자등록증 사본.",
    ],
}


def _chunk(document_id: str, order: int, text: str) -> RetrievedChunk:
    return RetrievedChunk(
        id=sha256(f"{document_id}:{order}".encode()).hexdigest(), content_hash=sha256(text.encode("utf-8")).hexdigest(),
        order=order, text=text, score=0.9 - order * 0.1,
    )


CHUNKS = {document_id: [_chunk(document_id, order, text) for order, text in enumerate(texts)] for document_id, texts in _CHUNK_TEXTS.items()}


def saved_program_documents() -> list[dict]:
    """Core가 두 번째 호출에 싣는 것과 같은 모양. 세 번째 공고는 원문 미수집(청크 없음)이다."""
    return [
        {
            "sourceCode": item["sourceCode"], "sourceProgramId": item["sourceProgramId"], "title": item["title"],
            "applicationEndDate": item["applicationEndDate"], "documentId": f"{item['sourceCode']}:{item['sourceProgramId']}",
            "chunks": [{"id": chunk.id, "contentHash": chunk.content_hash} for chunk in CHUNKS.get(f"{item['sourceCode']}:{item['sourceProgramId']}", [])],
        }
        for item in SAVED_PROGRAMS
    ]


def chunk_texts() -> dict[str, list[str]]:
    return dict(_CHUNK_TEXTS)


class FakeCoreTools:
    """httpx MockTransport 핸들러. 공유 비밀·토큰·계정을 검사하고 고정 자료를 돌려준다."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.headers.get("X-Internal-Token") != SECRET or request.headers.get("X-Assistant-Tool-Token") != TOKEN:
            return httpx.Response(401, json={"code": "ASSISTANT_TOOL_UNAUTHORIZED"})
        if request.url.params.get("accountId") != str(ACCOUNT_ID):
            return httpx.Response(401, json={"code": "ASSISTANT_TOOL_UNAUTHORIZED"})
        path = request.url.path
        if path.endswith("/company-profile"):
            return httpx.Response(200, json=COMPANY_PROFILE)
        if path.endswith("/recruitments"):
            region = request.url.params.get("region")
            return httpx.Response(200, json=[item for item in RECRUITMENTS if not region or item["region"] in region or region in item["region"]])
        if path.endswith("/saved-programs"):
            return httpx.Response(200, json=SAVED_PROGRAMS)
        return httpx.Response(404, json={"code": "NOT_FOUND"})


class FakeRetriever:
    async def retrieve(self, question: str, documents, per_document_limit: int) -> dict[str, list[RetrievedChunk]]:
        return {
            document.document_id: CHUNKS[document.document_id][:per_document_limit]
            for document in documents if document.chunks and document.document_id in CHUNKS
        }
