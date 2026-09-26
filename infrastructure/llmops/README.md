# LLMOps 개발 환경과 실행

[전략 문서](../../docs/langfuse-adoption-strategy.md) · [근거 답변 평가](../../evaluation/support-program-evidence/README.md)

구현 범위는 근거 답변 추적과 **저장 캡처를 사용하는 수동 평가 파이프라인**이다.
Langfuse 4.15.6, Prefect 3.8.6, pandas 3.0.6, Pandera 0.33.1, Evidently 0.7.23을
AI Service의 `uv.lock`으로 고정한다. 요청 처리에는 Langfuse만 설치하고 나머지는 `evaluation` 그룹으로 설치한다.
AI Service의 로컬·CI·Docker와 평가 실행기·Prefect 서버는 모두 Python 3.12를 사용한다.
AI 프로젝트는 `>=3.12,<3.13`으로 제한하며 `.python-version`과 `uv.lock`에 맞춰 설치한다.

## 개발 서버

저장소 루트에서 실행한다. Docker에는 약 8GB의 메모리를 확보하고, 13000·14200 포트가 비어 있는지 확인한다.
Langfuse Web·Worker, PostgreSQL, ClickHouse, Redis, MinIO와 Prefect를 별도 Compose 프로젝트에 둔다.
이미지는 digest로 고정하며 업무 서비스의 데이터베이스·볼륨을 공유하지 않는다.

```bash
python3 infrastructure/llmops/init_env.py
docker compose --env-file infrastructure/llmops/.env \
  -f infrastructure/llmops/compose.yaml --profile evaluation up -d
```

