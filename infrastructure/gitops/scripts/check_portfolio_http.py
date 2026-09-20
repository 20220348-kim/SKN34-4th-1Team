"""Read-only HTTP checks through the loopback web -> Kubernetes Core connection.

Run the documented port-forward and `pnpm dev:k8s` first. Never uses cookies,
host .env files, external HTTP proxies, redirects, mutation or paid AI endpoints.
"""
import json
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

ORIGIN = "http://localhost:5173"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get(path):
    opener = build_opener(ProxyHandler({}), NoRedirect())
    accept = "text/html" if path.startswith("/?") else "application/json"
    request = Request(ORIGIN + path, headers={"Accept": accept, "Origin": ORIGIN})
    try:
        response = opener.open(request, timeout=10)
    except HTTPError as error:
        response = error
    with response:
        body = response.read(1_048_577)
        if len(body) > 1_048_576:
            raise ValueError("Response exceeds the smoke-check limit")
        return response.status, body


def check(request=get):
    status, body = request("/?mode=filter")
    if status != 200 or b'<div id="root">' not in body:
        raise ValueError("Frontend HTML is not available")
    status, body = request("/api/v1/health")
    if status != 200 or json.loads(body).get("status") != "up":
        raise ValueError("Core health through web proxy failed")
    status, body = request("/api/v1/support-programs/catalog?page=1&pageSize=12&status=ALL")
    catalog = json.loads(body)
    if status != 200 or not isinstance(catalog.get("programs"), list) or type(catalog.get("total")) is not int:
        raise ValueError("Public catalog response contract failed")
    status, _ = request("/api/v1/auth/me")
    if status != 401:
        raise ValueError("Anonymous session request must be rejected with 401")
    print(f"PASS: frontend HTML, Core health, catalog total={catalog['total']}, anonymous session 401")
    print("No real-data quality, signup/mail, social login or paid AI validation was performed.")


if __name__ == "__main__":
    check()
