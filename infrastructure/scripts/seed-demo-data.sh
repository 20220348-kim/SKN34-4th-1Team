#!/usr/bin/env bash

# 로컬 Compose의 demo-seed 서비스를 강제 실행해 공용 및 사용자별 데모 데이터를 넣습니다.
# Keep this Linux/WSL entrypoint LF-terminated; the root .gitattributes enforces it.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${REPOSITORY_DIR}/infrastructure/compose.yaml"
ENV_FILE="${GOVBIZ_ENV_FILE:-${REPOSITORY_DIR}/.env}"
PROJECT_NAME="${GOVBIZ_COMPOSE_PROJECT_NAME:-govbiz}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Create it from .env.example or point GOVBIZ_ENV_FILE at your env file." >&2
  exit 1
fi
if [[ ! "${PROJECT_NAME}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  echo "Invalid Compose project name: ${PROJECT_NAME}" >&2
  exit 1
fi

COMPOSE=(
  docker compose
  --project-name "${PROJECT_NAME}"
  --env-file "${ENV_FILE}"
  --file "${COMPOSE_FILE}"
)

# MySQL이 떠 있어야 하고, 모집글이 붙을 공고는 core-service의 기업마당 동기화가 채우므로 둘 다 실행 중이어야 합니다.
running_services="$("${COMPOSE[@]}" ps --services --status running)"
for service in mysql core-service; do
  if ! grep -Fxq -- "${service}" <<<"${running_services}"; then
    echo "Service '${service}' of Compose project '${PROJECT_NAME}' is not running. Start the stack first." >&2
    exit 1
  fi
done

echo "Running the demo-seed service in Compose project '${PROJECT_NAME}'"
# compose.yaml의 동일한 진입점을 사용해 대상 이메일 전달·공용 초기화·개인 seed 순서를 한 곳에서 유지합니다.
"${COMPOSE[@]}" run --rm -e DEMO_SEED_FORCE=true demo-seed
echo "Demo data seeded for the configured target accounts."
