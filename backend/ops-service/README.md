# GovBiz Ops Service

LLMOps·관리자 시스템 개발을 위한 Django 서비스이며, `GovBiz` 모노레포의
`backend/ops-service`에서 관리합니다. 같은 저장소의 Core API·AI Service와 코드를 함께
관리하지만, Django 프로세스와 Ops 데이터베이스는 독립적으로 실행합니다.

소스 디렉터리·Compose 서비스·Kubernetes Deployment/Service/컨테이너 이름은 `ops-service`로 통일했습니다.
DB 컨테이너·내부 DNS는 `ops-mysql`, Python 패키지·health 응답은 `govbiz-ops-service`,
Kubernetes 검증 이미지 접두사는 `govbiz-ops-service`입니다.
이전 `.env.compose`에 `GOVBIZ_DJANGO_ENV_FILE=./backend/ops/.env`를 지정했다면
값을 `./backend/ops-service/.env`로 갱신하세요. 실제 비밀값과 데이터 볼륨은 바꾸지 않습니다.

[GovBiz-Team/GovBiz-ops](https://github.com/GovBiz-Team/GovBiz-ops)의 커밋
[`611232de21f69689c4024f3935b8d693b03b7777`](https://github.com/GovBiz-Team/GovBiz-ops/commit/611232de21f69689c4024f3935b8d693b03b7777)
추적 파일을 가져온 스냅샷입니다. 원본 Git 이력은 원래 저장소에 보존되며,
이 디렉터리는 서브모듈이 아닙니다. 실제 `.env`, 로컬 가상환경·Git 메타데이터는
가져오지 않았습니다.

현재 범위는 상태 확인 API, 기존 Core 관리자 인증 연동, 저장 응답 재평가·승인 기반 새 모델 평가 실행·이력·결과,
관리자 응답 검토·비교 기준 지정·실패 후처리 복구 API와
Gunicorn 이미지입니다. 공고·회원·신청 관리 업무와 기존 Spring Boot/FastAPI의
운영 데이터는 이전하지 않았습니다. 운영 배포는 별도입니다.

## 기술 구성

- Python 3.12
- Django 5.2 LTS, Django REST Framework
- Gunicorn 26.2 WSGI 실행 서버(배포 이미지 기본값)
- MySQL 8.4, `utf8mb4`
- uv 0.12.5와 `uv.lock`을 통한 의존성 고정
- Ruff, Django 테스트 러너
- Docker Compose, GitHub Actions CI

기존 웹의 관리자 계정으로 로그인합니다. Django는 요청마다 `govbiz_session` 쿠키만 Core의
`GET /api/v1/admin/session`에 전달해 현재 세션과 `ADMIN` 권한을 확인합니다. 로그아웃·만료·정지·
권한 변경이 다음 Ops 요청에 반영됩니다. Core 연결 실패는 `503`으로 거절합니다.
Django 사용자 행은 `core:{회원 ID}`와 이메일로 실행 요청자를 연결하며 로그인 가능한 비밀번호를
저장하지 않습니다. 이전 Django 운영자 세션이나 `is_staff` 값으로는 API에 접근할 수 없습니다.
회원 DB·JWT 서명 키는 Core만 소유하고 쓰기 요청에는 Django CSRF 검증도 적용합니다.

## LLMOps 운영 화면

첫 전체 실행은 [LLMOps 개발 환경](../../infrastructure/llmops/README.md#django-운영-화면)을 따르세요.
화면은 `frontend/web`의 React가 [localhost:5173/ops/evaluations](http://localhost:5173/ops/evaluations)에서
제공하고 Django는 18001 포트의 `/api/v1/ops` API를 담당합니다. 기존 Django 화면 주소는
`OPS_WEB_URL`(기본 `http://localhost:5173`)로 이동합니다. 아래 단독 Ops 구성은 8001 포트이므로
웹의 `OPS_DEV_PROXY_TARGET=http://127.0.0.1:8001` 설정과 평가 실행기 연결이 별도로 필요합니다.
루트 통합 Compose는 Django에서 `http://core-service:8080`으로 관리자 세션을 확인합니다.
전용 LLMOps Compose는 호스트 Core를 사용하며 회원 DB를 공유하지 않습니다.

- React: 기존 `/login`으로 로그인 후 Ops 복귀, 평가 요청·목록, 실행 상세·결과 요약, 보고서 링크
- Django: Core 관리자 확인, CSRF 토큰, 평가 요청·조회, 인증된 HTML 보고서 API
- Core: 기존 로그인·로그아웃과 관리자 세션 검증. 일반 회원은 Ops 접근 불가
- 가상 6건 재현과 과거 프롬프트 실행의 공통 E01 비교를 선택 가능; 임의 경로·코드를 요청으로 받지 않음; 모델은 서버가 제시한 승인 설정과 일치해야 함
- 후보는 서버의 `apps/evaluations/capture_catalog.json` 등록 캡처 또는 승인된 새 응답 생성만 허용. 기준은 같은 자료의 등록 캡처 또는 관리자가 검토 후 지정한 완료 실행을 허용
- `EvaluationRun`: 요청 UUID, 요청자·자료·기준/후보·상태·시간, Prefect 실행 ID, 콘텐츠 평가 ID, 요약·비교 저장
- 요청 UUID를 DB 기본 키와 Prefect idempotency key로 사용; 같은 요청 재전송은 같은 실행을 반환
- Prefect 접수 응답 유실 시 `REQUESTED`와 오류 코드를 유지; 같은 요청으로 접수 재확인 가능
- 상태 원본은 Prefect. 상세/API 조회가 DB의 마지막 상태를 갱신하고 상세 화면은 진행 중 5초 간격으로 조회
- 연결 장애는 마지막 상태와 오류를 함께 표시. 실패·취소·프로세스 중단·결과 확인 실패를 구별
- Prefect 완료와 결과 파일의 요청·선택 캡처 연결, 비교 JSON·보고서 해시를 모두 확인해야 Ops에서 완료 처리
- 평가 프로세스는 결과 볼륨에 쓰고 Django는 읽기 전용으로 접근. 보고서는 운영자 인증과 CSP sandbox 적용
- 과거 캡처에는 trace가 없으므로 Langfuse 세션 상세 대신 평가 ID로 필터링한 점수 목록에 연결

호출 흐름은 `React 운영 화면 → 같은 origin 프록시 → Django 인증·API → 평가 Service → Prefect HTTP API → 상시 평가 실행기`
입니다. 인증 경로는 `Django → Core 관리자 API → AdminPrincipalArgumentResolver → AccountSessionService`입니다. 실행기는 기존 `pandas → Pandera → 지표 재계산 → Evidently / Langfuse` 흐름을 사용합니다.
Django HTTP 요청 안에서는 평가하지 않으며 Django에 평가 SDK 전체를 설치하지 않습니다.
별도 Celery·Airflow·LLM provider는 추가하지 않았습니다. 저장 응답 재평가는 모델 호출 0회이며, 새 응답 생성은 아래 승인 계약을 따릅니다.

## 새 응답 생성 API

설정은 [LLMOps 실행 문서](../../infrastructure/llmops/README.md#ops에서-새-모델-평가)를 따릅니다.
`LLMOPS_LIVE_ENABLED=false`가 기본입니다. `GET /api/v1/ops/session`은 `live_enabled`와 자료별
`live_config`(모델, fixture SHA-256, 최대 호출 수, 호출당 최대 출력 토큰)를 반환합니다.
POST는 기존 요청에 `execution_mode: "live"`, `candidate_capture_id: "new-model-response"`,
`live_config: <사용자가 확인한 session의 명세>`, `confirm_paid_run: true`,
`execution_profile: <session의 execution_profiles.live>`를 함께 전송해야 합니다.
기준 캡처는 같은 자료의 등록 캡처 또는 현재 검토 기준 실행만 가능합니다. 명세 불일치·미확인·비활성화는 DB 생성 전에 400입니다.
기존 요청 키로 실행 방식·승인 명세를 바꾸면 409이며 접수 재확인은 같은 명세를 유지합니다.

Migration `0003_evaluationrun_live`는 실행 방식·승인 명세·실제 호출 시도 수를 추가합니다.
기존 실행은 replay/0회로 유지합니다. 새 실행의 아직 확인되지 않은 호출 수는 null입니다.
실패한 실행도 부분 캡처가 있으면 시도 횟수를 표시하며 미확인 값을 0으로 만들지 않습니다.
비교 단계 manifest의 `model_api_calls: 0`은 **저장된 새 캡처를 채점하는 단계만** 뜻합니다.
Ops 응답의 `model_api_calls`는 새 응답 생성 단계의 `capture.modelApiCalls`를 확인한 값입니다.
완료 판정에는 기존 보고서 검증 외에 새 캡처 해시·모델·자료·사례·예산 확인이 필요합니다.
`trace_links`는 사례별 Langfuse 추적/점수 링크이며 과거 캡처는 기존 점수 목록 링크를 사용합니다.

## 누적 호출·출력 토큰 한도

Ops로 접수한 새 응답 생성은 `EvaluationBudget`의 **DB 전체 누적 호출 수·출력 토큰 한도**를
공유합니다. 사용자·자료·실행기별로 별도 한도를 만들어 우회하지 않습니다. 예약·확정·미확인 사용량을
합산하며, 달력 기준 자동 초기화는 없습니다. 입력 토큰은 확인된 사용량을 기록하지만 제한하지 않으므로
이 기능은 원화/달러 지출 상한이 아닙니다. 수동 `evaluate.py --execute`와 전체 RAG 도구는 이 Ops 장부의
적용 대상이 아니며 별도 승인·한도 관리가 필요합니다.

호출 흐름은 `관리자 접수 → MySQL 전역 한도 잠금·예약 → Prefect → 실행기 소유권 확보 →
각 모델 전송 전 Ops 승인 → 모델 응답 사용량 정산 → 실행 종료 시 미사용 예약 반환`입니다.

- 같은 UUID 재전송은 같은 예약을 사용합니다. 신규 UUID는 같은 DB 행을 잠그고 원자적으로 예약합니다.
- 실행기에는 매 프로세스마다 새 소유자 UUID를 부여합니다. 같은 작업의 다른 소유자와 중복 호출 번호는 거절합니다.
- 전송 승인 응답이 유실되면 다시 승인받아 모델을 재호출하지 않습니다. 해당 호출은 미확인 예약으로 남습니다.
- 입력·출력·총 토큰이 정수이고 합계·출력 한도가 맞는 응답만 정산합니다. 사용량 누락·DB 장애·정산 실패는 다음 호출을 차단합니다.
- 종료가 확인된 실행은 미전송 몫과 확인된 출력 차액만 반환합니다. 전송 후 timeout·사용량 미확인은 호출 1회와 최대 출력 예약을 유지합니다.
- 강제 종료·접수 미확인·실행 전 오류로 종료 확인까지 도달하지 못한 예약은 자동 환급하지 않습니다.
  사람이 실행·공급자 사용량을 대조하는 복구 절차는 후속 과제이며 DB 값을 임의로 0으로 바꾸지 않습니다.

적용 순서는 같은 버전의 Ops·실행기를 빌드하고 additive migration `0011_cumulative_budget`를 적용한 뒤,
양쪽에 동일한 `LLMOPS_BUDGET_TOKEN`을 주입하는 것입니다. 32자 이상의 무작위 비밀값을 사용하며
관리자 쿠키·모델 API 키와 공유하지 않습니다. 실행기의 `LLMOPS_OPS_API_URL`은 Ops의 내부 주소입니다.
과거 live 접수에 예약을 소급 생성하지 않으며, 예약이 없는 기존 미전송 요청은 차단합니다.

운영자가 승인한 한도만 아래 명령으로 설정합니다. 예시는 형식 설명이며 실행 승인이 아닙니다.

```bash
# backend/ops-service, 승인된 환경변수 값을 사용
uv run --locked python manage.py set_evaluation_budget --calls "$APPROVED_CALL_LIMIT" --output-tokens "$APPROVED_OUTPUT_TOKEN_LIMIT"
```

이 명령은 사용량을 초기화하거나 live를 활성화하지 않습니다. 기존 예약·확정 합계보다 낮은 한도는
거절합니다. 미설정·한도 부족·실행기 인증 미설정 상태의 신규 접수는 HTTP 400
`LIVE_BUDGET_UNAVAILABLE`로 거절하며 Prefect에 전송하지 않습니다. 기존 자료·모델 동의와
`LLMOPS_LIVE_ENABLED` 조건도 계속 필요합니다.

실행기 전용 API는 `POST /internal/llmops/evaluations/{run_id}/budget/{claim|authorize|settle|close}`이며,
별도 Bearer 비밀값과 실행 UUID·명세 해시·소유자 UUID를 확인합니다. 사용자 세션 API와 인증을 공유하지 않습니다.
기본 한도를 넣거나 스케줄·유료 평가를 자동 활성화하지 않습니다.

## 접수 시 실행 명세 고정

새 접수는 session의 `datasets[].execution_profiles.replay` 또는 `.live`를
`execution_profile`로 전송합니다. 현재 서버 명세와 다르면 DB 생성·Prefect 전송 전에 `400`입니다.
같은 UUID에 다른 명세를 보내면 `409`이며, 접수 응답 유실 후 재전송은 최초 명세를 유지합니다.
React가 쓰기 직전 세션을 다시 조회해도 사용자가 확인한 명세를 최신 값으로 자동 교체하지 않습니다.

`0009_execution_spec`은 `execution_spec` JSON과 `execution_spec_sha256`을 추가합니다.
서버가 생성한 명세에 순서가 있는 사례 ID, fixture·후보·기준 해시, 평가 코드·잠금 의존성,
실행 흐름 코드, 검토 기준 버전·승인 ID를 고정합니다. 새 응답 생성에는 모델·프롬프트·
Agent/Service/공통 호출 코드·출력 제한·추론·timeout·재시도 설정도 포함합니다.
Django에는 모델 SDK를 추가하지 않았습니다.

흐름: `React 확인 식별자 → Django DB 명세 고정 → Prefect → 실제 실행 파일·입력 검증 → 생성/평가`.
`request.json`은 명세 전체와 SHA-256을, 평가 `manifest.json`은 같은 SHA-256을 기록합니다.
Ops는 결과의 명세·평가기·선택 사례·입력 해시를 확인한 뒤 완료로 표시합니다.
실행기의 `preflight.json`이 요청과 일치하고 호출 전 거절을 입증할 때만 실패 호출 수를 0으로 확정합니다.
전송 후 timeout 등 확인되지 않은 호출 수는 계속 `null`입니다.

- `EXECUTION_SPEC_MISMATCH`: 접수 조건과 실행 파일·입력·설정 불일치. 실행기를 확인하고 새 조건을 검토합니다.
- `EXECUTION_SPEC_REQUIRED`: 명세가 없는 구형 미접수 요청을 최신 기본값으로 실행하지 않습니다.
  먼저 기존 Prefect 접수 여부를 확인합니다. 기존 실행 조회는 계속 가능합니다.
- 구형 완료·검토 기록에는 명세를 소급 생성하지 않습니다. 화면에 **기존 기록 · 실행 명세 없음**을 표시합니다.
- 저장 응답 재평가는 과거 모델·프롬프트가 달라도 가능합니다. 이번 평가기와 입력만 고정합니다.
- 후처리 복구는 원본 manifest의 평가기와 현재 평가기가 같아야 합니다. 검증 불가·버전 변경이면 복구를 차단합니다.
  예전 두 파일 해시만 있는 기록은 새 의존성 포함 평가기와 동일함을 입증할 수 없어 복구 대상이 아닙니다.
- 활성 기준의 교체·해제는 이미 접수된 기준 스냅샷을 바꾸지 않습니다.

명세 생성·이미지 갱신·불일치 smoke는 [LLMOps 실행 명세 운영](../../infrastructure/llmops/README.md#실행-명세-생성과-갱신)을 따릅니다.

## 응답 검토와 비교 기준

완료 상세의 **응답 검토와 기준 지정**에서 선택된 모든 사례의 질문·제공 근거·후보 답변·기존 기준 답변을
확인합니다. 각 사례를 **적합 / 부적합 / 판단 보류**로 판단하고 사유를 저장합니다. 필수 사례 전체에
현재 자료·응답 해시와 검토 기준 버전이 일치하는 적합 기록이 있어야 전체 승인할 수 있습니다.
전체 승인과 비교 기준 지정은 별도 동작입니다. 새 기준 지정에는 아래의 유효한 품질 합격도 필요합니다.
기준은 데이터셋별 하나이며 사례별 검토 또는 전체
검토가 바뀌면 그 실행의 승인 자격과 기준 지정은 해제됩니다. 이전 판단과 승인 이력은 보존됩니다.
AI 작성 참조 자료의 출처와 미측정 의미 충실도는 검토 승인으로 바뀌지 않습니다.

- `GET /api/v1/ops/evaluations/{id}/review`: 해시 검증을 거친 사례·근거, 전체/사례 검토 이력, `review_version`,
  `rubric`, `can_approve`, `approval_current`, `baseline_requires_review`, 현재 기준 여부
- `POST .../{id}/case-review`: `case_id`, `decision` (`SUITABLE` / `UNSUITABLE` / `DEFERRED`),
  `comment` (1~3000자), `capture_sha256`, `fixture_sha256`, `rubric_version`, `review_version`
- `POST .../{id}/review`: `decision` (`APPROVED` / `CHANGES_REQUESTED`), `comment` (1~3000자),
  `capture_sha256`, `fixture_sha256`, `rubric_version`, `review_version`
- `POST .../{id}/baseline`: `review_id`, `baseline_version`(검토 GET에서 확인한 현재 버전); 완료 파일·최신 승인 기록·버전이 일치해야 지정 가능
- `DELETE .../{id}/baseline`: `baseline_version`, `reason`(1~3000자); 해당 실행이 현재 기준일 때 해제. 오래된 버전은 409
- session의 데이터셋별 `baseline`은 현재 기준 선택지 또는 null. 새 평가의 `reference_capture_id`에
  `run:<요청 UUID>`와 선택지의 `version`을 `baseline_version`으로 함께 전송하며 임의 UUID·다른 자료·미승인 실행은 거절
- 접수 시 `reference_config`에 기준 UUID·캡처/fixture SHA-256을 서버가 고정. 실행기는 이를 재검증하고
  `reference-capture.json`을 실행 폴더에 보존. 나중의 기준 교체·철회는 이미 접수한 실행을 변경하지 않음
- 원본 파일을 확인할 수 없거나 해시가 바뀌면 검토·지정·새 접수를 거절. 자동으로 다른 기준을 사용하지 않음
- 검토·기준 지정은 Core 관리자 인증과 CSRF 적용. 검토·기준 지정 자체에는 모델 API 호출 없음

Migration `0004_evaluation_review_baseline`은 검토 이력·데이터셋별 기준 테이블과 기준 명세를 추가합니다.
기존 결과는 미검토 상태로 유지합니다. 비교 상세가 없는 초기 결과는 무료 저장 응답 재평가 후 검토합니다.

Migration `0008_case_reviews`는 사례별 이력과 실행의 검토 버전, 전체 승인이 참조하는 사례 검토
기록을 추가합니다. 기존 전체 승인은 버전·사례 판단을 추정해 채우지 않습니다. 기존 기준 행과 과거
실행을 보존하되, 사례별 재검토와 새 전체 승인을 거치기 전에는 새 평가 기준으로 사용할 수 없습니다.
이미 접수된 같은 UUID 재전송은 당시 기준 명세를 유지합니다.

검토 기준 `evidence-review-v1`은 신청 조건·예외·제외 사유의 누락/추가, 답변의 근거 일치와 근거 부족
판단, 인용 적절성을 다룹니다. 검토자·시각·해시·기준 버전을 기록하며 수정은 새 행으로 추가합니다.
사례 저장과 전체 승인은 실행의 `review_version`을 공유합니다. 같은 관리자·내용·직전 버전의 응답
유실 재전송은 기존 기록을 반환하고, 다른 변경이 끼어든 오래된 요청은 409로 거절합니다.
알 수 없는 사례, 잘못된 해시/기준, 미검토·부적합·보류는 승인 자격을 얻지 못합니다.
데이터셋 기준 행 → 실행 행 순서로 잠가 검토 변경·전체 승인·기준 지정·다음 접수의 경계를 유지합니다.
`LLMOPS_EVIDENCE_DIR`에는 버전이 고정된 `evaluation/support-program-evidence`를 읽기 전용으로 연결합니다.
로컬 Python은 저장소 경로가 기본이며 단독·루트 통합·LLMOps Compose는 모두 `/evaluation-data`에 마운트합니다.
루트 Compose 검증은 자료 경로와 읽기 전용 마운트를 확인하며, 컨테이너 테스트도 같은 자료를 사용합니다.
다른 배포 방식에서는 결과 볼륨과 이 자료 경로를 함께 제공해야 합니다. Django에는 평가 SDK를 추가하지 않습니다.

호출 흐름: `React 사례 판단 → Django 관리자·CSRF·자료 해시/버전 확인 → MySQL 사례 이력 저장 → 전체 승인 → 기준 지정`.
다음 평가는 `Django 기준 명세 고정 → Prefect → 기준 응답 복사·검증 → 기존 평가 파이프라인`을 거칩니다.

## 평가 기준 검토와 품질 판정

실행의 `COMPLETED`와 품질 합격은 별개입니다. `0010_quality_assessments`는 기존 실행·승인·기준을
보존하면서 `FixtureReview`와 `QualityAssessment`를 추가하며 과거 합격을 소급 생성하지 않습니다.
새 접수의 실행 명세에는 `quality_policy`의 내용·코드 해시가 포함됩니다.

현재 정책 `fixed-evidence-quality-v1`은 고정 근거의 선택 사례에만 적용합니다. 사람의 기준 자료
검토, 필수 사례 전체의 적합 판단, 검토된 기대 상태 일치와 필수 인용 충족이 필요합니다.
기대 인용이 없는 경우 `해당 없음`으로 계산하며 자동 의미 충실도 수치는 계속 미측정입니다.
사례별 사람 검토로 의미 판단을 기록하지만 숫자 의미 점수를 생성하지 않습니다.

| 품질 표시 | 의미 |
|---|---|
| 미판정 `NOT_EVALUATED` | 판정 기록 또는 신뢰할 수 있는 완료 자료가 없음 |
| 검토 필요 `NEEDS_REVIEW` | 기준 자료·사례의 검토가 부족하거나 기존 판정 이후 근거가 변경됨 |
| 불합격 `FAIL` | 필수 사례의 부적합 또는 검토된 필수 상태·인용 조건 위반 |
| 합격 `PASS` | 현재 자료·정책·사람 검토에서 모든 필수 조건 충족. 일반 모델 품질 보장은 아님 |

자료 손상·실행 오류는 모델 품질 불합격으로 단정하지 않습니다. 미검토 AI 참조와 다르다는 이유만으로
불합격을 만들지 않으며, 필수 사례의 부적합은 평균으로 상쇄하지 않습니다.

- `GET .../{id}/review`의 `quality`: 현재 유효 상태·정책, `input_sha256`, 자료 검토 버전·이력과
  판정 이력. `can_promote`는 최신 전체 승인과 유효한 품질 합격이 모두 있는지 나타냅니다.
- `POST .../{id}/fixture-review`: `decision` (`APPROVED` / `CHANGES_REQUESTED` / `DEFERRED`),
  `comment`, `fixture_sha256`, 순서가 있는 `case_ids`, `rubric_version`, `fixture_version`.
  기준 자료의 기대 상태·인용·필수 사실·금지 주장을 사람이 검토했다는 기록입니다.
  후보 답변 검토와 구별하고 원본 `ai-authored` 출처를 유지합니다.
- `POST .../{id}/quality`: 화면에서 받은 `input_sha256`. Django가 자료·최신 검토를 다시 확인하고
  정책 판정을 저장합니다. 자료·검토·정책이 바뀌었으면 409이며 같은 근거의 재전송은 기존 판정을 반환합니다.
  모델·Prefect·Langfuse에 새 요청을 보내지 않습니다.

판정에는 정책 스냅샷·해시, 자료·응답·비교 결과 해시, 사례/자료 검토 ID, 접수 명세와 접수 정책 해시,
판정 코드·담당자·시각을 보존합니다. 정책 변경 후 명시적 재판정은 현재 정책의 새 기록으로 남기며,
접수 당시 정책과 이전 판정은 덮어쓰지 않습니다. 판단 코드가 바뀐 경우도 별도 입력 해시로 구별합니다.

자료 검토 변경은 데이터셋 기준 행을 잠그고 활성 기준을 해제합니다. 응답 검토 변경도 기존 계약대로
처리합니다. 과거 판정 이력은 남지만 현재 합격으로 취급하지 않습니다. 기준 지정·새 기준 사용 접수는
서버에서 유효한 품질 합격을 검사하며 이미 접수된 요청의 기준 스냅샷은 유지합니다.

호출 흐름: `React 검토·판정 요청 → Django 관리자/CSRF·입력/버전 검증 → 정책 판정 → MySQL 이력 저장`.
모든 기준 자료·답변을 실제로 사람이 검토하기 전에는 개발 확인만으로 합격이나 기준 지정을 하지 않습니다.

## 접수 복원과 기준 버전

React는 전송 전에 요청 UUID·자료/캡처 ID·기준 버전·확인한 모델/호출 설정만 관리자별
`sessionStorage`에 보관합니다. `GET /api/v1/ops/session`의 `user.id`와 실행 응답의
`requested_by_id`는 이메일 변경과 무관한 Ops 연결 식별자(`core:{회원 ID}`)입니다.
같은 탭에서 새로고침·재로그인하면 먼저 기존 UUID를 GET으로 확인합니다. 조회만으로 모델을
호출하지 않으며 404여도 자동 POST하지 않습니다. 운영자가 재확인하면 같은 UUID·명세로 전송합니다.
다른 관리자 기록은 재사용하지 않고, 전송 직전 세션 계정도 대조합니다. 저장소 오류·손상은 접수를
차단하며 인증정보·질문·답변 원문은 저장하지 않습니다. 탭 종료·저장소 삭제 이후 복원은 보장하지 않습니다.
서버가 400으로 접수를 거절한 조건은 명시적으로 다시 선택하고 유료 전송 확인을 새로 받습니다.

Migration `0007_baseline_versions`는 해제해도 남는 데이터셋 기준 행과 단조 증가 버전,
`EvaluationBaselineChange` 이력을 추가합니다. 검토 저장·기준 지정/교체/해제·새 평가 접수는
같은 데이터셋 기준 행을 먼저 잠급니다. 파일 검증은 잠금 밖에서 수행하고 DB 안에서 버전·검토·원본
완료 상태를 다시 확인합니다. 접수를 커밋한 뒤 Prefect에 전송하므로 외부 HTTP를 DB 잠금 안에서 실행하지 않습니다.

- 실행에 `baseline_version`·`baseline_review_id`를 고정하고, 기존 `reference_config`의 UUID·캡처/자료
  해시와 실행기 스냅샷 계약은 유지합니다. 이미 접수된 요청의 재전송은 당시 명세를 유지합니다.
- 철회가 먼저 커밋되면 옛 버전으로 새 접수를 거절하고, 접수가 먼저 커밋되면 이후 철회에도 해당 실행의
  기준이 유지됩니다. 최초 기준 지정 경합도 데이터셋 PK와 잠금으로 직렬화합니다.
- 검토 GET은 현재 `baseline_version`과 `baseline_history`를 반환합니다. 이력에는 이전/새 검토와 실행,
  캡처/자료 해시, 버전, 수행자, 시각, 사유가 있습니다. 지정 사유는 승인된 검토 의견이며 새 검토에 따른
  자동 해제도 이력으로 남습니다. 중복 지정/해제 재전송은 같은 변경으로 처리합니다.
- 기존 기준은 버전 1과 기존 지정 시각·검토자 그대로 이관합니다. 이전 교체 이력·당시 자료 해시는
  추정해 채우지 않으며, 과거 평가의 승인 버전도 소급 생성하지 않습니다.

현재 배포 순서는 `Ops 이미지 빌드 → migration 0008까지 적용 → Ops API·ops-sync 갱신 → React 갱신`입니다.
루트 README 대신 이 문서와 [LLMOps 운영 문서](../../infrastructure/llmops/README.md)에 계약을 기록합니다.

## 실행 상태의 백그라운드 확인

`python manage.py sync_evaluations --watch`는 화면 방문과 독립적으로 미완료 실행을 확인합니다.
기본 대기 간격은 10초, 배치 크기는 25건이며 `--interval`(2~300초), `--batch-size`(1~100)로 조절합니다.
옵션 없이 실행하면 한 배치만 처리합니다. LLMOps Compose의 `ops-sync`가 같은 Django 이미지 구성으로 실행합니다.
단독 Ops/루트 Compose에는 Prefect가 없으므로 자동 실행하지 않습니다. 별도 실행 시 DB·Prefect·결과 경로를 동일하게 지정합니다.

- Migration `0006_evaluationrun_sync_attempted_at`을 먼저 적용합니다. 기존 행·결과 파일은 유지합니다.
- 목록·상세 응답의 `synced_at`은 마지막 성공 확인, `sync_attempted_at`은 마지막 시도입니다.
  미완료 상태의 성공 확인이 60초 이상 지연되면 `status_stale=true`입니다.
- Prefect 장애는 마지막 상태를 유지하고 `PREFECT_STATUS_UNAVAILABLE`을 표시합니다.
  확인 시도를 기록해 반복 실패가 다른 실행을 밀어내지 않게 합니다.
- flow ID 없는 접수는 UUID idempotency key로 조회하고 저장된 인자까지 대조합니다.
  조회 결과가 없거나 불일치하면 자동 실행을 생성하지 않습니다. 기존 관리자의 명시적인 접수 재확인은 유지합니다.
- 조건부 DB 갱신으로 늦은 상태 응답이 최신 완료 결과를 되돌리지 못하게 합니다.
- 목록 API는 DB만 읽으며 React가 5초마다 갱신합니다. 결과 오류는 재확인하지만 이미 완료된 모든 파일을
  주기적으로 전수 검사하지는 않습니다. 파일 훼손은 상세·보고서 조회에서도 확인합니다.

호출 흐름: `ops-sync → Prefect 기존 실행 조회 → 결과 파일 검증 → Ops MySQL → React 목록`.
새 모델 실행·자동 후처리 복구·평가 스케줄 기능은 이 명령에 포함하지 않습니다.

## 실패한 후처리 복구

`POST /api/v1/ops/evaluations/{원본 UUID}/recover`에 새로운 `request_id` UUID만 보냅니다.
완료된 응답과 fixture·비교 기준의 해시가 검증된 `FAILED / CRASHED / CANCELLED / RESULT_ERROR`
실행을 복구합니다. Core 관리자 인증·CSRF가 필요하며 접수 불확실 시 같은 UUID로 재확인합니다.
진행 중이거나 정상 완료한 실행, 불완전한 응답, 누락·변조된 입력은 거절합니다.

- 새 `EvaluationRun`의 `execution_mode`는 `recovery`, `source_run`은 원본입니다. 원본 상태와 파일을
  덮어쓰지 않으며 복구 시도마다 별도 UUID와 Prefect 실행·결과 폴더를 사용합니다.
- 접수 시 `recovery_config`에 원본 요청·후보 응답·비교 기준·fixture의 SHA-256을 고정합니다.
  실행기는 다시 검증한 바이트를 자기 폴더에 복사한 뒤 기존 평가 함수를 호출합니다.
- 복구는 응답 생성 함수로 진입하지 않으며 `model_api_calls=0`은 **이 복구의 추가 호출 수**입니다.
  원본 유료 실행의 호출 횟수는 원본 이력·캡처에 보존합니다. 유료 실행을 꺼도 복구할 수 있습니다.
- 원본 행의 DB 잠금으로 같은 원본에 진행 중인 복구를 하나만 허용합니다. 전송은 transaction 밖에서
  수행하며 요청 UUID와 Prefect idempotency key를 재사용합니다. 다른 관리자가 같은 UUID를 재사용할 수 없습니다.
- 상세 응답의 `source_run_id`는 원본 링크입니다. 상세 전용 `postprocessing`에는 입력 검증 여부,
  마지막 보고서/등록 단계, 복구 가능 여부·사유, 기존 복구 이력을 반환합니다.
- 보고서가 나중에 누락·훼손되면 상세 조회에서 `RESULT_ERROR`로 전환합니다. 입력은 온전해야 복구할 수 있습니다.
- 입력 검증 완료 전 중단되어 manifest에 입력 해시가 없는 실행은 복구할 수 없습니다. 부분 응답을
  이어 생성하는 기능, 자동 복구 스케줄, 모델 재호출은 포함하지 않습니다.

Migration `0005_evaluationrun_recovery`는 원본 FK와 복구 명세를 추가합니다. 기존 행은 null/빈 명세로
유지합니다. Ops와 평가 실행기를 함께 갱신해 Prefect deployment에 `recovery_config` 인자를 반영해야 합니다.
Django는 공통 입력 검증 코드만 사용하고 pandas·Pandera·Evidently SDK는 실행기에만 유지합니다.

호출 흐름: `React 복구 요청 → Django 입력/접수 검증 → Prefect → 입력 스냅샷 → pandas/Pandera → Evidently·Langfuse`.

## 빠른 시작 — Docker

아래 명령은 모노레포 루트에서 `cd backend/ops-service`로 이동한 뒤 실행합니다.
전체 로컬 스택의 실행 방법은 [루트 README](../../README.md)를 참고합니다.
단독 Ops Compose와 통합 Compose를 동시에 실행하면 포트가 충돌할 수 있습니다.

Docker Desktop의 Linux 컨테이너 엔진이 실행되어 있어야 합니다.

PowerShell:

```powershell
Copy-Item .env.example .env
docker compose up --build --detach --wait --wait-timeout 180
```

Linux/macOS에서는 첫 명령을 `cp .env.example .env`로 실행합니다. 이미 `.env`를 설정했다면 복사 단계는 건너뜁니다.

- 실행 확인: [http://127.0.0.1:8001/api/v1/health](http://127.0.0.1:8001/api/v1/health)
- DB 연결 확인: [http://127.0.0.1:8001/api/v1/health/ready](http://127.0.0.1:8001/api/v1/health/ready)
- MySQL: `127.0.0.1:3308`, DB/사용자 `govbiz4`
- Compose 프로젝트: `govbiz-ops` (컨테이너 `govbiz-ops-ops-service-1`, `govbiz-ops-ops-mysql-1`)
- 데이터 볼륨: 이 프로젝트의 `mysql-data`

Core·AI의 컨테이너·네트워크·DB 볼륨과 분리됩니다. DB 스키마·사용자 `govbiz4`는 컨테이너 이름과 별개이며 이번에 변경하지 않습니다. 이전 데이터는 자동 이전되지 않으므로 [전환 안내](../../docs/ops-monorepo-migration.md)를 따르세요. `config/`, `apps/`, `manage.py`를 컨테이너에 연결하므로 Python 코드 변경은 개발 서버에 반영됩니다. 의존성을 변경하면 이미지를 다시 빌드합니다.

```powershell
docker compose logs --follow ops-service
docker compose down
```

`down`은 데이터 볼륨을 유지합니다. 로컬 Compose만 이미지의 기본 명령을
`manage.py runserver`로 재정의하여 소스 변경을 자동 반영합니다. Kubernetes 등에서
이미지를 직접 실행하면 자동 재시작 개발 서버가 아닌 Gunicorn이 실행됩니다.

## Python을 호스트에서 실행

이 절의 명령도 `backend/ops-service`에서 실행합니다.

[uv 공식 설치 안내](https://docs.astral.sh/uv/getting-started/installation/)에 따라 uv 0.12.5와 Python 3.12를 준비합니다. 기존 uv는 요구 버전에 맞춥니다.

```powershell
Copy-Item .env.example .env
uv sync --locked
docker compose up --detach ops-mysql --wait
uv run --locked python manage.py check
uv run --locked python manage.py migrate
uv run --locked python manage.py runserver 127.0.0.1:8001
```

호스트에서 실행할 때는 Compose의 `ops-service`를 동시에 실행하지 않습니다. 이미 켜져 있다면 `docker compose stop ops-service`를 먼저 실행합니다. Linux에서 mysqlclient 빌드 도구가 없다면 `default-libmysqlclient-dev`, `build-essential`, `pkg-config`를 설치하거나 Docker 실행 경로를 사용합니다.

## API

| 경로 | 성공 응답 | 실패 동작 |
| --- | --- | --- |
| `GET /api/v1/health` | `200`, `status: UP` | DB를 호출하지 않음 |
| `GET /api/v1/health/ready` | `200`, `database: UP` | MySQL 연결/질의 실패 시 `503`, 내부 연결 정보는 응답에 노출하지 않음 |
| `GET /api/v1/ops/session` | `200`, `user`(쿠키가 없으면 null), `csrf_token`, 허용 자료 목록 | 만료 `401`, 비관리자 `403`, Core 장애 `503` |
| `GET /api/v1/ops/evaluations/{UUID}/report` | `200`, CSP sandbox가 적용된 HTML | 미인증 `401`, 비관리자 `403`, Core 장애 `503`, 없거나 훼손된 보고서 `404` |
| `POST /api/v1/ops/evaluations` | 최초 `202`, 재전송 `200`; 실행 메타데이터 | 자료/UUID 오류 `400`, 미인증 `401`, 권한·CSRF `403`, 요청 충돌 `409`, 인증 서버 장애·접수 미확인 `503` |
| `GET /api/v1/ops/evaluations` | `200`, 25건 페이지 (`count`, `next`, `previous`, `results`) | 미인증 `401`, 비관리자 `403`, Core 장애 `503` |
| `GET /api/v1/ops/evaluations/{UUID}` | `200`, 최신 상태와 요약·상세 링크 | 미인증 `401`, 비관리자 `403`, Core 장애 `503`, 없는 실행 `404`; Prefect 장애는 `error_code`로 구별 |

로그인·로그아웃은 기존 Core `/api/v1/auth/login`, `/api/v1/auth/logout`을 사용합니다.
별도 `/api/v1/ops/login`, `/logout`은 제공하지 않습니다. 먼저 Ops session API에서
CSRF 쿠키와 `csrf_token`을 받고 평가 POST의 `X-CSRFToken`에 넣습니다.
React는 쓰기 전 세션을 조회해 최신 토큰을 사용합니다. 세션·평가 응답은 캐시하지 않습니다.
Vite는 `/api/v1/ops`를 Core보다 먼저 라우팅하고 Host와 Origin을 보존합니다. Host를 바꾸는
별도 프록시에서는 실제 웹 Origin을 `DJANGO_CSRF_TRUSTED_ORIGINS`에 명시해야 합니다.
기존 `/api/v1/evaluations`는 `/api/v1/ops/evaluations`로 이동했습니다.

가상 6건 재현은 `request_id`, `dataset_id: "target-coverage-20260907-v1"`와 해당 자료의
`execution_profiles.replay` 값을 `execution_profile`로 전송합니다.
프롬프트 변경 비교 요청은 다음과 같습니다. 선택 가능한 자료·사례·캡처 목록은 session 응답의 `datasets`에 있습니다.

```json
{
  "request_id": "<새 UUID>",
  "dataset_id": "fixed-context-e01-v1",
  "reference_capture_id": "fixed-context-20260906-diagnostic-v1",
  "candidate_capture_id": "fixed-context-20260907-index-v1",
  "execution_profile": "<session에서 확인한 해당 자료의 execution_profiles.replay>"
}
```

비교 응답에는 지표별 기준·후보·차이, 사례별 상태·인용, 모델·프롬프트·실행기·캡처 해시가 있습니다.
두 캡처의 원본 사례는 각각 1건·4건이며 명시한 공통 E01 한 건만 비교합니다. 다른 자료의 조합은 `400`,
같은 UUID의 기준·후보 변경은 `409`입니다. 토큰 연결 정보가 없는 과거 기록과 의미 충실도는 미측정입니다.
`0002_evaluationrun_comparison` migration은 기존 행을 가상 6건 재현으로 유지하며 이전 결과의
`comparison`은 `null`입니다. 기존 보고서는 계속 열 수 있고, 새 실행부터 비교 상세가 저장됩니다.
통신 재시도에는 UUID와 선택 대상을 유지하고, 사용자가 의도적으로 새 평가를 시작할 때만 새 UUID를 발급합니다.
미확정 접수를 복구할 때도 같은 POST를 사용합니다. 요청이 이미 접수됐을 수 있으므로 새 UUID로 바꾸지 않습니다.

URL 끝에 슬래시를 붙이지 않습니다. 상태 확인 경로는 쓰기 요청을 받지 않습니다.

상태 확인 흐름은 `HTTP → Django URL → DRF View → JSON`이며, readiness는 MySQL에서
`SELECT 1`을 실행합니다. Ops에서 외부 모델 API를 호출하지 않습니다.

## 검증

로컬 MySQL을 실행한 뒤 다음 명령을 사용합니다.

```powershell
uv sync --locked
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked python manage.py check
uv run --locked python manage.py makemigrations --check --dry-run
uv run --locked python manage.py test --noinput
```

Docker 안에서도 테스트할 수 있습니다.

```powershell
docker compose exec -T ops-service python manage.py test --noinput
```

테스트 러너는 별도 `test_govbiz4` DB를 생성·삭제합니다. Compose의 최초 DB 초기화 SQL은 개발 사용자에게 그 DB의 권한만 추가로 부여합니다. 테스트는 실제 MySQL 연결, DB 장애 시 503 응답, liveness의 DB 비의존성, HTTP 메서드 제한, 허용 호스트를 확인합니다.

GitHub Actions는 모노레포 루트의
[`ops-ci.yml`](../../.github/workflows/ops-ci.yml)에서 Ruff·Django 검사·실제 MySQL 테스트를
수행합니다. Docker job은 `infrastructure/scripts/check-compose.py --smoke`로 통합 Compose의
경로·환경 분리를 검사하고, 격리된 Django·MySQL만 빌드·실행하여 상태 확인과 테스트를
수행합니다. Core API·AI Service나 외부 AI API는 기동·호출하지 않습니다.
`python3 -B backend/ops-service/scripts/check-image.py`는 모노레포 루트에서 기본 Gunicorn
이미지를 별도로 검증합니다. 네트워크·DB·실제 환경 파일을 연결하지 않고 non-root,
읽기 전용 파일시스템, 정상 liveness, DB 장애 readiness, Host 거절, SIGTERM 종료를
확인한 뒤 이번 실행의 임시 컨테이너와 이미지 태그만 정리합니다.
실제 GitHub CI 실행은 파일을 원격 저장소에 올린 뒤 확인할 수 있습니다.

## 디렉터리

```text
config/                  Django 설정·URL·WSGI·ASGI
apps/health/             실행/DB 연결 상태 API 및 테스트
apps/evaluations/        Core 관리자 인증·평가 API·모델·migration·Prefect HTTP 연동·테스트
infrastructure/mysql/    개발용 테스트 DB 초기화
manage.py                관리 명령 진입점
pyproject.toml           Python 의존성과 개발 도구 설정
uv.lock                  확정된 의존성
Dockerfile               Gunicorn 기본 실행 이미지
compose.yaml             Django·MySQL 로컬 환경
scripts/check-image.py   배포 이미지 기본 명령·격리·상태 확인 검증
.env.example             로컬 환경변수 예시
```

## 환경변수와 다른 서비스 연결

`.env`는 Git/Docker 빌드 컨텍스트에서 제외됩니다. `.env.example`의 비밀번호와 비밀 키는 로컬 개발용입니다. 실제 환경변수가 `.env`보다 우선합니다.

- `DJANGO_SECRET_KEY`, `DB_PASSWORD`: 필수
- `DJANGO_DEBUG`: 기본 `false`; 예시 파일은 로컬 개발용 `true`
- `DJANGO_ALLOWED_HOSTS`: 쉼표로 구분하는 허용 호스트
- `DB_HOST`, `DB_PORT`: 호스트 실행 기본값 `127.0.0.1:3308`
- `API_PORT`, `MYSQL_PORT`: Compose가 호스트에 공개하는 포트
- `MYSQL_ROOT_PASSWORD`: 개발용 MySQL 초기화 비밀번호
- `CORE_API_URL`: Django에서 접근하는 Core 주소; 호스트 기본 `http://127.0.0.1:8080`
- `OPS_CORE_API_URL`: Compose에서 위 주소를 지정; 기본 `http://host.docker.internal:8080`
- `OPS_WEB_URL`: 이전 Django 화면 주소의 React 이동 대상; 기본 `http://localhost:5173`
- `PREFECT_API_URL`: Django에서 접근하는 Prefect API; 기본 `http://127.0.0.1:14200/api`
- `PREFECT_UI_URL`, `LANGFUSE_PROJECT_URL`: 운영자 브라우저에서 여는 상세 링크
- `LLMOPS_RESULTS_DIR`: 실행기 결과를 읽는 디렉터리; 기본 저장소 `work/llmops-ops`
- `DJANGO_COOKIE_SECURE`: 기본값은 `not DJANGO_DEBUG`. 로컬 HTTP 개발에서만 `false`

컨테이너 간 연결 주소와 브라우저 링크 주소는 다릅니다. 전용 Compose는 API에 `prefect:4200`,
브라우저 링크에 `localhost:14200`을 사용합니다. Core 세션 쿠키 `govbiz_session`은 동일 웹 origin의
Core·Ops API에서 공유하고, Ops CSRF 쿠키는 `govbiz_ops_csrf`로 구별합니다. `localhost`와
`127.0.0.1`을 브라우저 주소에서 혼용하지 않습니다. `govbiz_ops_session`은 인증 근거로 사용하지 않습니다.
Langfuse 자체 UI는 별도 로그인입니다.

Compose의 DB 이름/사용자는 `govbiz4`로 고정하여 테스트 초기화 SQL과 일치시킵니다. 포트를 변경하면 호스트 실행의 `DB_PORT`도 맞춰야 합니다.

향후 Django가 담당할 업무를 확정한 뒤 같은 모노레포의 React·Spring Boot·FastAPI와 HTTP 또는 메시지 계약으로 연결합니다. 같은 테이블을 Spring의 Flyway와 Django migration이 동시에 관리하지 않도록 데이터 소유권을 먼저 정합니다.

## 운영 배포 경계

회원·세션 테이블은 Core에 유지하고 관리자 확인 HTTP API로만 연동합니다.
운영 배포에는 같은 origin의 Core·Ops 프록시와 내부 `CORE_API_URL`, HTTPS 쿠키 설정이 필요합니다.
Kubernetes 매니페스트와 배포 이미지 버전은 같은 저장소의 `infrastructure/gitops/`에서 관리합니다.
이 이미지에는 클러스터 생성·Argo CD 설치·운영 데이터 변경 기능이 없습니다.

Mac 유지형 포트폴리오 배포는 [GitOps 안내](../../infrastructure/gitops/docs/portfolio-gitops.md)를 따릅니다.
기존 두 저장소 환경에서는 CI가 비공개 GHCR에 이미지를 발행하고, infra가 검증한 digest를 선택하면
Argo CD가 이 서비스의 Deployment를 동기화했습니다. 교육기관 통합본에서는 해당 자동 발행·promotion을
잠갔으며 개인 포크 연결은 별도입니다. 이미지 발행만으로 관리자 인증·업무 기능이 추가되는 것은 아닙니다.

- 이미지 기본 명령은 `gunicorn config.wsgi:application`, 내부 포트는 `8000`입니다.
  worker 2개, worker 응답 정지 제한 30초, 종료 유예 25초이며 stdout/stderr로 로그를 냅니다.
- UID/GID는 `10001:10001`입니다. Kubernetes에서 `runAsNonRoot: true`,
  `readOnlyRootFilesystem: true`를 사용하고 `/tmp`에 쓰기 가능한 작은 `emptyDir`를
  마운트합니다. Gunicorn heartbeat 임시 파일이 필요하므로 `/tmp`까지 읽기 전용이면
  기동하지 못합니다. Pod 종료 유예는 Gunicorn의 25초보다 길게 설정합니다.
- `DJANGO_DEBUG=false`, 별도 무작위 `DJANGO_SECRET_KEY` 및 DB 비밀번호를 Secret으로
  주입합니다. DB 주소는 Ops 전용 DB이며 Core API의 DB 자격증명을 재사용하지 않습니다.
- `DJANGO_ALLOWED_HOSTS`에는 접근할 Service DNS/호스트만 지정합니다. HTTP probe는
  `/api/v1/health`와 `/api/v1/health/ready`를 사용하며 허용된 `Host` 헤더가 필요합니다.
  liveness/startup은 DB를 보지 않고 readiness만 DB를 확인합니다.
- `python manage.py migrate --noinput`은 별도 배포 작업으로 한 번 실행합니다.
  Pod마다 동시에 migration을 실행하는 시작 명령은 넣지 않습니다. Django auth·session과
  `evaluations/0001_initial.py`를 함께 적용해야 운영자 화면을 사용할 수 있습니다.
- 공개 운영 전에는 TLS/신뢰 프록시, 인증·권한, DB TLS/백업을 별도 구성하고 실제 배포
  환경에서 `python manage.py check --deploy`를 점검해야 합니다. 이 작업은 개발용
  `runserver`를 대체했을 뿐, 해당 보안·업무 구성을 모두 완료한 것은 아닙니다.

설정 근거: [Django Gunicorn 배포](https://docs.djangoproject.com/en/5.2/howto/deployment/wsgi/gunicorn/),
[Gunicorn 설정](https://gunicorn.org/reference/settings/),
[Django 배포 체크리스트](https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/).
