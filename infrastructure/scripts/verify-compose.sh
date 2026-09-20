#!/usr/bin/env bash

# Keep this Linux/WSL entrypoint LF-terminated; the root .gitattributes enforces it.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INFRASTRUCTURE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${INFRASTRUCTURE_DIR}/compose.yaml"
WAIT_TIMEOUT_SECONDS="${VERIFY_COMPOSE_TIMEOUT_SECONDS:-120}"
WAIT_INTERVAL_SECONDS="${VERIFY_COMPOSE_INTERVAL_SECONDS:-2}"
KEEP_RUNNING="${VERIFY_COMPOSE_KEEP_RUNNING:-false}"
PROJECT_NAME="${VERIFY_COMPOSE_PROJECT_NAME:-govbiz-verify}"

# Verification never uses a developer's real key or the live public API. Exported values take
# precedence over a root .env file for every Compose command executed by this script.
export BIZINFO_API_BASE_URL="http://bizinfo-stub:8001"
export DATA_GO_KR_SERVICE_KEY="compose%2Bverification%2Fkey%3D"
export BIZINFO_SYNC_ENABLED="true"
export BIZINFO_SYNC_INITIAL_DELAY="PT0S"
export BIZINFO_SYNC_FIXED_DELAY="PT2S"
# Every public catalog source uses local fixtures, regardless of the developer's .env.
export KSTARTUP_SYNC_ENABLED="true"
export KSTARTUP_API_KEY="compose%2Bstartup%2Fverification%3D"
export KSTARTUP_API_BASE_URL="http://kstartup-stub:8003"
export KSTARTUP_SYNC_SCOPE="RECENT_YEAR"
export KSTARTUP_SYNC_INITIAL_DELAY="PT0S"
export KSTARTUP_SYNC_FIXED_DELAY="PT2S"
export MSIT_API_BASE_URL="http://public-notices-stub:8004"
export MSIT_API_KEY="compose%2Bnotice%2Fverification%3D"
export MSIT_SYNC_ENABLED="true"
export MSIT_SYNC_INITIAL_DELAY="PT0S"
export MSIT_SYNC_FIXED_DELAY="PT2S"
export CNTRADE_NOTICE_API_BASE_URL="http://public-notices-stub:8004"
export CNTRADE_NOTICE_API_KEY="compose%2Bnotice%2Fverification%3D"
export CNTRADE_NOTICE_SYNC_ENABLED="true"
export CNTRADE_NOTICE_SYNC_INITIAL_DELAY="PT0S"
export CNTRADE_NOTICE_SYNC_FIXED_DELAY="PT2S"
export OPENAI_API_KEY="compose-verification-key-never-sent"
export OPENAI_BASE_URL="http://openai-stub:8002/v1"
# Smoke scenarios create their own records and must start without optional demo data.
export DEMO_SEED_ENABLED="false"
export DEMO_SEED_FORCE="false"
# 개발자 .env에 리포트가 켜져 있어도 검증 스택에서 외부 메일을 보내지 않는다.
export DAILY_REPORT_ENABLED="false"
export DAILY_REPORT_QUEUE_ENABLED="true"
export DAILY_REPORT_DELIVERY_QUEUE_ENABLED="true"
export ACCOUNT_OAUTH_UNLINK_ENABLED="true"
export ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED="true"
# 외부 계정 연결 해제는 검증 범위가 아니다. 개발자 자격증명을 검증 스택에 넣지 않는다.
export ACCOUNT_OAUTH_KAKAO_ADMIN_KEY=""
export ACCOUNT_OAUTH_KAKAO_CLIENT_ID=""
export ACCOUNT_OAUTH_KAKAO_CLIENT_SECRET=""
export ACCOUNT_OAUTH_GOOGLE_CLIENT_ID=""
export ACCOUNT_OAUTH_GOOGLE_CLIENT_SECRET=""
export COMBINATION_REVIEW_QUEUE_ENABLED="true"
export APPLICATION_FORM_DISCOVERY_QUEUE_ENABLED="true"
# This smoke uses an explicit stored fixture; system discovery is covered by MySQL integration tests.
export APPLICATION_FORM_ANALYSIS_ENABLED="false"
export APPLICATION_FORM_DISCOVERY_MODEL_TIMEOUT_SECONDS="210"
export APPLICATION_FORM_DISCOVERY_RUN_TIMEOUT_SECONDS="240"
export APPLICATION_FORM_DISCOVERY_READ_TIMEOUT="270s"
export APPLICATION_FORM_WORKER_LEASE="1800s"
export RABBITMQ_USERNAME="govbiz-verification"
export RABBITMQ_PASSWORD="govbiz-verification-not-a-secret"
export DAILY_REPORT_MAIL_ENABLED="false"
export DAILY_REPORT_FROM=""
export SMTP_HOST=""
export SMTP_USERNAME=""
export SMTP_PASSWORD=""
export OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
export OPENAI_EMBEDDING_DIMENSIONS="1536"
export EMBEDDING_TIMEOUT_SECONDS="5"
export QDRANT_TIMEOUT_SECONDS="2"
export ELASTICSEARCH_INDEX_NAME="govbiz-support-program-lexical-v2"
export ELASTICSEARCH_API_KEY=""
export ELASTICSEARCH_CONNECT_TIMEOUT="1s"
export ELASTICSEARCH_READ_TIMEOUT="5s"
export QDRANT_HOST_PORT="${VERIFY_COMPOSE_QDRANT_HOST_PORT:-16333}"
export SUPPORT_PROGRAM_INDEX_ENABLED="true"
export SUPPORT_PROGRAM_INDEX_INITIAL_DELAY="PT0S"
export SUPPORT_PROGRAM_INDEX_FIXED_DELAY="PT2S"
export AI_SEMANTIC_SEARCH_READ_TIMEOUT="30s"
export LLM_MODEL_TIMEOUT_SECONDS="25.0"
export LLM_RUN_TIMEOUT_SECONDS="30.0"
export LLM_RANKING_MODEL_TIMEOUT_SECONDS="45.0"
export LLM_RANKING_RUN_TIMEOUT_SECONDS="50.0"
export AI_SERVICE_READ_TIMEOUT="35s"
export AI_RANKING_READ_TIMEOUT="55s"
# 이 스모크 테스트는 장애 상태를 반복 폴링하므로 공개 요청 한도를 별도로 높인다.
# 낮은 한도·동시 거절·우회 방지는 Core/Frontend 회귀 테스트에서 검증한다.
export SUPPORT_PROGRAM_REQUEST_PER_CLIENT_PER_MINUTE="1000"
export SUPPORT_PROGRAM_REQUEST_GLOBAL_PER_MINUTE="1000"
export SUPPORT_PROGRAM_REQUEST_MAX_CONCURRENT="4"
# The verification stack connects to MySQL through the Compose network. Give its
# host-only port a separate default so a developer's local MySQL on 3306 does
# not prevent the smoke test from starting.
export MYSQL_HOST_PORT="${VERIFY_COMPOSE_MYSQL_HOST_PORT:-13306}"
export WEB_HOST_PORT="${VERIFY_COMPOSE_WEB_HOST_PORT:-15173}"
export CORE_API_HOST_PORT="${VERIFY_COMPOSE_CORE_API_HOST_PORT:-18080}"
WEB_BASE_URL="http://127.0.0.1:${WEB_HOST_PORT}"
export APP_CORS_ALLOWED_ORIGIN="${WEB_BASE_URL}"

