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
            payload = json.loads(data)
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


def main(web_image=None):
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
        if web_image:
            containers.append(docker("run", "-d", "--network", prefix, "--network-alias", "ops-service",
                                     "--mount", f"type=bind,src={ROOT / 'scripts/proxy-test-server.py'},dst=/server.py,readonly",
                                     "-e", "STUB_PORT=8000", "-e", "STUB_UPSTREAM=ops",
                                     "--entrypoint", "python", stub_image, "/server.py"))
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

        def call(method="GET", path="/api/test", secret=SECRET, body=None, client_ip="203.0.113.20"):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
            headers = {"X-Govbiz-Proxy-Secret": secret, "X-Govbiz-Client-IP": client_ip,
                       "X-Forwarded-For": "1.2.3.4", "Forwarded": "for=1.2.3.4",
                       "Origin": "https://govbiz-test.vercel.app", "Cookie": "session=test",
                       "Content-Type": "application/json"}
            if web_image:
                headers.update({"Host": "localhost:18173", "Origin": "http://localhost:18173",
                                "X-CSRFToken": "csrf-test", "X-Forwarded-Host": "forged.invalid",
                                "X-Forwarded-Proto": "https", "X-Forwarded-Port": "443", "X-Real-IP": "1.2.3.4"})
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            result = response.status, response.getheaders(), response.read()
            connection.close()
            return result

        for attempt in range(45):
            try:
                if call()[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(1)
        else:
            raise RuntimeError("Nginx/stub startup failed: " + docker("logs", containers[-1]) + docker("logs", containers[0]))
        if web_image:
            verify_web(call)
            docker("stop", "--time", "1", containers[1])
            status, headers, data = call(path="/api/v1/ops/session")
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
    parser.add_argument("--web-image", help="Test a built Kubernetes web image instead of the AWS proxy")
    main(parser.parse_args().web_image)
