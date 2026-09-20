#!/usr/bin/env python3
"""설정만 읽는 운영 배포 사전 검사. 컨테이너/AWS/API를 시작하지 않고 비밀값을 출력하지 않는다."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys

COMPOSE = Path(__file__).resolve().parents[1] / "compose.prod.yaml"


def validate(config):
    services = config["services"]
    errors = []
    if set(services) != {"nginx", "core-service", "ai-service", "elasticsearch", "qdrant", "redis", "rabbitmq"}:
        errors.append("운영 서비스 구성이 다릅니다. 개발 Compose와 병합하지 마세요.")
        return errors
    core = services["core-service"]["environment"]
    ai = services["ai-service"]["environment"]
    document_token = core.get("DOCUMENT_INTERNAL_TOKEN", "")
    ai_document_token = ai.get("DOCUMENT_INTERNAL_TOKEN", "")
    if document_token or ai_document_token:
        if len(document_token.strip()) < 32 or document_token != ai_document_token:
            errors.append("문서 처리에는 Core/AI에 동일한 32자 이상 서버 전용 토큰이 필요합니다.")
    agent_enabled = core.get("ASSISTANT_AGENT_ENABLED", "false")
    if agent_enabled not in {"true", "false"}:
        errors.append("ASSISTANT_AGENT_ENABLED는 true 또는 false여야 합니다.")
    if agent_enabled == "true":
        token = core.get("ASSISTANT_TOOLS_TOKEN", "")
        if len(token.strip()) < 32 or token != ai.get("ASSISTANT_TOOLS_TOKEN"):
            errors.append("도우미 활성화에는 Core/AI에 동일한 32자 이상 서버 전용 토큰이 필요합니다.")
        if ai.get("ASSISTANT_TOOLS_BASE_URL") != "http://core-service:8080":
            errors.append("도우미 도구는 내부 Core 주소 http://core-service:8080을 사용해야 합니다.")
    origin = core.get("APP_CORS_ALLOWED_ORIGIN", "")
    if not re.fullmatch(r"https://[a-z0-9-]+\.vercel\.app", origin):
        errors.append("고정 운영 Vercel HTTPS origin이 필요합니다(끝 / 제외).")
    if core.get("ACCOUNT_DEV_LOGIN_ENABLED") != "false" or core.get("ACCOUNT_COOKIE_SECURE") != "true":
        errors.append("개발 로그인은 false, Secure 쿠키는 true여야 합니다.")
    mail_enabled = False
    for prefix in ("ACCOUNT_EMAIL_VERIFICATION", "ACCOUNT_PASSWORD_RESET"):
        enabled = core.get(prefix + "_MAIL_ENABLED", "false")
        if enabled not in {"true", "false"}:
            errors.append(f"{prefix}_MAIL_ENABLED는 true 또는 false여야 합니다.")
        if enabled == "true":
            mail_enabled = True
            if not re.fullmatch(r"[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+", core.get(prefix + "_FROM", "")):
                errors.append(f"{prefix}_FROM에 단일 발신 이메일 주소가 필요합니다.")
    if mail_enabled:
        if any(not core.get(key, "").strip() for key in ("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD")):
            errors.append("계정 메일을 켜려면 SMTP host/username/password가 필요합니다.")
        port = core.get("SMTP_PORT", "")
        if not port.isdigit() or not 1 <= int(port) <= 65535:
            errors.append("SMTP_PORT는 1~65535여야 합니다.")
        tls = (core.get("SMTP_STARTTLS_ENABLED"), core.get("SMTP_SSL_ENABLED"))
        if core.get("SMTP_AUTH") != "true" or tls not in {("true", "false"), ("false", "true")}:
            errors.append("운영 SMTP는 인증과 STARTTLS 또는 SSL 중 한 가지를 사용해야 합니다.")
    if core.get("ACCOUNT_OAUTH_UNLINK_ENABLED") == "true" and core.get("ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED") != "true":
        errors.append("운영 카카오 연결 해제를 활성화할 때는 큐 모드도 함께 켜야 합니다.")
    if core.get("SERVER_FORWARD_HEADERS_STRATEGY") != "native" or core.get("SERVER_TOMCAT_REMOTEIP_INTERNAL_PROXIES") != r"172\.30\.254\.2":
        errors.append("Core는 Nginx의 고정 IP만 신뢰해야 합니다.")
    db_url = core.get("SPRING_DATASOURCE_URL", "")
    if not re.match(r"jdbc:mysql://[a-z0-9.-]+\.ap-southeast-2\.rds\.amazonaws\.com:3306/[a-zA-Z0-9_]+\?sslMode=VERIFY_IDENTITY&", db_url):
        errors.append("시드니 RDS endpoint 및 인증서/호스트 검증 JDBC 설정을 확인하세요.")
    secrets = [services["nginx"]["environment"].get("GOVBIZ_PROXY_SECRET", ""),
               core.get("ACCOUNT_JWT_SECRET", ""), core.get("REDIS_PASSWORD", ""),
               core.get("RABBITMQ_PASSWORD", ""), services["ai-service"]["environment"].get("QDRANT_API_KEY", "")]
    if not all(re.fullmatch(r"[a-f0-9]{64}", secret) for secret in secrets) or len(set(secrets)) != len(secrets):
        errors.append("프록시/JWT/Redis/RabbitMQ/Qdrant 비밀값은 서로 다른 64자리 lowercase hex여야 합니다.")
    if core.get("SPRING_DATASOURCE_PASSWORD", "") in {"govbiz-local", "govbiz-root-local", "", "changeme"}:
        errors.append("개발 DB 비밀번호를 운영에 사용할 수 없습니다.")
    for name, service in services.items():
        image = service.get("image", "")
        if ":" not in image.rsplit("/", 1)[-1] or image.endswith((":latest", ":alpine", ":stable-alpine")):
            errors.append(f"{name}: 변경되지 않는 릴리스 tag/digest를 지정하세요.")
        if "build" in service or service.get("profiles") or name != "nginx" and service.get("ports"):
            errors.append(f"{name}: 운영 컨테이너는 로컬 빌드/profile/내부 포트 공개를 사용하지 않습니다.")
    ports = services["nginx"].get("ports", [])
    try:
        address = ipaddress.IPv4Address(ports[0]["host_ip"])
        private_ranges = [ipaddress.ip_network(cidr) for cidr in ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]]
        valid = len(ports) == 1 and any(address in block for block in private_ranges)
        valid = valid and str(ports[0]["published"]) == "80" and ports[0]["target"] == 8080
        if not valid:
            raise ValueError()
    except (IndexError, KeyError, ValueError):
        errors.append("Nginx는 EC2 사설 IPv4의 80 포트만 바인딩해야 합니다.")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=Path)
    args = parser.parse_args()
    env_file = args.env_file.resolve()
    if not env_file.is_file() or env_file.stat().st_mode & 0o077:
        parser.error("실제 환경 파일이 필요하며 권한은 600이어야 합니다.")
    # 상위 셸의 개발용 환경변수가 --env-file 값을 덮어쓰지 않게 제거한다.
    environment = {key: value for key, value in os.environ.items()
                   if key in {"PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"}}
    result = subprocess.run(["docker", "compose", "--env-file", str(env_file), "-f", str(COMPOSE),
                             "config", "--format", "json"], env=environment, capture_output=True, text=True)
    if result.returncode:
        print("Compose 설정 해석 실패: 필수 환경값과 경로를 확인하세요. 비밀값 보호를 위해 원문은 출력하지 않습니다.", file=sys.stderr)
        return 1
    config = json.loads(result.stdout)
    errors = validate(config)
    for volume in config["services"]["core-service"].get("volumes", []):
        if volume.get("target") == "/run/secrets/rds-truststore.p12" and not Path(volume["source"]).is_file():
            errors.append("RDS PKCS12 truststore 파일이 없습니다.")
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        return 1
    print("운영 설정 정적 검사 통과. AWS 연결·인증서 내용·이미지 존재·실행 용량 검증은 별도입니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
