#!/usr/bin/env python3
"""Validate the reviewed seed by default; --apply invokes the existing Kotlin importer.

Run on the deployment host with Python 3 and Docker Compose. No packages required.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


INFRA = Path(__file__).resolve().parents[1]
SEED = INFRA / "seed/application-form-openai-analysis-20260915-v2.json"
SHA256 = "02469da3f71d0ef0cab0f0cb757dc047705c769966b3d3011a4b029c22301829"
INPUT_PATH = "/seed/application-forms.json"
DISABLED_PROPERTIES = (
    "app.application-form-analysis.enabled", "app.bizinfo.sync.enabled",
    "app.kstartup.sync.enabled", "app.msit.sync.enabled", "app.cntrade-notice.sync.enabled",
    "app.support-program-index.enabled", "app.daily-report.enabled",
    "app.daily-report.mail-enabled", "app.daily-report.queue.enabled",
    "app.daily-report.queue.delivery-enabled", "app.combination-review.queue.enabled",
    "app.application-form-discovery.queue.enabled", "app.assistant.prefetch-queue-enabled",
    "app.account.oauth.unlink.enabled", "app.account.oauth.unlink.queue-enabled",
    "app.account.password-reset.mail-enabled", "app.account.email-verification.mail-enabled",
    "spring.rabbitmq.listener.simple.auto-startup",
)


def checked_config(compose):
    result = subprocess.run(compose + ["config", "--format", "json"], capture_output=True, text=True)
    if result.returncode:
        raise ValueError("Compose 설정을 읽지 못했습니다. 비밀정보가 포함될 수 있어 원문은 출력하지 않습니다.")
    return json.loads(result.stdout)["services"]["core-service"]


def run(args):
    if hashlib.sha256(SEED.read_bytes()).hexdigest() != SHA256:
        raise ValueError("Seed SHA-256 불일치: 검토된 원본 파일을 복원하세요.")
    if not args.env_file.is_file() or not args.compose_file.is_file():
        raise ValueError("서버 환경 파일과 Compose 파일이 필요합니다.")
    compose = ["docker", "compose", "--env-file", str(args.env_file.resolve()),
               "-f", str(args.compose_file.resolve())]
    # --no-deps: never start/recreate deployment services; no service ports are published.
    container = compose + ["run", "--rm", "--no-deps", "-T", "--entrypoint", "java",
                           "--volume", f"{SEED.resolve()}:{INPUT_PATH}:ro", "core-service"]
    dry_run = container + [
        "-Dloader.main=ai.govbiz.core.applicationpreparation.service.backfill.ApplicationFormBackfillInput",
        "-cp", "/app/application.jar", "org.springframework.boot.loader.launch.PropertiesLauncher",
        INPUT_PATH, SHA256,
    ]
    # Executes the real Kotlin validator from the selected release image, without Spring/DB/API.
    code = subprocess.run(dry_run).returncode
    if code or not args.apply:
        return code
    if not args.expected_jdbc_url or not args.backup_confirmed:
        raise ValueError("적재에는 --expected-jdbc-url 및 백업 완료 후 --backup-confirmed가 필요합니다.")
    service = checked_config(compose)
    if service["environment"].get("SPRING_DATASOURCE_URL") != args.expected_jdbc_url:
        raise ValueError("명시한 DB 주소와 Compose 대상 DB가 다릅니다.")
    running = subprocess.run(compose + ["ps", "--status", "running", "--services", "core-service"],
                             capture_output=True, text=True)
    if running.returncode or running.stdout.strip():
        raise ValueError("동시 변경 방지를 위해 해당 배포의 core-service를 먼저 중지하세요. 다른 인스턴스도 중지해야 합니다.")
    command = container + ["-jar", "/app/application.jar", "--server.port=0",
        "--app.application-form-backfill.apply=true", "--app.application-form-backfill.exit-after-run=true",
        f"--app.application-form-backfill.input={INPUT_PATH}", f"--app.application-form-backfill.sha256={SHA256}",
        f"--app.application-form-backfill.expected-jdbc-url={args.expected_jdbc_url}",
        # Migrations must be applied by the normal release before the explicit data import.
        "--spring.flyway.enabled=false",
        *[f"--{key}=false" for key in DISABLED_PROPERTIES],
    ]
    return subprocess.run(command).returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True, help="배포 서버의 기존 환경 파일")
    parser.add_argument("--compose-file", type=Path, default=INFRA / "compose.prod.yaml")
    parser.add_argument("--apply", action="store_true", help="검증 후 실제 DB 적재")
    parser.add_argument("--expected-jdbc-url", help="배포 설정과 정확히 일치하는 JDBC URL")
    parser.add_argument("--backup-confirmed", action="store_true", help="대상 DB 백업을 완료했을 때만 지정")
    args = parser.parse_args()
    try:
        return run(args)
    except (ValueError, OSError, KeyError) as error:
        print(f"적재 중단: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