COMPOSE=(
  docker compose
  --profile verification
  --project-name "${PROJECT_NAME}"
  --file "${COMPOSE_FILE}"
)

# Fail before installing a destructive cleanup trap. A reused project name can
# otherwise make even a failed config/build delete another stack's MySQL volume.
echo "Validating Compose configuration"
"${COMPOSE[@]}" config --quiet
EXISTING_CONTAINERS="$(docker ps --all --quiet --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
EXISTING_NETWORKS="$(docker network ls --quiet --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
EXISTING_VOLUMES="$(docker volume ls --quiet --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
if [[ -n "${EXISTING_CONTAINERS}${EXISTING_NETWORKS}${EXISTING_VOLUMES}" ]]; then
  echo "Verification project '${PROJECT_NAME}' already has Docker resources; choose an unused project name. Nothing was changed." >&2
  exit 1
fi

RESPONSE_DIR="$(mktemp -d)"
LAST_RESPONSE_FILE="${RESPONSE_DIR}/last-response"

cleanup() {
  local exit_code=$?
  trap - EXIT

  if ((exit_code != 0)); then
    echo "Compose verification failed. Current services and logs:" >&2
    "${COMPOSE[@]}" ps >&2 || true
    "${COMPOSE[@]}" logs --no-color >&2 || true
  fi

  if [[ "${KEEP_RUNNING}" != "true" ]]; then
    "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi

  rm -rf -- "${RESPONSE_DIR}"
  exit "${exit_code}"
}

trap cleanup EXIT

wait_for_http() {
  local label=$1
  local url=$2
  local expected_status=$3
  shift 3
  local deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
  local actual_status="000"
  local body_matches
  local pattern
  # Bash 3.2 (macOS) treats an empty array as unset under set -u.
  local request_options=(--header 'Accept: */*')
  if [[ "${VERIFY_HTTP_MEMBER:-false}" == "true" ]]; then
    request_options+=(--cookie "${RESPONSE_DIR}/application-preparation-cookie")
  fi

  while ((SECONDS < deadline)); do
    : >"${LAST_RESPONSE_FILE}"
    actual_status="$(
      curl \
        --silent \
        --output "${LAST_RESPONSE_FILE}" \
        --write-out '%{http_code}' \
        --max-time 70 \
        "${request_options[@]}" \
        "${url}" || true
    )"

    if [[ "${actual_status}" == "${expected_status}" ]]; then
      body_matches=true
      for pattern in "$@"; do
        if [[ -n "${pattern}" ]] && ! grep -Eq "${pattern}" "${LAST_RESPONSE_FILE}"; then
          body_matches=false
          break
        fi
      done

      if [[ "${body_matches}" == "true" ]]; then
        echo "Verified ${label}: HTTP ${actual_status}"
        return 0
      fi
    fi

    echo "Waiting for ${label}: expected HTTP ${expected_status}, received ${actual_status}"
    sleep "${WAIT_INTERVAL_SECONDS}"
  done

  echo "Timed out waiting for ${label}: expected HTTP ${expected_status}, received ${actual_status}" >&2
  echo "Last response body:" >&2
  sed -n '1,80p' "${LAST_RESPONSE_FILE}" >&2
  return 1
}

wait_for_json_post() {
  local label=$1
  local url=$2
  local request_body=$3
  local expected_status=$4
  local expected_body_pattern=$5
  local deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
  local actual_status="000"

  while ((SECONDS < deadline)); do
    : >"${LAST_RESPONSE_FILE}"
    actual_status="$(
      curl \
        --silent \
        --output "${LAST_RESPONSE_FILE}" \
        --write-out '%{http_code}' \
        --max-time 5 \
        --request POST \
        --header 'Accept: application/json' \
        --header 'Content-Type: application/json' \
        --header "Origin: ${WEB_BASE_URL}" \
        --data "${request_body}" \
        "${url}" || true
    )"

    if [[ "${actual_status}" == "${expected_status}" ]] \
        && grep -Eq "${expected_body_pattern}" "${LAST_RESPONSE_FILE}"; then
      echo "Verified ${label}: HTTP ${actual_status}"
      return 0
    fi

    echo "Waiting for ${label}: expected HTTP ${expected_status}, received ${actual_status}"
    sleep "${WAIT_INTERVAL_SECONDS}"
  done

  echo "Timed out waiting for ${label}: expected HTTP ${expected_status}, received ${actual_status}" >&2
  echo "Last response body:" >&2
  sed -n '1,80p' "${LAST_RESPONSE_FILE}" >&2
  return 1
}