생성한 `.env`는 Git에서 제외되고 권한은 `0600`이다. 기존 파일은 덮어쓰지 않는다.
초기 DB migration과 사용자 생성이 끝날 때까지 수 분이 걸릴 수 있다.
Langfuse는 [localhost:13000](http://localhost:13000), Prefect는 [localhost:14200](http://localhost:14200)에서 확인한다.
Langfuse 이메일은 `llmops@localhost.test`, 비밀번호는 생성한 파일의 `LANGFUSE_ADMIN_PASSWORD`다.
두 UI는 loopback에만 공개한다. Prefect의 이 개발 구성에는 별도 인증을 설정하지 않는다.

개발 데이터는 named volume에 남는다. **7일 자동 삭제 정책은 아직 설정하지 않았다.**
운영 배포·보존 정책·외부 접근 인증은 별도 운영 작업이다.
종료할 때 다음 명령은 컨테이너만 정리하며 기록 볼륨은 유지한다.

```bash
docker compose --env-file infrastructure/llmops/.env \
  -f infrastructure/llmops/compose.yaml --profile evaluation down
```

## 무료 전체 검증

```bash
cd backend/ai-service
uv sync --locked --extra dev --group evaluation
cd ../..
set -a
source infrastructure/llmops/.env
set +a
backend/ai-service/.venv/bin/python infrastructure/llmops/smoke.py \
  --output-dir work/llmops-verification-001
```

새 출력 디렉터리를 지정한다. 검증은 다음을 실제 로컬 서버에서 확인하며 OpenAI API를 호출하지 않는다.

- 실제 답변 Service·Agent와 HTTP 모델 스텁을 통과한 정상·실패 trace 저장 및 조회
- 부모·자식 span 연결, 본문·키 미수집
- 6개 가상 사례의 저장 캡처를 pandas 표로 변환하고 Pandera로 입력·결과 검증
- Evidently 보고서와 Langfuse 점수 저장·조회
- 같은 캡처 재실행 시 동일한 평가 실행 ID·점수 ID 사용
- 정상 두 번과 잘못된 입력 한 번의 Prefect 서버 상태 `COMPLETED / COMPLETED / FAILED`

`verification.json`에 검증 결과가, 각 실행 폴더에는 `manifest.json`, `results.json`, `comparison.json`,
`report.html`, `evidently.json`이 남는다. 실패한 실행은 이미 만든 부분 산출물을 보존하고 manifest에 실패를 기록한다.
보고서에는 실행 ID와 기준 실행 ID가 있고, Langfuse 점수 metadata에는 동일한 평가 실행 ID가 있다.

## 저장 캡처 평가

위 설치와 환경변수 설정 뒤 저장소 루트에서 실행한다.

```bash
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/llmops.py \
  --fixture evaluation/support-program-evidence/target-coverage-fixture.json \
  --capture evaluation/support-program-evidence/runs/target-coverage-20260907-v1/capture.json \
  --reference evaluation/support-program-evidence/runs/target-coverage-20260907-v1/capture.json \
  --output-dir work/llmops-evaluation-001
```

이 예제는 같은 캡처의 재현 확인이다. 보고서의 `self-replay`는 모델 품질 개선을 뜻하지 않는다.
후보 캡처를 비교할 때는 같은 fixture와 선택 사례 목록을 사용한다.
실패·누락 사례를 제거하지 않으며, 부분 실행에는 전체 상태 일치율·인용 재현율을 내지 않는다.
미측정 의미 충실도는 계속 `null`이고, 참조 자료는 AI 작성 가상 사례로 표시한다.

기존 계산 함수를 재사용하며 표 집계와 기존 보고서의 값이 다르면 실패한다.
과거 캡처에는 새 모델 trace를 만들지 않고 평가 실행 ID에 session 점수를 연결한다.
새 평가의 실제 `traceId`가 있으면 해당 trace에 연결한다.
평가 실행 ID는 fixture·캡처·평가 코드 해시로 정하고 점수 ID에는 사례와 지표 이름도 포함한다.
등록·보고서 작업은 저장 결과로 한 번 재시도한다. 모델 실행 단계는 이 flow에 없으므로 모델 호출 예산은 0이다.
한 checkout의 수동 평가는 파일 잠금으로 동시 실행을 차단한다. 여러 호스트 배포·스케줄·전역 동시성 제어는 후속 범위다.

새 캡처는 사례별 `apiResponseIndexes`로 토큰 기록을 연결한다. 과거 캡처처럼 사례와 API 사용량의 연결 정보가 없으면
토큰은 `null`로 둔다. 지연·토큰 미제공을 0으로 집계하지 않는다.

## 실제 AI Service 추적 활성화

`LANGFUSE_ENABLED=false`가 기본값이다. 활성화 시 `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY`를 명시해야 한다. `LANGFUSE_ENVIRONMENT`는 기본 `development`, `GIT_SHA`는
빌드 커밋을 확정한 경우 설정한다. 서버의 Langfuse 환경변수를 읽은 뒤 기존 AI Service 실행 명령을 사용한다.
서비스용 `OPENAI_API_KEY` 등 기존 설정은 별도로 필요하다. smoke 검증에는 필요하지 않다.

호출 흐름은 `HTTP /answers → AnswerService → AnswerAgent → LangChain → OpenAI`다.
`evidence.answer`에는 Service의 인용 검증까지, 하위 `evidence.model`에는 모델·토큰·지연을 기록한다.
LangChain 자동 콜백은 붙이지 않고 명시적인 두 span만 내보내므로 공통 LLM 호출부와 다른 기능의 추적 정책은 유지한다.
질문·답변·청크 본문과 예외 원문은 기록하지 않는다. 정상 근거 부족과 시스템 오류·시간 초과·취소를 구별한다.
Langfuse 전송 실패는 로컬 로그로 드러내며 모델 호출을 반복하지 않는다. 종료 대기는 최대 5초다.

기존 `evaluate.py --execute`도 같은 추적 초기화·종료를 사용하며 새 사례에 `traceId`를 남긴다.
이 기존 명령은 **유료 모델 실행**이므로 승인한 자료·호출 예산을 정한 경우에만 사용한다.
저장 캡처 재계산과 위 smoke 명령은 이 실행 모드를 사용하지 않는다.

업무 Compose의 AI 컨테이너에서 연결할 경우 `localhost`는 컨테이너 자신이다.
Docker Desktop에서는 `LANGFUSE_BASE_URL=http://host.docker.internal:13000`을 사용한다.
Linux에서는 두 Compose 네트워크의 연결 또는 호스트 게이트웨이 설정을 별도로 준비해야 한다.

## 테스트와 CI

```bash
cd backend/ai-service
uv run --locked --extra dev --group evaluation python -m pytest \
  tests/test_config.py tests/test_bootstrap.py tests/test_container_image_contract.py \
  tests/support_program_evidence/test_agent.py tests/support_program_evidence/test_tracing.py \
  ../../evaluation/support-program-evidence
```

[GovBiz CI](../../.github/workflows/ci.yml)는 기존 전체 AI 검증과 평가 도구 무료 테스트를 유지한다.
[LLMOps CI](../../.github/workflows/llmops-ci.yml)는 Python 3.12에서 실제 로컬 Langfuse·Prefect 저장·조회 검증을 수행한다.
AI·평가 도구 테스트는 동일한 Python 3.12의 GovBiz CI에서 수행하며 별도의 다중 버전 작업은 두지 않는다.
워크플로 추가는 원격 CI 통과나 브랜치 보호 설정 완료를 뜻하지 않는다.

2026-09-26 버전 통일 후 로컬 가상환경을 Python 3.12.14로 다시 구성했다.
`uv lock --check`와 설치된 188개 패키지의 `uv pip check`가 통과했으며, 위 선택 테스트는 **305개 통과**했다.
추적 검증 16개와 평가 파이프라인 검증 17개, 기존 설정·bootstrap·Agent·평가 도구 회귀를 포함한다.
평가 실행기의 실제 `execute()` 경로도 Langfuse 활성화·비활성화와 정상·실패 8종을 조합한 16개 테스트가
Python 3.12에서 통과했다. 저장한 `traceId`와 Service·Agent span의 연결, 응답별 토큰 기록 연결,
본문·키 제외 및 HTTP 클라이언트 종료를 검증했다. 모델 HTTP와 trace export는 테스트 대역을 사용하며,
이 검증을 실제 모델 품질 측정이나 AI Docker 이미지 검증으로 해석하지 않는다.
Prefect 개발 컨테이너도 Python 3.12.14 이미지로 갱신했고, 통일 후 실제 개발 서버 검증 기록은
`work/llmops-python312/verification.json`에 있다. 이 기록에는 평가 실행기의 Python 버전도 남긴다.
정상·실패 trace 2건, 평가 점수 22개의 등록·조회와 동일 ID 재등록, Prefect 정상 두 번·입력 오류 한 번의 상태를 확인했다.
모델 API 호출은 0회다. 원격 CI 전체 검증, AI Docker 이미지 재빌드와 운영 배포는 아직 실행하지 않았다.
