#!/usr/bin/env bash
set -Eeuo pipefail
cd "${CODEBUILD_SRC_DIR:?Run this entrypoint in CodeBuild}"

# Runs in an isolated, disposable CodeBuild Docker daemon, never on production.
export JAVA_TOOL_OPTIONS="-Dspring.test.context.cache.maxSize=2"
(cd backend/core-service && ./gradlew clean build --no-daemon)

qdrant_id="$(docker run --detach --publish 127.0.0.1:6333:6333 qdrant/qdrant:v1.17.1)"
cleanup_qdrant() { docker rm --force "${qdrant_id}" >/dev/null; }
trap cleanup_qdrant EXIT
export QDRANT_TEST_URL=http://127.0.0.1:6333
python3 - <<'PY'
import time, urllib.request
for attempt in range(30):
    try:
        urllib.request.urlopen('http://127.0.0.1:6333/readyz', timeout=2).close()
        break
    except OSError:
        if attempt == 29:
            raise
        time.sleep(1)
PY
(
  cd backend/ai-service
  uv lock --check
  uv sync --locked --extra dev
  uv pip check --python .venv/bin/python
  uv run --locked --extra dev python -m pytest
  uv build
  uv run --locked --extra dev python -m pytest ../../evaluation/support-program-evidence
)
cleanup_qdrant
trap - EXIT
python3 -B -m unittest discover -s infrastructure/scripts -p 'test_*.py'
python3 -B -m unittest discover -s infrastructure/codebuild -p 'test_*.py'
(
  cd evaluation/support-program-search
  ../../backend/ai-service/.venv/bin/python -m unittest discover
  python3 -B -m unittest discover -s review -p 'test_*.py'
  python3 -B review/verify-shared-run.py --run-dir runs/support-program-catalog-20260906-v1 --with-capture
  python3 -B compare_elasticsearch.py --fixture runs/support-program-catalog-20260906-v1/review-final-v1/fixture-labeled.json --verify-report runs/elasticsearch-nori-20260912-v1/report.json
  python3 -B compare_korean_queries.py --fixture runs/support-program-catalog-20260906-v1/review-final-v1/fixture-labeled.json --questions runs/elasticsearch-korean-queries-20260912-v1/questions.json --verify-report runs/elasticsearch-korean-queries-20260912-v1/report.json
)

export VERIFY_COMPOSE_PROJECT_NAME="govbiz-codebuild-${CODEBUILD_BUILD_NUMBER:?}"
export VERIFY_COMPOSE_KEEP_RUNNING=false
export OPENAI_API_KEY=compose-verification-key-never-sent
docker compose --project-name "${VERIFY_COMPOSE_PROJECT_NAME}" --file infrastructure/compose.yaml config --quiet
bash infrastructure/scripts/verify-compose.sh
python3 infrastructure/scripts/verify-production-proxy.py