verify_application_preparation_flow() {
  local cookie_jar="${RESPONSE_DIR}/application-preparation-cookie"
  local actual_status
  local preparation_id

  actual_status="$(curl --silent --output "${LAST_RESPONSE_FILE}" --write-out '%{http_code}' --max-time 10 \
    --request POST --cookie-jar "${cookie_jar}" --header 'Accept: application/json' \
    --header 'Content-Type: application/json' --header "Origin: ${WEB_BASE_URL}" \
    --data '{"role":"USER"}' "${WEB_BASE_URL}/api/v1/auth/dev-login")"
  if [[ "${actual_status}" != "200" ]]; then
    echo "Application preparation smoke could not create a development session: HTTP ${actual_status}" >&2
    return 1
  fi

  # A bundled legacy manifest alone no longer authorizes new drafts. Seed this known fixture only
  # inside the isolated verification database, through the same snapshot + availability contract.
  local manifest_hex
  manifest_hex="$(od -An -v -tx1 "${INFRASTRUCTURE_DIR}/../backend/core-service/src/main/resources/application-preparation/innovation-voucher-2026-v1.json" | tr -d ' \n')"
  "${COMPOSE[@]}" exec -T mysql sh -c 'exec mysql --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" "$MYSQL_DATABASE"' <<SQL
SET @manifest = CONVERT(UNHEX('${manifest_hex}') USING utf8mb4);
START TRANSACTION;
INSERT INTO application_form_snapshot
(form_version_id, source_code, source_program_id, source_fingerprint, attachment_sha256, manifest_json,
 parser_version, extraction_model, extraction_prompt_version, created_at)
VALUES (JSON_UNQUOTE(JSON_EXTRACT(@manifest, '$.formVersionId')), 'BIZINFO', 'PBLN_000000000118979',
 SHA2(@manifest,256), JSON_UNQUOTE(JSON_EXTRACT(@manifest, '$.attachmentSha256')), CAST(@manifest AS JSON),
 'compose-fixture', 'test-model', CONCAT('sha256:', REPEAT('a',64)), NOW());
INSERT INTO application_form_availability
(source_code,source_program_id,catalog_fingerprint,source_fingerprint,parser_version,extraction_model,
 extraction_prompt_version,status,reason_code,active_form_version_id)
SELECT source_code,source_program_id,source_fingerprint,source_fingerprint,parser_version,extraction_model,
 extraction_prompt_version,'AVAILABLE','COMPOSE_FIXTURE',form_version_id FROM application_form_snapshot
WHERE form_version_id=JSON_UNQUOTE(JSON_EXTRACT(@manifest, '$.formVersionId'));
COMMIT;
SQL

  actual_status="$(curl --silent --output "${LAST_RESPONSE_FILE}" --write-out '%{http_code}' --max-time 10 \
    --cookie "${cookie_jar}" "${WEB_BASE_URL}/api/v1/application-preparations/forms")"
  if [[ "${actual_status}" != "200" ]] \
      || ! grep -Eq '"formVersionId"[[:space:]]*:[[:space:]]*"bizinfo-pbln-000000000118979-innovation-voucher-2026-v1"' "${LAST_RESPONSE_FILE}"; then
    echo "Application preparation smoke could not load forms through Web: HTTP ${actual_status}" >&2
    sed -n '1,40p' "${LAST_RESPONSE_FILE}" >&2
    return 1
  fi

  actual_status="$(curl --silent --output "${LAST_RESPONSE_FILE}" --write-out '%{http_code}' --max-time 10 \
    --cookie "${cookie_jar}" "${WEB_BASE_URL}/api/v1/application-preparations")"
  if [[ "${actual_status}" != "200" ]] \
      || ! grep -Eq '"items"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]' "${LAST_RESPONSE_FILE}"; then
    echo "Application preparation smoke expected an empty preparation list before explicit creation: HTTP ${actual_status}" >&2
    sed -n '1,40p' "${LAST_RESPONSE_FILE}" >&2
    return 1
  fi
  echo "Verified application preparation forms and empty list through Web without creating a preparation"

  actual_status="$(curl --silent --output "${LAST_RESPONSE_FILE}" --write-out '%{http_code}' --max-time 10 \
    --request POST --cookie "${cookie_jar}" --header 'Accept: application/json' \
    --header 'Content-Type: application/json' --header "Origin: ${WEB_BASE_URL}" \
    --data '{"sourceCode":"BIZINFO","sourceProgramId":"PBLN_000000000118979","formVersionId":"bizinfo-pbln-000000000118979-innovation-voucher-2026-v1","serviceField":"TECHNICAL_SUPPORT"}' \
    "${WEB_BASE_URL}/api/v1/application-preparations")"
  if [[ "${actual_status}" != "201" ]]; then
    echo "Application preparation smoke could not create a preparation: HTTP ${actual_status}" >&2
    sed -n '1,40p' "${LAST_RESPONSE_FILE}" >&2
    return 1
  fi
  preparation_id="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${LAST_RESPONSE_FILE}" | head -n 1)"
  if [[ -z "${preparation_id}" ]]; then
    echo "Application preparation smoke could not read the created id" >&2
    return 1
  fi

  actual_status="$(curl --silent --output "${LAST_RESPONSE_FILE}" --write-out '%{http_code}' --max-time 45 \
    --request POST --cookie "${cookie_jar}" --header 'Accept: application/json' \
    --header 'Content-Type: application/json' --header "Origin: ${WEB_BASE_URL}" \
    --data '{"expectedRevision":1,"requestKey":"0a504895-77bd-4d34-bc61-3e6d12389042","message":"\uc5c5\uccb4\uba85\uc740 \uc0c8\ubd04\ud14c\ud06c\uc785\ub2c8\ub2e4."}' \
    "${WEB_BASE_URL}/api/v1/application-preparations/${preparation_id}/sections/company-overview/messages")"
  if [[ "${actual_status}" != "200" ]] \
      || ! grep -Eq '"fieldKey"[[:space:]]*:[[:space:]]*"company-name"' "${LAST_RESPONSE_FILE}" \
      || ! grep -Eq '"value"[[:space:]]*:[[:space:]]*"새봄테크"' "${LAST_RESPONSE_FILE}"; then
    echo "Application preparation smoke did not receive the expected unconfirmed AI suggestion: HTTP ${actual_status}" >&2
    sed -n '1,40p' "${LAST_RESPONSE_FILE}" >&2
    return 1
  fi

  actual_status="$(curl --silent --output "${LAST_RESPONSE_FILE}" --write-out '%{http_code}' --max-time 10 \
    --request PUT --cookie "${cookie_jar}" --header 'Accept: application/json' \
    --header 'Content-Type: application/json' --header "Origin: ${WEB_BASE_URL}" \
    --data '{"expectedRevision":1,"facts":[{"fieldKey":"company-name","status":"PROVIDED","value":"\uc0c8\ubd04\ud14c\ud06c","sourceText":"\uc5c5\uccb4\uba85\uc740 \uc0c8\ubd04\ud14c\ud06c\uc785\ub2c8\ub2e4."}]}' \
    "${WEB_BASE_URL}/api/v1/application-preparations/${preparation_id}/sections/company-overview/inputs")"
  if [[ "${actual_status}" != "200" ]] \
      || ! grep -Eq '"inputRevision"[[:space:]]*:[[:space:]]*2' "${LAST_RESPONSE_FILE}" \
      || ! grep -Eq '"status"[[:space:]]*:[[:space:]]*"IN_PROGRESS"' "${LAST_RESPONSE_FILE}"; then
    echo "Application preparation smoke did not persist the confirmed fact snapshot: HTTP ${actual_status}" >&2
    sed -n '1,40p' "${LAST_RESPONSE_FILE}" >&2
    return 1
  fi

  actual_status="$(curl --silent --output "${LAST_RESPONSE_FILE}" --write-out '%{http_code}' --max-time 10 \
    --cookie "${cookie_jar}" "${WEB_BASE_URL}/api/v1/application-preparations/${preparation_id}")"
  if [[ "${actual_status}" != "200" ]] \
      || ! grep -Eq '"sourceText"[[:space:]]*:[[:space:]]*"업체명은 새봄테크입니다\."' "${LAST_RESPONSE_FILE}"; then
    echo "Application preparation smoke could not reload the confirmed fact: HTTP ${actual_status}" >&2
    return 1
  fi
  echo "Verified application preparation question and confirmed fact flow through Web, Core, AI stub and MySQL"
}

