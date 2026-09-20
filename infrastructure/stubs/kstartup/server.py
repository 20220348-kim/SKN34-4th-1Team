"""Deterministic K-Startup HTTP fixture; never call the public upstream API."""

import json
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


HOST = "0.0.0.0"
PORT = 8003
SEARCH_PATH = "/B552735/kisedKstartupService01/getAnnouncementInformation01"
SEOUL = timezone(timedelta(hours=9))
EXPECTED_KEY = "compose+startup/verification="
TODAY = datetime.now(SEOUL).date()
START_DATE = (TODAY - timedelta(days=30)).strftime("%Y%m%d")
PROGRAMS = [
    {
        # id is deliberately different: the source identity must use pbanc_sn.
        "id": 1,
        "pbanc_sn": 174321,
        "biz_pbanc_nm": "Compose 서울 AI 창업기업 시제품 제작 지원",
        "pbanc_ntrp_nm": "Compose 창업 검증기관",
        "pbanc_ctnt": "<p>서울 AI 창업기업의 시제품 제작 비용을 지원합니다.</p>",
        "aply_trgt_ctnt": "서울 소재 창업 3년 미만 기업",
        "aply_excl_trgt_ctnt": "금융기관 채무불이행 중인 기업 제외",
        "aply_trgt": "일반인,대학생",
        "biz_enyy": "3년미만",
        "biz_trgt_age": "만 39세 이하",
        "supt_biz_clsfc": "사업화",
        "supt_regin": "서울특별시",
        "pbanc_rcpt_bgng_dt": START_DATE,
        "pbanc_rcpt_end_dt": "20990911",
        "rcrt_prgs_yn": "Y",
        "detl_pg_url": "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=174321&schM=view",
    },
    {
        "id": 2,
        "pbanc_sn": "174322",
        "biz_pbanc_nm": "Compose 부산 식품 창업기업 교육",
        "pbanc_ntrp_nm": "Compose 창업 검증기관",
        "pbanc_ctnt": "<p>부산 식품 창업기업에 품질관리 교육을 제공합니다.</p>",
        "aply_trgt_ctnt": "부산 소재 창업 3년 이상 7년 미만 기업",
        "aply_excl_trgt_ctnt": "휴업 중인 기업 제외",
        "aply_trgt": "일반기업",
        "biz_enyy": "3년~7년미만",
        "biz_trgt_age": "만 40세 이상",
        "supt_biz_clsfc": "창업교육",
        "supt_regin": "부산광역시",
        "pbanc_rcpt_bgng_dt": START_DATE,
        "pbanc_rcpt_end_dt": "20990911",
        "rcrt_prgs_yn": "Y",
        "detl_pg_url": "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=174322&schM=view",
    },
]


def expected_query() -> dict[str, list[str]]:
    today = datetime.now(SEOUL).date()
    try:
        boundary = today.replace(year=today.year - 1)
    except ValueError:
        boundary = today.replace(year=today.year - 1, day=28)
    return {
        "serviceKey": [EXPECTED_KEY],
        "page": ["1"],
        "perPage": ["1000"],
        "returnType": ["JSON"],
        "cond[pbanc_rcpt_bgng_dt::GTE]": [boundary.strftime("%Y%m%d")],
    }


class KStartupStubHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        request = urlparse(self.path)
        if request.path == "/health":
            self._respond(200, {"status": "up"})
        elif request.path != SEARCH_PATH:
            self._respond(404, {"error": "unexpected path"})
        elif parse_qs(request.query, keep_blank_values=True) != expected_query():
            # Never echo the URL, serviceKey, or other incoming parameter values.
            self._respond(400, {"error": "unexpected query"})
        else:
            self._respond(200, {
                "currentCount": len(PROGRAMS), "matchCount": len(PROGRAMS),
                "totalCount": len(PROGRAMS), "page": 1, "perPage": 1000, "data": PROGRAMS,
            })

    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def _respond(self, status: int, value: dict) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), KStartupStubHandler).serve_forever()
