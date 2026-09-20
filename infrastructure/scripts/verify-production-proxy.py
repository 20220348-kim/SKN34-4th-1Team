#!/usr/bin/env python3
"""실제 Nginx + 로컬 가상 Core만 검증. 기존 Compose/DB/API에는 연결하지 않는다."""
import http.client
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
SECRET = "a" * 64  # 테스트 전용 공개 값


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def main():
    prefix = "govbiz-proxy-test-" + uuid.uuid4().hex[:10]
    containers = []
    network_id = None
    nginx_image = os.environ.get("VERIFY_NGINX_IMAGE", "nginx@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c")
    try:
        network_id = docker("network", "create", prefix)
        containers.append(docker("run", "-d", "--network", prefix, "--network-alias", "core-service",
                                 "--mount", f"type=bind,src={ROOT / 'scripts/proxy-test-server.py'},dst=/server.py,readonly",
                                 "python:3.11-slim-bookworm", "python", "/server.py"))
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
    main()