verify_search_result_store() {
  local guest_file="${RESPONSE_DIR}/redis-guest.json"
  local restored_file="${RESPONSE_DIR}/redis-restored.json"
  local first_cookie="${RESPONSE_DIR}/application-preparation-cookie"
  local other_cookie="${RESPONSE_DIR}/redis-other-cookie"
  local token actual_status

  wait_for_http "Guest search creates a Redis-backed result token" \
    "${WEB_BASE_URL}/api/v1/support-programs/search?query=&acceptingOnly=false" "200" \
    '"totalCount"[[:space:]]*:[[:space:]]*5' '"resultToken"[[:space:]]*:[[:space:]]*"[0-9a-f-]{36}"'
  cp "${LAST_RESPONSE_FILE}" "${guest_file}"
  [[ "$(grep -o '"sourceCode"' "${guest_file}" | wc -l | tr -d ' ')" == "2" ]] || return 1
  token="$(sed -n 's/.*"resultToken"[[:space:]]*:[[:space:]]*"\([0-9a-f-]\{36\}\)".*/\1/p' "${guest_file}")"
  [[ "${token}" =~ ^[0-9a-f-]{36}$ ]] || return 1

  actual_status="$(curl --silent --output "${restored_file}" --write-out '%{http_code}' --max-time 10 \
    --request POST --cookie "${first_cookie}" --header 'Content-Type: application/json' --header "Origin: ${WEB_BASE_URL}" \
    --data "{\"resultToken\":\"${token}\"}" "${WEB_BASE_URL}/api/v1/support-programs/search/results")"
  [[ "${actual_status}" == "200" ]] || return 1
  grep -Eq '"totalCount"[[:space:]]*:[[:space:]]*5' "${restored_file}" || return 1
  [[ "$(grep -o '"sourceCode"' "${restored_file}" | wc -l | tr -d ' ')" == "5" ]] || return 1

  echo "Restarting Core to verify that saved results and token ownership are not process-local"
  "${COMPOSE[@]}" restart core-service
  wait_for_http "Core health after restart" "${WEB_BASE_URL}/api/v1/health" "200"
  actual_status="$(curl --silent --output "${LAST_RESPONSE_FILE}" --write-out '%{http_code}' --max-time 10 \
    --request POST --cookie "${first_cookie}" --header 'Content-Type: application/json' --header "Origin: ${WEB_BASE_URL}" \
    --data "{\"resultToken\":\"${token}\"}" "${WEB_BASE_URL}/api/v1/support-programs/search/results")"
  [[ "${actual_status}" == "200" ]] && cmp -s "${restored_file}" "${LAST_RESPONSE_FILE}" || return 1

  actual_status="$(curl --silent --output "${LAST_RESPONSE_FILE}" --write-out '%{http_code}' --max-time 10 \
    --request POST --cookie-jar "${other_cookie}" --header 'Content-Type: application/json' --header "Origin: ${WEB_BASE_URL}" \
    --data '{"role":"ADMIN"}' "${WEB_BASE_URL}/api/v1/auth/dev-login")"
  [[ "${actual_status}" == "200" ]] || return 1
  actual_status="$(curl --silent --output "${LAST_RESPONSE_FILE}" --write-out '%{http_code}' --max-time 10 \
    --request POST --cookie "${other_cookie}" --header 'Content-Type: application/json' --header "Origin: ${WEB_BASE_URL}" \
    --data "{\"resultToken\":\"${token}\"}" "${WEB_BASE_URL}/api/v1/support-programs/search/results")"
  [[ "${actual_status}" == "410" ]] || return 1

  echo "Stopping only verification Redis to verify an explicit store outage"
  "${COMPOSE[@]}" stop redis
  actual_status="$(curl --silent --output "${LAST_RESPONSE_FILE}" --write-out '%{http_code}' --max-time 10 \
    --request POST --cookie "${first_cookie}" --header 'Content-Type: application/json' --header "Origin: ${WEB_BASE_URL}" \
    --data "{\"resultToken\":\"${token}\"}" "${WEB_BASE_URL}/api/v1/support-programs/search/results")"
  [[ "${actual_status}" == "503" ]] || return 1
  grep -q 'SUPPORT_PROGRAM_SEARCH_RESULT_STORE_UNAVAILABLE' "${LAST_RESPONSE_FILE}" || return 1
  wait_for_http "Guest search store outage is not a successful partial result" \
    "${WEB_BASE_URL}/api/v1/support-programs/search?query=&acceptingOnly=false" "503" \
    'SUPPORT_PROGRAM_SEARCH_RESULT_STORE_UNAVAILABLE'
  wait_for_http "MySQL catalog remains available during Redis outage" \
    "${WEB_BASE_URL}/api/v1/support-programs/catalog?sourceCode=KSTARTUP&status=OPEN" "200"

  echo "Recreating verification Redis with the same AOF volume to verify recovery"
  "${COMPOSE[@]}" up --detach --force-recreate --no-deps --wait redis
  # The existing Core connection must recover too; retry only restoration, never search/AI.
  local deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
  while ((SECONDS < deadline)); do
    actual_status="$(curl --silent --output "${LAST_RESPONSE_FILE}" --write-out '%{http_code}' --max-time 10 \
      --request POST --cookie "${first_cookie}" --header 'Content-Type: application/json' --header "Origin: ${WEB_BASE_URL}" \
      --data "{\"resultToken\":\"${token}\"}" "${WEB_BASE_URL}/api/v1/support-programs/search/results")"
    if [[ "${actual_status}" == "200" ]] && cmp -s "${restored_file}" "${LAST_RESPONSE_FILE}"; then
      echo "Verified Redis result restoration: Core restart, account ownership, explicit outage and AOF recovery"
      return 0
    fi
    sleep "${WAIT_INTERVAL_SECONDS}"
  done
  echo "Redis restoration did not recover the identical saved result" >&2
  return 1
}

