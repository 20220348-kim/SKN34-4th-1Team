"""Nginx 전달 계약 검증 전용. 외부 연결 없이 받은 가상 요청을 그대로 반환한다."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json


class Handler(BaseHTTPRequestHandler):
    def handle_request(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        response = json.dumps({"method": self.command, "path": self.path,
                               "headers": dict(self.headers), "body": body}).encode()
        self.send_response(302 if self.path == "/api/redirect" else 200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.send_header("Cache-Control", "public, max-age=3600")
        self.send_header("Set-Cookie", "first=test; Path=/; Secure; HttpOnly; SameSite=Lax")
        self.send_header("Set-Cookie", "second=test; Path=/; Secure; HttpOnly; SameSite=Lax")
        self.send_header("Location", "https://govbiz-test.vercel.app/")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(response)

    do_GET = do_POST = do_DELETE = do_PUT = do_PATCH = do_OPTIONS = do_HEAD = handle_request

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
