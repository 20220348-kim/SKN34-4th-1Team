#!/bin/sh
# Compose의 demo-seed 서비스 진입점입니다. MySQL 컨테이너 이미지(mysql:8.4)의 sh에서 실행되므로 POSIX sh만 씁니다.
# Keep this entrypoint LF-terminated; the root .gitattributes enforces it.
#
# 1. DEMO_SEED_ENABLED가 true가 아니면 아무것도 하지 않고 끝납니다.
# 2. 데모 계정이 이미 있으면 공용 자료를 보존하고 두 개인 작업 seed만 증분 실행합니다.
# 3. core-service가 healthy(=Flyway 마이그레이션 완료)여야 시작되며, 모집글이 붙을 기업마당 공고가 동기화될 때까지 기다립니다.
# 4. 신규 DB와 강제 실행은 공용 seed 뒤에 신청 준비와 중복 검토 seed를 순서대로 실행합니다.
set -eu

if [ "${DEMO_SEED_ENABLED:-false}" != "true" ]; then
  echo "demo-seed: DEMO_SEED_ENABLED is not true; skipping."
  exit 0
fi

SEED_FILE="${DEMO_SEED_FILE:-/seed/demo-data.sql}"
APPLICATION_SEED_FILE="$(dirname "${SEED_FILE}")/application-preparations.sql"
COMBINATION_SEED_FILE="$(dirname "${SEED_FILE}")/combination-reviews.sql"
WAIT_SECONDS="${DEMO_SEED_WAIT_SECONDS:-600}"
REQUIRED_PROGRAMS="${DEMO_SEED_REQUIRED_PROGRAMS:-5}"
HOST="${MYSQL_HOST:-mysql}"
# 데모 데이터가 들어갔는지 판단하는 대표 계정입니다. demo-data.sql의 첫 데모 계정과 같아야 합니다.
MARKER_EMAIL="${DEMO_SEED_MARKER_EMAIL:-jihoon.park@demo.govbiz.local}"

if [ ! -f "${SEED_FILE}" ]; then
  echo "demo-seed: seed file ${SEED_FILE} is missing." >&2
  exit 1
fi
if [ ! -f "${APPLICATION_SEED_FILE}" ]; then
  echo "demo-seed: seed file ${APPLICATION_SEED_FILE} is missing." >&2
  exit 1
fi
if [ ! -f "${COMBINATION_SEED_FILE}" ]; then
  echo "demo-seed: seed file ${COMBINATION_SEED_FILE} is missing." >&2
  exit 1
fi

# 이메일 값은 SQL 문자열로 직접 조립하지 않고 hex로 인코딩한 뒤 세션 변수로 복원합니다.
TARGET_EMAILS_HEX="$(printf '%s' "${DEMO_SEED_TARGET_EMAILS:-}" | od -An -v -tx1 | tr -d ' \n')"
MARKER_EMAIL_HEX="$(printf '%s' "${MARKER_EMAIL}" | od -An -v -tx1 | tr -d ' \n')"

query() {
  mysql --host="${HOST}" --user="${MYSQL_USER}" --password="${MYSQL_PASSWORD}" --default-character-set=utf8mb4 \
    --silent --skip-column-names "${MYSQL_DATABASE}" -e "$1"
}

reset_personal_demo_data=0
if [ "${DEMO_SEED_FORCE:-false}" = "true" ]; then
  reset_personal_demo_data=1
fi

load_personal_seed() {
  personal_seed_file="$1"
  echo "demo-seed: loading ${personal_seed_file}"
  {
    printf "SET @demo_seed_target_emails = CONVERT(X'%s' USING utf8mb4);\n" "${TARGET_EMAILS_HEX}"
    printf 'SET @reset_personal_demo_data = %s;\n' "${reset_personal_demo_data}"
    cat "${personal_seed_file}"
  } | mysql --host="${HOST}" --user="${MYSQL_USER}" --password="${MYSQL_PASSWORD}" --default-character-set=utf8mb4 \
    "${MYSQL_DATABASE}"
}

if [ "${DEMO_SEED_FORCE:-false}" != "true" ]; then
  existing="$(query "SELECT COUNT(*) FROM account WHERE email = CONVERT(X'${MARKER_EMAIL_HEX}' USING utf8mb4)")"
  if [ "${existing:-0}" -ge 1 ]; then
    echo "demo-seed: preserving existing public demo data; adding missing personal demo rows."
    load_personal_seed "${APPLICATION_SEED_FILE}"
    load_personal_seed "${COMBINATION_SEED_FILE}"
    echo "demo-seed: personal demo rows ready."
    exit 0
  fi
fi

# 접수 마감이 3주 이상 남은 기업마당 공고가 모집글 수만큼 있어야 합니다. 공고 동기화는 core-service가 기동 직후 시작합니다.
waited=0
while :; do
  count="$(query "SELECT COUNT(*) FROM support_program WHERE source_code = 'BIZINFO' AND application_end_date >= DATE_ADD(CURDATE(), INTERVAL 21 DAY)" 2>/dev/null || echo 0)"
  if [ "${count:-0}" -ge "${REQUIRED_PROGRAMS}" ]; then
    break
  fi
  if [ "${waited}" -ge "${WAIT_SECONDS}" ]; then
    echo "demo-seed: only ${count:-0} open BizInfo programs after ${WAIT_SECONDS}s (need ${REQUIRED_PROGRAMS})." >&2
    echo "demo-seed: check BIZINFO_API_KEY and the catalog sync, then run: docker compose run --rm demo-seed" >&2
    exit 1
  fi
  echo "demo-seed: waiting for the BizInfo catalog sync (${count:-0}/${REQUIRED_PROGRAMS} open programs, ${waited}s)"
  sleep 10
  waited=$((waited + 10))
done

echo "demo-seed: loading ${SEED_FILE}"
mysql --host="${HOST}" --user="${MYSQL_USER}" --password="${MYSQL_PASSWORD}" --default-character-set=utf8mb4 \
  "${MYSQL_DATABASE}" < "${SEED_FILE}"
load_personal_seed "${APPLICATION_SEED_FILE}"
load_personal_seed "${COMBINATION_SEED_FILE}"
echo "demo-seed: done. Each selected account now owns its own application preparation and combination review demos."