wait_for_report_consumer() {
  local deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
  local queues
  while ((SECONDS < deadline)); do
    queues="$("${COMPOSE[@]}" exec --user rabbitmq -T rabbitmq rabbitmqctl -q list_queues -p govbiz name type consumers 2>/dev/null || true)"
    if grep -Eq '^govbiz\.daily-report\.generation\.v1[[:space:]]+quorum[[:space:]]+1$' <<<"${queues}" \
        && grep -Eq '^govbiz\.daily-report\.generation\.dead\.v1[[:space:]]+quorum[[:space:]]+0$' <<<"${queues}" \
        && grep -Eq '^govbiz\.combination-review\.generation\.v1[[:space:]]+quorum[[:space:]]+1$' <<<"${queues}" \
        && grep -Eq '^govbiz\.combination-review\.generation\.dead\.v1[[:space:]]+quorum[[:space:]]+0$' <<<"${queues}" \
        && grep -Eq '^govbiz\.application-form-discovery\.generation\.v1[[:space:]]+quorum[[:space:]]+1$' <<<"${queues}" \
        && grep -Eq '^govbiz\.application-form-discovery\.generation\.dead\.v1[[:space:]]+quorum[[:space:]]+0$' <<<"${queues}" \
        && grep -Eq '^govbiz\.daily-report\.delivery\.v1[[:space:]]+quorum[[:space:]]+1$' <<<"${queues}" \
        && grep -Eq '^govbiz\.daily-report\.delivery\.dead\.v1[[:space:]]+quorum[[:space:]]+0$' <<<"${queues}" \
        && grep -Eq '^govbiz\.account\.oauth-unlink\.v1[[:space:]]+quorum[[:space:]]+1$' <<<"${queues}" \
        && grep -Eq '^govbiz\.account\.oauth-unlink\.dead\.v1[[:space:]]+quorum[[:space:]]+0$' <<<"${queues}"; then
      echo "Verified report generation/delivery, combination-review, form-discovery and OAuth unlink quorum queues and their connected consumers"
      return 0
    fi
    sleep "${WAIT_INTERVAL_SECONDS}"
  done
  echo "Report consumer did not connect to the expected quorum queue" >&2
  return 1
}

verify_report_broker_recovery() {
  wait_for_report_consumer
  # 정기 생성·SMTP는 계속 꺼져 있다. 실제 사용자 작업을 만들거나 AI를 호출하지 않는다.
  "${COMPOSE[@]}" stop rabbitmq
  wait_for_http "MySQL catalog remains available during RabbitMQ outage" \
    "${WEB_BASE_URL}/api/v1/support-programs/catalog?sourceCode=KSTARTUP&status=OPEN" "200"
  "${COMPOSE[@]}" up --detach --force-recreate --no-deps --wait rabbitmq
  wait_for_report_consumer
  echo "Verified RabbitMQ volume recreation and Core consumer reconnection without restarting Core"
}

wait_for_ai_failure() {
  local label=$1
  local url=$2
  local deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
  local actual_status="000"

  while ((SECONDS < deadline)); do
    : >"${LAST_RESPONSE_FILE}"
    actual_status="$(
      curl \
        --silent \
        --output "${LAST_RESPONSE_FILE}" \
        --write-out '%{http_code}' \
        --max-time 70 \
        "${url}" || true
    )"

    if [[ "${actual_status}" == "503" ]] \
        && grep -Eq '"code"[[:space:]]*:[[:space:]]*"AI_SERVICE_UNAVAILABLE"' "${LAST_RESPONSE_FILE}"; then
      echo "Verified ${label}: HTTP 503 unavailable"
      return 0
    fi
    if [[ "${actual_status}" == "504" ]] \
        && grep -Eq '"code"[[:space:]]*:[[:space:]]*"AI_SERVICE_TIMEOUT"' "${LAST_RESPONSE_FILE}"; then
      echo "Verified ${label}: HTTP 504 timeout"
      return 0
    fi

    echo "Waiting for ${label}: received ${actual_status}"
    sleep "${WAIT_INTERVAL_SECONDS}"
  done

  echo "Timed out waiting for ${label}: expected unavailable/timeout contract" >&2
  echo "Last response body:" >&2
  sed -n '1,80p' "${LAST_RESPONSE_FILE}" >&2
  return 1
}

