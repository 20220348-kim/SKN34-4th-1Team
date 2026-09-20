import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


HOST = "0.0.0.0"
PORT = 8001
SEARCH_PATH = "/1421000/bizinfo/pblancBsnsService"
EXPECTED_QUERY = {
    "serviceKey": ["compose+verification/key="],
    "pageNo": ["1"],
    "numOfRows": ["1000"],
    "dataType": ["json"],
}
fixture = json.loads(Path("response.json").read_text())
body = fixture["response"]["body"]
items = body["items"]["item"]
# The old relevant AI program must be outside the old latest-20 window.
for number in range(1, 26):
    program_id = f"PBLN_COMPOSE_RECENT_{number:02d}"
    items.append({
        **items[0],
        "pblancId": program_id,
        "pblancUrl": f"https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId={program_id}",
        "pblancNm": f"최근 식품 박람회 참가 지원 {number}",
        "bsnsSumryCn": "식품 제조기업의 박람회 전시를 지원합니다.",
        "pldirSportRealmLclasCodeNm": "박람회",
        "trgetNm": "식품 제조기업",
        "hashtags": "식품,전국",
        "updtPnttm": f"2026-07-{number:02d} 10:00:00",
    })
items.append({
    **items[0],
    "pblancId": "PBLN_COMPOSE_OLD_AI",
    "pblancUrl": "https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_COMPOSE_OLD_AI",
    "pblancNm": "서울 AI 기술 사업화 지원",
    "bsnsSumryCn": "서울 인공지능 창업기업의 기술 사업화를 지원합니다.",
    "pldirSportRealmLclasCodeNm": "AI",
    "trgetNm": "서울 AI 창업기업",
    "hashtags": "AI,서울",
    "updtPnttm": "2020-01-01 10:00:00",
})
body["totalCount"] = len(items)
RESPONSE_BODY = json.dumps(fixture, ensure_ascii=False).encode("utf-8")


class BizInfoStubHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        request = urlparse(self.path)

        if request.path == "/health":
            self._respond(200, b'{"status":"up"}')
            return

        if request.path != SEARCH_PATH:
            self._respond(404, b'{"error":"unexpected path"}')
            return

        query = parse_qs(request.query, keep_blank_values=True)
        if any(query.get(name) != value for name, value in EXPECTED_QUERY.items()):
            body = json.dumps(
                {"error": "unexpected query", "receivedParameters": sorted(query)},
                ensure_ascii=False,
            ).encode("utf-8")
            self._respond(400, body)
            return

        self._respond(200, RESPONSE_BODY)

    def log_message(self, _format: str, *_args: object) -> None:
        # Never print the request target because its query contains serviceKey.
        print(f"{self.address_string()} - request handled", flush=True)

    def _respond(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), BizInfoStubHandler).serve_forever()
