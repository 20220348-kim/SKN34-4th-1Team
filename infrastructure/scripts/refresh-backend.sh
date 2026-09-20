#!/usr/bin/env bash

# Keep this Linux/WSL entrypoint LF-terminated; the root .gitattributes enforces it.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${REPOSITORY_DIR}/infrastructure/compose.yaml"
ENV_FILE="${REPOSITORY_DIR}/.env"
PROJECT_NAME="${GOVBIZ_COMPOSE_PROJECT_NAME:-govbiz}"
WAIT_TIMEOUT_SECONDS="${GOVBIZ_BACKEND_REFRESH_TIMEOUT_SECONDS:-120}"
WAIT_INTERVAL_SECONDS="${GOVBIZ_BACKEND_REFRESH_INTERVAL_SECONDS:-2}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Create it from .env.example before refreshing the backend." >&2
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
EXPECTED_SERVICES=(mysql qdrant redis rabbitmq elasticsearch ai-service core-service web)

contains_line() {
  local lines=$1
  local expected=$2
  grep -Fxq -- "${expected}" <<<"${lines}"
}

echo "Validating GovBiz Compose project '${PROJECT_NAME}'"
configured_services="$("${COMPOSE[@]}" config --services)"
for service in "${EXPECTED_SERVICES[@]}"; do
  if ! contains_line "${configured_services}" "${service}"; then
    echo "Compose configuration does not contain expected service '${service}'. Nothing was changed." >&2
    exit 1
  fi
done

project_containers="$(docker ps --all --quiet --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
if [[ -z "${project_containers}" ]]; then
  echo "Compose project '${PROJECT_NAME}' is not present. Start the full stack with the documented quick-start command first." >&2
  exit 1
fi

existing_services="$("${COMPOSE[@]}" ps --all --services)"
for service in "${EXPECTED_SERVICES[@]}"; do
  if ! contains_line "${existing_services}" "${service}"; then
    echo "Compose project '${PROJECT_NAME}' does not own expected service '${service}'. Nothing was changed." >&2
    exit 1
  fi
done

running_services="$("${COMPOSE[@]}" ps --services --status running)"
for service in mysql qdrant redis rabbitmq elasticsearch web; do
  if ! contains_line "${running_services}" "${service}"; then
    echo "Required existing service '${service}' is not running in project '${PROJECT_NAME}'. Nothing was changed." >&2
    exit 1
  fi
done

echo "Building Core API and AI Service images from the current checkout"
"${COMPOSE[@]}" build core-service ai-service

echo "Replacing AI Service without recreating MySQL, Qdrant or Web"
"${COMPOSE[@]}" up --detach --no-deps --no-build ai-service

deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
until "${COMPOSE[@]}" exec --no-TTY ai-service python -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/internal/v1/health', timeout=2).read()" \
  >/dev/null 2>&1; do
  if ((SECONDS >= deadline)); then
    echo "Timed out waiting for the refreshed AI Service. Core API was not replaced." >&2
    exit 1
  fi
  sleep "${WAIT_INTERVAL_SECONDS}"
done

echo "Replacing Core API after AI Service is ready"
"${COMPOSE[@]}" up --detach --no-deps --no-build core-service

web_port_mapping="$("${COMPOSE[@]}" port web 5173)"
web_port="${web_port_mapping##*:}"
if [[ ! "${web_port}" =~ ^[0-9]+$ ]]; then
  echo "Could not determine the host port for the existing Web service: ${web_port_mapping}" >&2
  exit 1
fi
web_base_url="http://127.0.0.1:${web_port}"

wait_for_health() {
  local label=$1
  local path=$2
  local service_name=$3
  local response_file
  response_file="$(mktemp)"
  deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
  while ((SECONDS < deadline)); do
    status="$(curl --silent --output "${response_file}" --write-out '%{http_code}' --max-time 5 "${web_base_url}${path}" || true)"
    if [[ "${status}" == "200" ]] \
        && grep -Eq '"status"[[:space:]]*:[[:space:]]*"up"' "${response_file}" \
        && grep -Fq "\"service\":\"${service_name}\"" "${response_file}"; then
      rm -f -- "${response_file}"
      echo "Verified ${label} through Web: HTTP 200"
      return 0
    fi
    sleep "${WAIT_INTERVAL_SECONDS}"
  done
  echo "Timed out waiting for ${label} through ${web_base_url}${path}." >&2
  sed -n '1,40p' "${response_file}" >&2
  rm -f -- "${response_file}"
  return 1
}

wait_for_health "Core API" "/api/v1/health" "govbiz-core-service"
wait_for_health "Core-to-AI Service" "/api/v1/health/ai-service" "govbiz-ai-service"

echo "Backend refresh completed for project '${PROJECT_NAME}'. Existing MySQL, Qdrant and Redis containers and volumes were not recreated or removed."