wait_for_synchronized_catalog_program() {
  local deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
  local actual_count="0"

  while ((SECONDS < deadline)); do
    actual_count="$(
      "${COMPOSE[@]}" exec -T mysql sh -c \
        'mysql --batch --skip-column-names --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "SELECT COUNT(*) FROM support_program WHERE source_code = '\''BIZINFO'\'' AND source_program_id = '\''PBLN_COMPOSE_EXPORT'\'' AND is_source_present = TRUE" 2>/dev/null || true'
    )"

    if [[ "${actual_count}" == "1" ]]; then
      echo "Verified BizInfo synchronization stored PBLN_COMPOSE_EXPORT in MySQL"
      return 0
    fi

    echo "Waiting for synchronized MySQL catalog program: found ${actual_count:-no result} rows"
    sleep "${WAIT_INTERVAL_SECONDS}"
  done

  echo "Timed out waiting for the synchronized MySQL catalog program" >&2
  return 1
}

wait_for_synchronized_startup_programs() {
  local deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
  local actual_count="0"

  while ((SECONDS < deadline)); do
    actual_count="$(
      "${COMPOSE[@]}" exec -T mysql sh -c \
        'mysql --batch --skip-column-names --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "SELECT COUNT(*) FROM support_program WHERE source_code = '\''KSTARTUP'\'' AND source_program_id IN ('\''174321'\'', '\''174322'\'') AND is_source_present = TRUE" 2>/dev/null || true'
    )"

    if [[ "${actual_count}" == "2" ]]; then
      echo "Verified K-Startup synchronization stored both pbanc_sn identities in MySQL"
      return 0
    fi
    echo "Waiting for synchronized K-Startup MySQL programs: found ${actual_count:-no result} rows"
    sleep "${WAIT_INTERVAL_SECONDS}"
  done

  echo "Timed out waiting for synchronized K-Startup MySQL programs" >&2
  return 1
}

echo "Building and starting the GovBiz verification stack (${PROJECT_NAME})"
"${COMPOSE[@]}" up --build --detach --remove-orphans

wait_for_http "Vite web" "${WEB_BASE_URL}/" "200"
wait_for_http "Vite-proxied Core API health" "${WEB_BASE_URL}/api/v1/health" "200" '"status"[[:space:]]*:[[:space:]]*"up".*"service"[[:space:]]*:[[:space:]]*"govbiz-core-service"'
wait_for_http "Vite-proxied Core to AI Service health" "${WEB_BASE_URL}/api/v1/health/ai-service" "200" '"status"[[:space:]]*:[[:space:]]*"up".*"service"[[:space:]]*:[[:space:]]*"govbiz-ai-service"'
verify_application_preparation_flow
wait_for_synchronized_catalog_program
wait_for_synchronized_startup_programs
wait_for_http \
  "All four source snapshots are ready for vector search" \
  "${WEB_BASE_URL}/api/v1/support-programs/readiness" \
  "200" \
  '"sourceCode"[[:space:]]*:[[:space:]]*"BIZINFO"[^}]*"indexReady"[[:space:]]*:[[:space:]]*true' \
  '"sourceCode"[[:space:]]*:[[:space:]]*"KSTARTUP"[^}]*"indexReady"[[:space:]]*:[[:space:]]*true' \
  '"sourceCode"[[:space:]]*:[[:space:]]*"MSIT"[^}]*"indexReady"[[:space:]]*:[[:space:]]*true' \
  '"sourceCode"[[:space:]]*:[[:space:]]*"CNTRADE_NOTICE"[^}]*"indexReady"[[:space:]]*:[[:space:]]*true'

wait_for_http \
  "K-Startup source-only catalog contains both stored programs" \
  "${WEB_BASE_URL}/api/v1/support-programs/catalog?sourceCode=KSTARTUP&status=OPEN" \
  "200" \
  '"total"[[:space:]]*:[[:space:]]*2' \
  '"id"[[:space:]]*:[[:space:]]*"174321"' \
  '"id"[[:space:]]*:[[:space:]]*"174322"'
wait_for_http \
  "Startup stage, applicant type and founder age filters read persisted metadata" \
  "${WEB_BASE_URL}/api/v1/support-programs/catalog?sourceCode=KSTARTUP&startupStage=3%EB%85%84%EB%AF%B8%EB%A7%8C&applicantType=%EC%9D%BC%EB%B0%98%EC%9D%B8&founderAge=%EB%A7%8C%2039%EC%84%B8%20%EC%9D%B4%ED%95%98&status=OPEN" \
  "200" \
  '"total"[[:space:]]*:[[:space:]]*1' \
  '"id"[[:space:]]*:[[:space:]]*"174321"' \
  '"sourceCode"[[:space:]]*:[[:space:]]*"KSTARTUP"' \
  '"targetDescription"[[:space:]]*:[[:space:]]*"[^"]*제외 대상:' \
  '"sourceUrl"[[:space:]]*:[[:space:]]*"https://www\.k-startup\.go\.kr/web/contents/bizpbanc-ongoing\.do\?pbancSn=174321&schM=view"'

wait_for_http \
  "MSIT stores both pages without inventing an application period" \
  "${WEB_BASE_URL}/api/v1/support-programs/catalog?sourceCode=MSIT&status=UNKNOWN" \
  "200" \
  '"total"[[:space:]]*:[[:space:]]*11[,}]' \
  '"id"[[:space:]]*:[[:space:]]*"3186878"' \
  '"id"[[:space:]]*:[[:space:]]*"3186810"' \
  '"applicationStartDate"[[:space:]]*:[[:space:]]*null' \
  '"applicationEndDate"[[:space:]]*:[[:space:]]*null'
wait_for_http \
  "MSIT unknown notices are never listed as confirmed open" \
  "${WEB_BASE_URL}/api/v1/support-programs/catalog?sourceCode=MSIT&status=OPEN" \
  "200" '"total"[[:space:]]*:[[:space:]]*0[,}]'
# CNTRADE_NOTICE is a documentation-contract fixture, not a successful live API probe.
wait_for_http \
  "CNTRADE_NOTICE stores both documentation-fixture pages with unknown status" \
  "${WEB_BASE_URL}/api/v1/support-programs/catalog?sourceCode=CNTRADE_NOTICE&status=UNKNOWN" \
  "200" \
  '"total"[[:space:]]*:[[:space:]]*2[,}]' \
  '"id"[[:space:]]*:[[:space:]]*"900001"' \
  '"id"[[:space:]]*:[[:space:]]*"900002"'
