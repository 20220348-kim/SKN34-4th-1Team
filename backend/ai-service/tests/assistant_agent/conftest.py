import pytest

from app.assistant_agent.models import SCHEMA_VERSION


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def help_entries():
    return [
        {
            "id": "search-score-meaning",
            "title": "점수는 무엇을 뜻하나요",
            "question": "점수는 무슨 뜻인가요?",
            "summary": "점수는 검색어와 공고의 관련도입니다. 신청 자격이나 선정 가능성을 뜻하지 않습니다.",
            "body": ["점수는 결과의 순서를 정하기 위한 값이며 선정될 가능성이 아닙니다."],
            "limitation": "선정 가능성이나 합격률은 제공하지 않습니다.",
            "audience": "public",
            "status": "available",
            "action": {"label": "검색 화면 열기", "to": "/app/chat"},
        },
        {
            "id": "partner-write-requires-company",
            "title": "모집글을 쓰려면 기업 등록이 필요합니다",
            "question": "모집글은 왜 못 쓰나요?",
            "summary": "모집글 작성과 제안 보내기는 기업을 등록한 회원만 할 수 있습니다.",
            "body": [],
            "limitation": None,
            "audience": "member",
            "status": "available",
            "action": {"label": "기업 등록하기", "to": "/app/profile"},
        },
    ]


@pytest.fixture
def principal():
    return {"accountId": 7, "toolToken": "7.1900000000.sig", "hasCompany": True}


@pytest.fixture
def request_data(help_entries, principal):
    return {
        "schemaVersion": SCHEMA_VERSION,
        "message": "나한테 맞는 파트너 모집글 있어?",
        "history": [],
        "session": {"authenticated": True, "hasCompany": True},
        "context": {"route": "/app/chat", "programSelected": False},
        "helpEntries": help_entries,
        "principal": principal,
    }


@pytest.fixture
def empty_classification():
    return {"answer": None, "citations": [], "clarificationQuestion": None, "searchQuery": None, "accountTopic": None}
