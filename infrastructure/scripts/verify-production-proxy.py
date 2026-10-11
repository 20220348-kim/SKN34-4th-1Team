#!/usr/bin/env python3
"""실제 Nginx + 가상 Core/Ops 검증. 기존 Compose/DB/API에는 연결하지 않는다."""
import http.client
import json
import os
import re
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SECRET = "a" * 64  # 테스트 전용 공개 값


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def wait_for_upstreams(call, upstreams):
    for path, upstream in upstreams:
        for _ in range(45):
            try:
                status, _, data = call(path=path)
                last_response = f"{path}: HTTP {status}, body={data[:200]!r}"
                if status == 200:
                    payload = json.loads(data)
                    if isinstance(payload, dict) and all(payload.get(key) == value for key, value in {
                        "upstream": upstream, "method": "GET", "path": path, "body": "",
                    }.items()):
                        break
            except (OSError, http.client.HTTPException, ValueError) as error:
                last_response = f"{path}: {type(error).__name__}: {error}"
            time.sleep(1)
        else:
            raise RuntimeError(f"Nginx/{upstream} stub startup failed: {last_response}")


def verify_web(call):
    status, headers, index = call(path="/")
    assert status == 200 and b'<div id="root">' in index
    assert dict(headers)["Cache-Control"] == "private, no-store"
    for path in ("/login", "/ops/evaluations", "/app/chat"):
        assert call(path=path)[2] == index
    asset = re.search(rb'\bsrc="(/assets/[^\"]+\.js)"', index).group(1).decode()
    status, headers, bundle = call(path=asset)
    assert status == 200 and bundle != index
    assert "immutable" in dict(headers)["Cache-Control"]
    assert call(path="/assets/missing.js")[0] == 404
    assert call(path="/api")[0] == 404
    assert call(path="/healthz")[0] == 200
    for path, upstream in (("/api/v1/account", "core"), ("/api/v1/ops", "ops"),
                           ("/api/v1/ops/session", "ops"), ("/api/v1/ops-other", "core"),
                           ("/api/v1/application-preparations/1/documents", "core")):
        for method in ("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
            status, headers, data = call(method, path + "?q=%EC%84%9C%EC%9A%B8", body='{"test":true}')
            assert status == 200, f"{method} {path}: HTTP {status}, body={data[:200]!r}"
            try:
                payload = json.loads(data)
            except ValueError as error:
                raise AssertionError(f"{method} {path}: expected stub JSON, body={data[:200]!r}") from error
            received = {k.lower(): v for k, v in payload["headers"].items()}
            assert status == 200 and payload["upstream"] == upstream
            assert payload["path"] == path + "?q=%EC%84%9C%EC%9A%B8"
            assert payload["method"] == method and payload["body"] == '{"test":true}'
            assert received["host"] == "localhost:18173"
            assert received["origin"] == "http://localhost:18173"
            assert received["cookie"] == "session=test" and received["x-csrftoken"] == "csrf-test"
            assert received["x-forwarded-for"] != "1.2.3.4" and received["x-forwarded-proto"] == "http"
            assert all(k not in received for k in ("forwarded", "x-real-ip", "x-forwarded-host",
                       "x-forwarded-port", "x-govbiz-proxy-secret", "x-govbiz-client-ip"))
            assert [v for k, v in headers if k.lower() == "cache-control"] == ["private, no-store"]
            assert len([v for k, v in headers if k.lower() == "set-cookie"]) == 2
    for path in ("/api/not-found", "/api/v1/ops/not-found"):
        status, _, data = call(path=path)
        assert status == 404 and data != index
    large_body = json.dumps({"snapshot": "x" * 2_000_000})
    assert json.loads(call("PUT", "/api/v1/chat-conversations/test", body=large_body)[2])["body"] == large_body
    assert call("POST", "/api/test", body="x" * (2 * 1024 * 1024 + 1))[0] == 413
    status, headers, _ = call(path="/api/redirect")
    assert status == 302 and dict(headers)["Location"] == "https://govbiz-test.vercel.app/"
    assert call("HEAD", "/")[0] == 200
    print("Web image passed: SPA/assets, Core/Ops routing, body/query, Host/Origin/CSRF/cookies, no API cache/fallback, non-root read-only runtime")


def verify_eks_gateway(call):
    for path in ("/api/v1/ops", "/api/v1/ops/session", "/api/v1/account",
                 "/api/v1/application-preparations/1/documents"):
        assert call(path=path, secret="")[0] == 403
        assert call(path=path, secret="forged")[0] == 403
        assert call(path=path, client_ip="")[0] == 400
    for path, upstream in (("/api/v1/ops", "ops"), ("/api/v1/ops/session", "ops"),
                           ("/api/v1/ops-other", "core"), ("/api/v1/account", "core"),
                           ("/api/v1/application-preparations/1/documents", "core")):
        for method in ("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
            query_path = path + "?q=%EC%84%9C%EC%9A%B8"
            status, headers, data = call(method, query_path, body='{"test":true}')
            assert status == 200, (method, path, status, data[:200])
            payload = json.loads(data)
            received = {k.lower(): v for k, v in payload["headers"].items()}
            assert payload["upstream"] == upstream
            assert payload["path"] == query_path and payload["body"] == '{"test":true}'
            assert payload["method"] == method
            assert received["host"] == ("ops-service:8000" if upstream == "ops" else "core-service:8080")
            assert received["origin"] == "https://govbiz-test.vercel.app"
            assert received["cookie"] == "session=test" and received["x-csrftoken"] == "csrf-test"
            assert received["authorization"] == "Bearer test-session"
            assert received["x-forwarded-for"] == "203.0.113.20"
            assert received["x-forwarded-proto"] == "https"
            assert all(k not in received for k in ("forwarded", "x-real-ip", "x-forwarded-host",
                       "x-forwarded-port", "x-govbiz-proxy-secret", "x-govbiz-client-ip"))
            assert [v for k, v in headers if k.lower() == "cache-control"] == ["private, no-store"]
            assert len([v for k, v in headers if k.lower() == "set-cookie"]) == 2
    for path in ("/", "/api", "/internal/v1/health", "/admin/", "/api/v1/ops/not-found"):
        assert call(path=path)[0] == 404, path
    assert call(path="/healthz")[0] == 200
    assert call("HEAD", "/api/v1/ops/session")[0] == 200
    large_body = json.dumps({"snapshot": "x" * 2_000_000})
    assert json.loads(call("PUT", "/api/v1/chat-conversations/test", body=large_body)[2])["body"] == large_body
    assert call("POST", "/api/test", body="x" * (2 * 1024 * 1024 + 1))[0] == 413
    print("EKS gateway passed: secret rejection, Core/Ops routing, CSRF/cookies/body, private cache, size limits")


def main(web_image=None, eks_gateway=False):
    prefix = "govbiz-proxy-test-" + uuid.uuid4().hex[:10]
    containers = []
    network_id = None
    nginx_image = os.environ.get("VERIFY_NGINX_IMAGE", "nginx@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c")
    try:
        network_id = docker("network", "create", prefix)
        stub_image = os.environ.get("VERIFY_STUB_IMAGE", "python:3.11-slim-bookworm")
        containers.append(docker("run", "-d", "--network", prefix, "--network-alias", "core-service",
                                 "--mount", f"type=bind,src={ROOT / 'scripts/proxy-test-server.py'},dst=/server.py,readonly",
                                 "--entrypoint", "python", stub_image, "/server.py"))
        if web_image or eks_gateway:
            containers.append(docker("run", "-d", "--network", prefix, "--network-alias", "ops-service",
                                     "--mount", f"type=bind,src={ROOT / 'scripts/proxy-test-server.py'},dst=/server.py,readonly",
                                     "-e", "STUB_PORT=8000", "-e", "STUB_UPSTREAM=ops",
                                     "--entrypoint", "python", stub_image, "/server.py"))
        if eks_gateway:
            containers.append(docker("run", "-d", "--network", prefix, "-p", "127.0.0.1::8080",
                                     "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                                     "--user", "101:101", "--memory", "128m", "--cpus", "1",
                                     "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m,uid=101,gid=101",
                                     "-e", f"GOVBIZ_PROXY_SECRET={SECRET}",
                                     "--mount", f"type=bind,src={ROOT / 'eks/api-gateway'},dst=/etc/govbiz,readonly",
                                     "--entrypoint", "/bin/sh", nginx_image, "/etc/govbiz/start.sh"))
        elif web_image:
            containers.append(docker("run", "-d", "--network", prefix, "-p", "127.0.0.1::8080",
                                     "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                                     "--user", "101:101", "--memory", "128m", "--cpus", "1",
                                     "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m", web_image))
        else:
            containers.append(docker("run", "-d", "--network", prefix, "-p", "127.0.0.1::8080",
                                 "-e", f"GOVBIZ_PROXY_SECRET={SECRET}",
                                 "-e", "NGINX_ENVSUBST_FILTER=^GOVBIZ_PROXY_SECRET$",
                                 "--mount", f"type=bind,src={ROOT / 'nginx/default.conf.template'},dst=/etc/nginx/templates/default.conf.template,readonly",
                                 "--mount", f"type=bind,src={ROOT / 'nginx/15-validate-secret.sh'},dst=/docker-entrypoint.d/15-validate-secret.sh,readonly",
                                 nginx_image))
        for _ in range(15):
            inspected = json.loads(docker("inspect", containers[-1]))[0]
            bindings = inspected["NetworkSettings"]["Ports"].get("8080/tcp")
            if bindings:
                break
            if not inspected["State"]["Running"]:
                raise RuntimeError("Nginx exited: " + docker("logs", containers[-1]))
            time.sleep(1)
        if not bindings:
            raise RuntimeError("Nginx host port was not assigned")
        port = int(bindings[0]["HostPort"])

        def call(method="GET", path="/api/test", secret=SECRET, body=None, client_ip="203.0.113.20", timeout=3):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
            headers = {"X-Govbiz-Proxy-Secret": secret, "X-Govbiz-Client-IP": client_ip,
                       "X-Forwarded-For": "1.2.3.4", "Forwarded": "for=1.2.3.4",
                       "Origin": "https://govbiz-test.vercel.app", "Cookie": "session=test",
                       "Content-Type": "application/json"}
            if web_image:
                headers.update({"Host": "localhost:18173", "Origin": "http://localhost:18173",
                                "X-CSRFToken": "csrf-test", "X-Forwarded-Host": "forged.invalid",
                                "X-Forwarded-Proto": "https", "X-Forwarded-Port": "443", "X-Real-IP": "1.2.3.4"})
            if eks_gateway:
                headers.update({"X-CSRFToken": "csrf-test", "Authorization": "Bearer test-session",
                                "X-Forwarded-Proto": "http", "X-Forwarded-Host": "forged.invalid",
                                "X-Forwarded-Port": "80", "X-Real-IP": "1.2.3.4"})
            try:
                connection.request(method, path, body=body, headers=headers)
                response = connection.getresponse()
                return response.status, response.getheaders(), response.read()
            finally:
                connection.close()

        upstreams = [("/api/test", "core")]
        if web_image or eks_gateway:
            upstreams.append(("/api/v1/ops/session", "ops"))
        try:
            wait_for_upstreams(call, upstreams)
        except RuntimeError as error:
            logs = "\n".join(docker("logs", container_id) for container_id in containers)
            raise RuntimeError(f"{error}\n{logs}") from error
        if eks_gateway:
            verify_eks_gateway(call)
            docker("stop", "--time", "1", containers[1])
            assert call(path="/api/v1/ops/session", timeout=10)[0] in (502, 504)
            assert call(path="/api/v1/account")[0] == 200
            print("Ops outage remains an error; Core does not receive the Ops request")
            return
        if web_image:
            verify_web(call)
            docker("stop", "--time", "1", containers[1])
            # A stopped Docker endpoint can time out instead of refusing the
            # connection. Outlast Nginx's 3s connect timeout to inspect its error.
            status, headers, data = call(path="/api/v1/ops/session", timeout=10)
            assert status in (502, 504) and b'<div id="root">' not in data
            assert dict(headers)["Cache-Control"] == "private, no-store"
            assert call(path="/")[0] == 200
            print("Ops outage remains an API error; static web stays available")
            return
        assert call(secret="")[0] == 403
        assert call(secret="forged")[0] == 403
        assert call(path="/internal/v1/health")[0] == 404
        assert call(path="/nginx-health")[0] == 404
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]:
            status, response_headers, data = call(method, "/api/test?query=%EC%84%9C%EC%9A%B8", body='{"test":true}')
            payload = json.loads(data)
            received = {key.lower(): value for key, value in payload["headers"].items()}
            assert status == 200 and payload["method"] == method
            assert payload["path"] == "/api/test?query=%EC%84%9C%EC%9A%B8" and payload["body"] == '{"test":true}'
            assert received["x-forwarded-for"] == "203.0.113.20" and received["x-forwarded-proto"] == "https"
            assert received["origin"] == "https://govbiz-test.vercel.app" and received["cookie"] == "session=test"
            assert "forwarded" not in received and "x-govbiz-proxy-secret" not in received
            assert "x-govbiz-client-ip" not in received
            assert [v for k, v in response_headers if k.lower() == "cache-control"] == ["private, no-store"]
            assert len([v for k, v in response_headers if k.lower() == "set-cookie"]) == 2
        assert call("HEAD")[0] == 200
        # The longer document route must inherit the same authentication and header boundary.
        document_path = "/api/v1/application-preparations/1/documents"
        assert call("POST", document_path, secret="")[0] == 403
        assert call("POST", document_path, secret="forged")[0] == 403
        assert call("POST", document_path, client_ip="")[0] == 400
        status, response_headers, data = call("POST", document_path, body='{"expectedRevision":3}')
        payload = json.loads(data)
        received = {key.lower(): value for key, value in payload["headers"].items()}
        assert status == 200 and payload["path"] == document_path and payload["method"] == "POST"
        assert payload["body"] == '{"expectedRevision":3}'
        assert received["x-forwarded-for"] == "203.0.113.20" and received["cookie"] == "session=test"
        assert "x-govbiz-proxy-secret" not in received and "x-govbiz-client-ip" not in received
        assert [v for k, v in response_headers if k.lower() == "cache-control"] == ["private, no-store"]
        # Core의 대화 snapshot 상한(2,000,000 bytes)을 프록시가 먼저 잘라내면 안 된다.
        large_body = json.dumps({"snapshot": "x" * 2_000_000})
        status, _, data = call("PUT", "/api/v1/chat-conversations/test", body=large_body)
        assert status == 200 and json.loads(data)["body"] == large_body
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        connection.request("POST", "/api/test", headers={"Content-Length": str(2 * 1024 * 1024 + 1),
                           "X-Govbiz-Proxy-Secret": SECRET, "X-Govbiz-Client-IP": "203.0.113.20"})
        response = connection.getresponse()
        assert response.status == 413
        response.read()
        connection.close()
        status, headers, _ = call(path="/api/redirect")
        assert status == 302 and dict(headers)["Location"] == "https://govbiz-test.vercel.app/"
        print("Nginx 검증 통과: 우회 차단, IP 정규화, 7개 메서드, 쿼리/body, 2MB 대화/크기 제한, 다중 쿠키, 캐시 금지, 리다이렉트")
    finally:
        # 이 실행에서 반환받은 정확한 ID만 제거한다. 기존 자원/volume/prune은 사용하지 않는다.
        for container_id in reversed(containers):
            subprocess.run(["docker", "rm", "-f", container_id], check=True, stdout=subprocess.DEVNULL)
        if network_id:
            subprocess.run(["docker", "network", "rm", network_id], check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--web-image", help="Test a built Kubernetes web image instead of the AWS proxy")
    mode.add_argument("--eks-gateway", action="store_true", help="Test the isolated EKS API gateway")
    args = parser.parse_args()
    main(args.web_image, args.eks_gateway)
