"""Offline public-notice fixtures, not live API or recruitment-quality verification.

MSIT follows the observed split-envelope response. CNTRADE_NOTICE follows the
data.go.kr 15097093 documentation; a successful live response was not verified.
"""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


HOST = "0.0.0.0"
PORT = 8004
MSIT_PATH = "/1721000/msitannouncementinfo/businessAnnouncMentList"
CNTRADE_PATH = "/6440000/CnTradeNotice/getNotiList"
EXPECTED_KEY = "compose+notice/verification="
MSIT_PROGRAMS = [
    {
        "deptName": "Compose 과학기술 검증기관",
        "pressDt": "2026-09-09",
        "subject": "Compose AI 기술개발 사업공고",
        "viewUrl": "https://www.msit.go.kr/bbs/view.do?sCode=user&mId=311&mPid=121&bbsSeqNo=100&nttSeqNo=3186878",
        # Attachments deliberately are not fetched or treated as eligibility text.
        "files": [{"file": {"fileName": "검증 공고.hwp", "fileUrl": "https://must-not-fetch.invalid/notice.hwp"}}],
    },
    *[
        {
            "deptName": "Compose 과학기술 검증기관",
            "pressDt": "2026-09-08",
            "subject": f"Compose 일반 연구사업 안내 {number}",
            "viewUrl": f"https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&nttSeqNo={3186800 + number}",
            "files": [],
        }
        for number in range(1, 11)
    ],
]
CNTRADE_NOTICES = [
    {
        "lbbNo": 900001,
        "title": "Compose AI 기업 수출지원 참가 안내",
        "orgNm": "Compose 수출 검증기관",
        "cont": "<p>AI 기업의 해외 전시 참가를 지원합니다. 지원 대상과 접수 기간은 개별 공고문을 확인해 주세요.</p>",
        "sregDtm": "2026-09-09",
        "smodifyDtm": "2026-09-09",
    },
    {
        "lbbNo": 900002,
        "title": "Compose 수출입 시스템 일반 안내",
        "orgNm": "Compose 수출 검증기관",
        "cont": "<p>시스템 이용 안내입니다. 모집공고가 아닙니다.</p>",
        "sregDtm": "2026-09-08",
        "smodifyDtm": "2026-09-09",
    },
]


def response_for(path: str, query: dict[str, list[str]]) -> tuple[int, dict]:
    if path == "/health":
        return 200, {"status": "up"}
    if path not in (MSIT_PATH, CNTRADE_PATH):
        return 404, {"error": "unexpected path"}
    page_value = query.get("pageNo", [])
    if page_value not in (["1"], ["2"]):
        return 400, {"error": "unexpected page"}
    page = int(page_value[0])
    expected = {"serviceKey": [EXPECTED_KEY], "pageNo": [str(page)]}
    if path == MSIT_PATH:
        expected.update({"numOfRows": ["10"], "returnType": ["json"]})
    else:
        expected.update({"numOfRows": ["1000"]})
    if query != expected:
        # Never echo incoming keys, request URLs or untrusted parameter values.
        return 400, {"error": "unexpected query"}
    if path == MSIT_PATH:
        items = MSIT_PROGRAMS[(page - 1) * 10:page * 10]
        return 200, {"response": [
            {"header": {"resultCode": "00", "resultMsg": "NORMAL_CODE"}},
            {"body": {"pageNo": str(page), "totalCount": len(MSIT_PROGRAMS), "numOfRows": 10,
                      "items": [{"item": item} for item in items]}},
        ]}
    # Deliberately return one row per page despite the requested size, to check
    # completeness using the documented response metadata rather than assumptions.
    return 200, {"resultCode": "09", "resultMsg": "RETURN_SUCCESS", "pageNo": page,
                 "numOfRows": 1, "totalCount": len(CNTRADE_NOTICES), "items": CNTRADE_NOTICES[page - 1:page]}


class PublicNoticeStubHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        request = urlparse(self.path)
        status, value = response_for(request.path, parse_qs(request.query, keep_blank_values=True))
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        pass


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), PublicNoticeStubHandler).serve_forever()