wait_for_http \
  "CNTRADE_NOTICE unknown notices are never listed as confirmed open" \
  "${WEB_BASE_URL}/api/v1/support-programs/catalog?sourceCode=CNTRADE_NOTICE&status=OPEN" \
  "200" '"total"[[:space:]]*:[[:space:]]*0[,}]'
wait_for_http \
  "MSIT detail preserves the validated official announcement identity" \
  "${WEB_BASE_URL}/api/v1/support-programs/detail?sourceCode=MSIT&sourceProgramId=3186878" \
  "200" \
  '"id"[[:space:]]*:[[:space:]]*"3186878"[^}]*"sourceCode"[[:space:]]*:[[:space:]]*"MSIT"' \
  '"status"[[:space:]]*:[[:space:]]*"UNKNOWN"' \
  '"sourceUrl"[[:space:]]*:[[:space:]]*"https://www\.msit\.go\.kr/bbs/view\.do\?sCode=user&mId=311&mPid=121&bbsSeqNo=100&nttSeqNo=3186878"'
wait_for_http \
  "CNTRADE_NOTICE detail honestly links the official list without inventing a detail URL" \
  "${WEB_BASE_URL}/api/v1/support-programs/detail?sourceCode=CNTRADE_NOTICE&sourceProgramId=900001" \
  "200" \
  '"id"[[:space:]]*:[[:space:]]*"900001"[^}]*"sourceCode"[[:space:]]*:[[:space:]]*"CNTRADE_NOTICE"' \
  '"status"[[:space:]]*:[[:space:]]*"UNKNOWN"' \
  '"sourceUrl"[[:space:]]*:[[:space:]]*"https://cntrade\.chungnam\.go\.kr/home/kor/M102638244/board\.do"'

echo "Stopping all upstream stubs to prove that search reads MySQL instead of the public APIs"
"${COMPOSE[@]}" stop bizinfo-stub kstartup-stub public-notices-stub
wait_for_http \
  "New source collection failures retain their published vector-ready snapshots" \
  "${WEB_BASE_URL}/api/v1/support-programs/readiness" \
  "200" \
  '"sourceCode"[[:space:]]*:[[:space:]]*"MSIT"[^}]*"indexReady"[[:space:]]*:[[:space:]]*true[^}]*"lastFailedSyncAt"[[:space:]]*:[[:space:]]*"[0-9]' \
  '"sourceCode"[[:space:]]*:[[:space:]]*"CNTRADE_NOTICE"[^}]*"indexReady"[[:space:]]*:[[:space:]]*true[^}]*"lastFailedSyncAt"[[:space:]]*:[[:space:]]*"[0-9]'
wait_for_http \
  "Stopped MSIT upstream leaves all eleven published notices available" \
  "${WEB_BASE_URL}/api/v1/support-programs/catalog?sourceCode=MSIT&status=UNKNOWN" \
  "200" '"total"[[:space:]]*:[[:space:]]*11[,}]'
wait_for_http \
  "Stopped CNTRADE_NOTICE upstream leaves both published notices available" \
  "${WEB_BASE_URL}/api/v1/support-programs/catalog?sourceCode=CNTRADE_NOTICE&status=UNKNOWN" \
  "200" '"total"[[:space:]]*:[[:space:]]*2[,}]'
VERIFY_HTTP_MEMBER=true wait_for_http \
  "Mixed-source semantic search includes both new unknown-status notice sources" \
  "${WEB_BASE_URL}/api/v1/support-programs/search?query=AI&acceptingOnly=false" \
  "200" \
  '"id"[[:space:]]*:[[:space:]]*"3186878"[^}]*"sourceCode"[[:space:]]*:[[:space:]]*"MSIT"' \
  '"id"[[:space:]]*:[[:space:]]*"900001"[^}]*"sourceCode"[[:space:]]*:[[:space:]]*"CNTRADE_NOTICE"'

VERIFY_HTTP_MEMBER=true wait_for_http \
  "Vite-proxied blank catalog search after BizInfo stub is stopped" \
  "${WEB_BASE_URL}/api/v1/support-programs/search?query=&acceptingOnly=true" \
  "200" \
  '"query"[[:space:]]*:[[:space:]]*""' \
  '"id"[[:space:]]*:[[:space:]]*"PBLN_COMPOSE_EXPORT"' \
  '"applicationPeriod"[[:space:]]*:[[:space:]]*"2026-08-20 ~ 2099-09-11"' \
  '"status"[[:space:]]*:[[:space:]]*"OPEN"' \
  '"sourceUrl"[[:space:]]*:[[:space:]]*"https://www\.bizinfo\.go\.kr/web/lay1/bbs/S1T122C128/AS/74/view\.do\?pblancId=PBLN_COMPOSE_EXPORT"'

# This target is older than 25 irrelevant fixture programs. A latest-20 candidate
# selector cannot pass this check. OpenAI is an HTTP fixture; Qdrant is real.
VERIFY_HTTP_MEMBER=true wait_for_http \
  "Whole-catalog semantic search finds the old relevant AI program" \
  "${WEB_BASE_URL}/api/v1/support-programs/search?query=%EC%84%9C%EC%9A%B8%20AI&acceptingOnly=true" \
  "200" \
  '"id"[[:space:]]*:[[:space:]]*"PBLN_COMPOSE_OLD_AI"' \
  '"id"[[:space:]]*:[[:space:]]*"174321"' \
  '"sourceCode"[[:space:]]*:[[:space:]]*"KSTARTUP"' \
  '"recommendationScore"[[:space:]]*:[[:space:]]*100'

wait_for_http \
  "Stopped K-Startup upstream leaves its published filtered catalog available" \
  "${WEB_BASE_URL}/api/v1/support-programs/catalog?sourceCode=KSTARTUP&startupStage=3%EB%85%84%EB%AF%B8%EB%A7%8C&status=OPEN" \
  "200" \
  '"total"[[:space:]]*:[[:space:]]*1' \
  '"id"[[:space:]]*:[[:space:]]*"174321"'

echo "Stopping only verification Elasticsearch to verify lexical failure isolation"
"${COMPOSE[@]}" stop elasticsearch
# 복구가 먼저 장애를 기록하면 기존 전체 색인 미준비 계약(AI_SERVICE_UNAVAILABLE)이 응답될 수도 있다.
wait_for_http "Lexical outage is an explicit failure, never an empty successful search" \
  "${WEB_BASE_URL}/api/v1/support-programs/search?query=AI&acceptingOnly=true" "503" \
  'SUPPORT_PROGRAM_SEARCH_INDEX_UNAVAILABLE|AI_SERVICE_UNAVAILABLE'
wait_for_http "Repair records lexical unavailability" \
  "${WEB_BASE_URL}/api/v1/support-programs/readiness" "200" \
  '"searchState"[[:space:]]*:[[:space:]]*"UNAVAILABLE"' '"indexReady"[[:space:]]*:[[:space:]]*false'
wait_for_http "Published MySQL catalog remains available during lexical outage" \
  "${WEB_BASE_URL}/api/v1/support-programs/catalog?sourceCode=KSTARTUP&status=OPEN" "200" \
  '"total"[[:space:]]*:[[:space:]]*2'
"${COMPOSE[@]}" up --detach --force-recreate --no-deps --wait elasticsearch
VERIFY_HTTP_MEMBER=true wait_for_http "Hybrid search recovers from persistent Elasticsearch data" \
  "${WEB_BASE_URL}/api/v1/support-programs/search?query=%EC%84%9C%EC%9A%B8%20AI&acceptingOnly=true" "200" \
  '"id"[[:space:]]*:[[:space:]]*"PBLN_COMPOSE_OLD_AI"'

echo "Stopping Qdrant to verify that a vector outage is not hidden as a successful search"
verify_search_result_store
verify_report_broker_recovery
"${COMPOSE[@]}" stop qdrant
wait_for_http \
  "Explicit vector search failure while Qdrant is stopped" \
  "${WEB_BASE_URL}/api/v1/support-programs/search?query=AI&acceptingOnly=true" \
  "503" \
  '"code"[[:space:]]*:[[:space:]]*"AI_SERVICE_UNAVAILABLE"'
# The scheduled repair must first persist the outage. Checking only immediately
# after stopping Qdrant can miss a regression that turns later searches into [].
wait_for_http \
  "Scheduled repair records vector unavailability" \
  "${WEB_BASE_URL}/api/v1/support-programs/readiness" \
  "200" \
  '"searchState"[[:space:]]*:[[:space:]]*"UNAVAILABLE"' \
  '"indexReady"[[:space:]]*:[[:space:]]*false'
wait_for_http \
  "Recorded vector outage stays an explicit natural-language search failure" \
  "${WEB_BASE_URL}/api/v1/support-programs/search?query=AI&acceptingOnly=true" \
  "503" \
  '"code"[[:space:]]*:[[:space:]]*"AI_SERVICE_UNAVAILABLE"'
VERIFY_HTTP_MEMBER=true wait_for_http \
  "Blank latest listing still reads MySQL during vector outage" \
  "${WEB_BASE_URL}/api/v1/support-programs/search?query=&acceptingOnly=true" \
  "200" \
  '"id"[[:space:]]*:[[:space:]]*"PBLN_COMPOSE_EXPORT"'
"${COMPOSE[@]}" start qdrant
VERIFY_HTTP_MEMBER=true wait_for_http \
  "Vector search recovers from persistent Qdrant data" \
  "${WEB_BASE_URL}/api/v1/support-programs/search?query=%EC%84%9C%EC%9A%B8%20AI&acceptingOnly=true" \
  "200" \
  '"id"[[:space:]]*:[[:space:]]*"PBLN_COMPOSE_OLD_AI"'
wait_for_json_post \
  "Vite-proxied sample item preparation" \
  "${WEB_BASE_URL}/api/v1/sample-items/prepare" \
  '{"item":{"name":"Compose verification item","category":"BASIC","note":"Verifies the reusable sample feature."}}' \
  "200" \
  '"phase"[[:space:]]*:[[:space:]]*"READY_FOR_PROCESSING".*"status"[[:space:]]*:[[:space:]]*"NOT_STARTED"'

echo "Stopping only AI Service to verify failure isolation"
"${COMPOSE[@]}" stop ai-service

wait_for_http "Core API health while AI Service is stopped" "${WEB_BASE_URL}/api/v1/health" "200" '"status"[[:space:]]*:[[:space:]]*"up".*"service"[[:space:]]*:[[:space:]]*"govbiz-core-service"'
wait_for_ai_failure "Core to AI Service health failure contract" "${WEB_BASE_URL}/api/v1/health/ai-service"
wait_for_ai_failure \
  "Required AI search failure while AI Service is stopped" \
  "${WEB_BASE_URL}/api/v1/support-programs/search?query=%EC%88%98%EC%B6%9C&acceptingOnly=true"

echo "Restarting AI Service to verify recovery without restarting Core API"
"${COMPOSE[@]}" start ai-service

wait_for_http "Core to AI Service recovery" "${WEB_BASE_URL}/api/v1/health/ai-service" "200" '"status"[[:space:]]*:[[:space:]]*"up".*"service"[[:space:]]*:[[:space:]]*"govbiz-ai-service"'
VERIFY_HTTP_MEMBER=true wait_for_http \
  "Semantic search recovers after AI Service restart" \
  "${WEB_BASE_URL}/api/v1/support-programs/search?query=%EC%84%9C%EC%9A%B8%20AI&acceptingOnly=true" \
  "200" \
  '"id"[[:space:]]*:[[:space:]]*"PBLN_COMPOSE_OLD_AI"'

echo "Compose verification passed: Redis-backed guest result restoration, account ownership, Core restart and Redis AOF recovery; application preparation question/fact flow, four-source fixture synchronization, unknown-status notice boundaries, startup filters, mixed-source semantic results, MySQL listing, Qdrant/AI failure isolation and recovery. CNTRADE_NOTICE uses a documentation fixture, not live API validation."
