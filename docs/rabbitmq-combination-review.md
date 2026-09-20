# RabbitMQ 적용: 중복 지원·수혜 검토 비동기 분석

[문서 목록](README.md) · [서비스 흐름](architecture.md) · [기존 검토 설계·이력](duplicate-support-review-design.md)

## 적용 범위

사용자가 명시적으로 요청한 **중복 지원·수혜 검토 분석**을 RabbitMQ 작업으로 처리한다.
신청 양식 발견, 실시간 검색, 리포트 메일 전송은 이번 변경에 포함하지 않는다.
2026-09-13 후속으로 [공식 문서 분석 큐와 관리자 운영 조회](rabbitmq-application-form-discovery.md)를 별도 적용했다.
기존 RabbitMQ와 Spring AMQP를 사용하며 별도 Worker 서버나 범용 작업 프레임워크는 추가하지 않는다.
정기 리포트 큐와 검토 큐는 서로 다른 큐·소비자를 사용하지만 같은 Core 프로세스와 브로커 자원을 공유한다.

목적은 긴 HTTP 요청을 분리하고 접수·대기·실행·결과 불명을 관리하는 것이다.
AI 자체의 응답 속도, 토큰 비용, 정확도가 개선됐다는 의미는 아니다.

## 호출 흐름

1. `CombinationReviewRunController → CombinationReviewRunService`가 세션 소유자·Origin·입력·요청 키를 확인한다.
2. 기존 요청이면 저장된 상태를 반환한다. 새 요청은 기존 계정별 요청 제한을 통과해야 한다.
3. `CombinationReviewRunRepository → MyBatis Mapper → XML → MySQL`에서 계정·검토를 잠그고
   당시 입력과 `QUEUED` 실행을 저장한다. **실행 행 자체가 Outbox**여서 실행 저장과 발행 대기 기록이 분리되지 않는다.
4. HTTP는 `202 Accepted`와 실행 ID, `Location`, `Cache-Control: no-store`를 반환한다.
5. `CombinationReviewOutboxScheduler → CombinationReviewQueueClient → RabbitMQ`가 작업 ID만 발행한다.
6. `CombinationReviewRunConsumer → CombinationReviewRunService.executeQueued`가 공유 동시 실행 슬롯을 확보한 뒤
   DB에서 `QUEUED → RUNNING`을 선점한다.
7. 기존 제공처별 공식 첨부 수집 → PDF/HWP/HWPX 파싱 → 근거 보존 → AI Facade/Client → AI Service 경로를 실행한다.
8. DB에 성공·실패·결과 불명을 기록한 뒤 ACK한다. 브라우저는 기존 GET으로 저장된 상태와 결과를 확인한다.

DB transaction 안에서 RabbitMQ·다운로드·AI를 호출하지 않는다. 입력 수정은 접수 당시 스냅샷을 바꾸지 않는다.
세션 만료·브라우저 닫기는 이미 접수된 작업의 취소가 아니다. 계정 정지·탈퇴는 실행 선점 때와 AI 호출 직전 확인한다.

## 공개 API와 화면

| 요청 | 응답 |
|---|---|
| 새 `POST /api/v1/combination-reviews/{reviewId}/runs` | 202, `QUEUED` 실행 본문과 Location |
| 같은 요청 키·동일 내용 POST | 200, 기존 상태 그대로 반환. 추가 AI 실행 없음 |
| 동일 키·다른 내용, 입력 버전 충돌, 같은 검토의 활성 실행과 충돌 | 409 |
| 접수 한도 초과 | 429와 Retry-After. 새 실행을 만들지 않음 |
| 큐 기능 비활성 상태의 새 POST | 503 `RUN_QUEUE_UNAVAILABLE`. 동기 실행으로 우회하지 않음 |
| 실행 상세·목록·원본 GET | 기존 본인 소유권 검증과 200 계약 유지 |

분석 도중 발생한 실패는 최초 POST의 HTTP 오류가 아니라 **실행 조회 본문의 상태·failureCode**로 확인한다.
`startedAt`은 이전 API 필드 이름을 유지하되 신규 작업에서는 접수 시각을 뜻한다. 실제 worker 시작은 DB의
`execution_started_at`으로 구분하며 화면에는 접수 시각으로 표시한다.

화면은 접수 요청의 응답을 최대 15초 기다린다. 응답이 유실되면 sessionStorage의 같은 요청 키로만 확인한다.
정상 접수 응답을 받으면 미확인 요청 기록을 해제하고 실행 ID로 조회한다. 대기/분석 중에는 3초 간격으로
직전 GET 완료 후 다음 GET을 예약한다. 새로고침·다른 기기에서도 DB 실행 목록의 활성 작업을 찾아 조회를 재개한다.
과거 실행을 선택한 상태에서는 자동 조회가 선택을 덮어쓰지 않는다. 상태 역전 응답도 반영하지 않는다.
조회 실패 시 자동 조회를 멈추고 수동 재확인을 안내한다. 완료·실패·결과 불명·화면 종료·로그아웃 시 자동 조회를 멈춘다.
조회/로그인/화면 진입만으로 새 분석 POST를 보내지 않는다.

## 상태·중복·한도

| 상태 | 의미와 처리 |
|---|---|
| QUEUED | 접수됨. 발행/실행 대기. 접수 후 1시간 안에 시작하지 않으면 FAILED / QUEUE_EXPIRED |
| RUNNING | DB 실행권 선점 완료. 같은 ID의 재전달은 재실행하지 않음 |
| SUCCEEDED | 검증된 분석 결과와 근거 저장 완료 |
| FAILED | 수집 실패·잘못된 응답 등 확정된 기술 실패. 정상적인 근거 부족 판단과 다름 |
| UNKNOWN | AI 호출/결과 저장의 완료 여부 불명 또는 실행 20분 초과. 자동 재실행하지 않음 |
| INTERRUPTED | 기존 이력 및 운영 확인 후 중단 확정 상태 |

- DB 고유키 `(review_id, request_key)`와 요청 해시가 중복 요청을 보호한다.
- `(review_id, running_slot)`은 QUEUED/RUNNING/UNKNOWN을 같은 활성 슬롯으로 취급한다.
  UNKNOWN이 있는 검토는 새 키로도 재실행할 수 없다.
- 계정 행 잠금 아래 계정 전체의 QUEUED/RUNNING/UNKNOWN 합계를 검사해 **최대 3건**만 허용한다.
- 새 접수는 기존 요청량 제한도 적용받는다. 정상적인 동일 키 재조회는 새 요청량을 소비하지 않는다.
- 검토 큐는 single-active-consumer, 동시 소비 1, prefetch 1이다. 리포트 소비자와 별개다.
- 검토 worker도 기존 `SupportProgramRequestAdmissionService`의 공유 동시 실행 슬롯을 사용한다.
  `executeBackground`는 접수 횟수를 다시 계산하지 않는다. 공유 슬롯이 없으면 DB 선점 전에 종료하고
  QUEUED를 유지한다. 메시지는 ACK하되 Outbox가 기존 발행 간격으로 다시 전달하며 AI는 호출하지 않는다.
- 실행을 선점한 뒤에는 재전달·재시작으로 실행권을 재획득하지 않는다. 만료된 worker의 늦은 완료는 상태를 덮어쓰지 못한다.
- 일별 AI 예산·추정 토큰 과금 상한은 이번 변경에 추가하지 않았다. 동시/요청량 한도를 비용 상한으로 해석하면 안 된다.

## 발행과 장애

Outbox 전용 스케줄러는 5초마다 만료 검사 후 최대 20건을 조회한다. 작업별 발행 예약은 최소 1분 간격으로
조건부 갱신한다. 여러 발행자가 동시에 같은 작업을 조회해도 예약 성공자만 발행한다.
`v1:<runId>`만 persistent 메시지로 전송하며 원문·추가 설명·계정 이메일·인증 정보는 메시지에 넣지 않는다.
publisher confirm과 mandatory return을 함께 검사한다. 브로커 수락은 분석 완료가 아니다.

| 항목 | 설정 |
|---|---|
| exchange / queue | `govbiz.combination-review.generation.v1` |
| dead exchange / queue | `govbiz.combination-review.generation.dead.v1` |
| 큐 유형 | durable quorum, 주 큐 single-active-consumer |
| 주 큐 | 최대 1,000건, reject-publish, 메시지 TTL 1시간, delivery-limit 3 |
| DLQ | durable quorum, 최대 1,000건, reject-publish, 자동 재생 없음 |
| dead-letter 전략 | at-least-once |

브로커가 중단되거나 라우팅되지 않으면 미실행 작업은 DB에 남아 재발행된다. 이미 발행됐어도 선점 전이면
중복 발행될 수 있으므로 DB 선점을 반드시 사용한다. 잘못된 메시지와 DB 처리 결과 불명은 DLQ에 격리한다.
DLQ 항목 수는 실패한 분석 수와 같지 않다. 업무 실패는 DB에 저장하고 ACK할 수 있으며, 상태의 기준은 MySQL이다.

AI 호출 이후 통신 단절·저장 오류는 UNKNOWN으로 기록한다. 상태 기록도 실패해 RUNNING이 남으면 만료 검사가
20분 후 UNKNOWN으로 전환한다. AI 응답의 명확한 계약/인용 검증 실패는 FAILED로 보존한다.
검토 삭제 후 대기 메시지가 도착하면 실행하지 않는다. 이미 시작된 외부 호출은 삭제/정지로 취소를 보장할 수 없다.

## 설정과 배포

`COMBINATION_REVIEW_QUEUE_ENABLED`는 Core 직접 실행 시 기본 false, Compose에서는 기본 true다.
RabbitMQ 연결은 기존 `RABBITMQ_HOST/PORT/USERNAME/PASSWORD/VHOST`를 공유한다.
기능이 false면 신규 접수·소비·만료 검사·발행이 비활성화되고, 기존 결과 GET과 동일 키 재조회는 가능하다.
true로 바꾸면 **기존 QUEUED 작업이 사용자 재클릭 없이 실행될 수 있다.** 실행 전 대기 작업을 확인해야 한다.

V25는 V24까지의 기존 마이그레이션을 수정하지 않고 실행 테이블에 nullable 발행/실행 시각을 추가하고
상태 제약·활성 고유키를 확장한다. 기존 실행과 원문을 삭제하지 않는다. 과거 RUNNING 행은 새 worker가 재실행하지 않으며
기존 접수 시각을 기준으로 20분이 지났다면 만료 검사에서 UNKNOWN이 된다.

혼합 버전의 Core가 동시에 실행되지 않도록 기존 분석을 종료/확인하고 전체 Core를 갱신한다.
이전 버전은 새 상태를 모를 수 있으므로 V25와 새 작업 생성 후 바이너리만 구버전으로 되돌리지 않는다.
개발 Docker 반영은 [기존 환경 갱신 절차](../infrastructure/README.md#백엔드-변경-반영과-화면api-버전-불일치)를 따른다.

운영 점검은 다음 항목을 확인한다. 조회 결과에는 민감한 input_json·원문을 포함하지 않는다.

```sql
SELECT id, review_id, status, failure_code, started_at, execution_started_at,
       queue_expires_at, next_publish_at, last_published_at, finished_at
FROM combination_review_run
WHERE status IN ('QUEUED', 'RUNNING', 'UNKNOWN')
ORDER BY id;
```

UNKNOWN은 해당 run ID와 runner_instance_id를 기준으로 실제 worker 종료 및 외부 호출/과금 상태를 확인한다.
상태를 QUEUED로 돌리거나 DLQ를 일괄 재생하지 않는다. 자동 재실행이 안전함을 보장하는 복구 API는 제공하지 않는다.
운영자가 중단을 확정한 뒤 별도 승인된 조건부 데이터 수정 절차로 INTERRUPTED 처리할 수 있지만, 이것이 과금 취소를 뜻하지 않는다.

## 검증 범위

- `CombinationReviewRunIntegrationTest`: 실제 MySQL 8.4, 202 접수·요청/소유권·스냅샷 보존,
  동시 예약·DB 고유키·계정 한도·만료·계정 정지·삭제·원문 무결성 rollback·기존 분석 회귀.
- `CombinationReviewQueueIntegrationTest`: 실제 RabbitMQ/MySQL, 소비 중단 중 적재, 중복 전달,
  브로커 중단/복구, 누락 binding, 잘못된 메시지 DLQ, AI 결과 불명 재실행 차단.
- Frontend: 202 해석, 대기→분석→완료 자동 조회, 재접속 복구, 조회 실패 중지/수동 재확인,
  로그아웃 격리, UNKNOWN의 새 실행 차단.
- Compose 검증: 실제 사용자 검토 작업이나 유료 AI 호출 없이 두 큐/DLQ와 소비자 연결·브로커 복구를 검사한다.

이 검증은 실제 공고 분석의 정확도나 사람 검수를 대신하지 않는다. 자동 테스트의 외부 다운로드·AI는 스텁이다.

Docker Desktop 메모리가 작은 환경에서는 Core 전체 테스트와 Compose 스모크를 동시에 실행하지 않는다.
Spring 테스트 컨텍스트가 서로 다른 MySQL 컨테이너를 캐시에 유지하므로, 필요하면 JDK 21에서 다음처럼
**테스트 프로세스만** 캐시를 제한한다. 전체 테스트를 생략하거나 H2로 대체하는 설정이 아니다.

```bash
# backend/core-service에서 실행. 완료 후 별도로 Compose 검증을 실행한다.
JAVA_TOOL_OPTIONS='-Dspring.test.context.cache.maxSize=4' ./gradlew clean build --no-daemon
```

검증 포트가 개발 환경과 겹치면 `VERIFY_COMPOSE_MYSQL_HOST_PORT`, `VERIFY_COMPOSE_WEB_HOST_PORT`,
`VERIFY_COMPOSE_CORE_API_HOST_PORT`, `VERIFY_COMPOSE_QDRANT_HOST_PORT`로 별도 포트를 지정한다.

### 2026-09-12 최종 코드 검증

| 검증 | 결과 |
|---|---|
| JDK 21, `JAVA_TOOL_OPTIONS='-Dspring.test.context.cache.maxSize=4' ./gradlew clean build --no-daemon` | 134개 suite, 1,247건 통과, 실패·오류·건너뜀 0, 15분 26초 |
| 검토 실행 / 검토 큐 통합 테스트 | 위 전체 실행에 각각 27건 / 5건 포함. 실제 MySQL 8.4·RabbitMQ 사용 |
| Node 24·pnpm 11.22, `pnpm test --maxWorkers=2` | 87개 파일, 1,051건 통과 |
| `pnpm lint`, `pnpm build` | 통과. 기존 번들 크기 경고는 유지 |
| `python -B -m unittest discover -s infrastructure/scripts -p 'test_*.py'` | 25건 통과 |
| 격리 Compose 전체 검증 | 통과. 두 quorum 주 큐/DLQ·각 소비자 1개, 브로커 중단/같은 볼륨 재생성 후 Core 추가 재시작 없이 재연결 |

Compose는 저장소 루트에서 다음 별도 프로젝트·포트로 실행했다. Web/Core/AI 연결, 기존 양식 문답,
4개 제공처 동기화·검색, Redis/Core 재시작 복원, Elasticsearch·Qdrant·AI 장애/복구도 함께 통과했다.
스크립트 종료 후 해당 검증 컨테이너·네트워크·볼륨만 정리한다.

```bash
VERIFY_COMPOSE_PROJECT_NAME=govbiz-verify-review-20260912 \
VERIFY_COMPOSE_MYSQL_HOST_PORT=23306 \
VERIFY_COMPOSE_WEB_HOST_PORT=25173 \
VERIFY_COMPOSE_CORE_API_HOST_PORT=28080 \
VERIFY_COMPOSE_QDRANT_HOST_PORT=26333 \
./infrastructure/scripts/verify-compose.sh
```

`live-source` 태그로 분리된 실제 공식 파일 다운로드 검증과 유료 모델 정확도·비용·부하 평가는 실행하지 않았다.
초기 병렬 검증에서는 Docker Desktop 메모리 부족으로 기존 개발 Core가 OOM 종료됐다. 기존 이미지·설정 그대로
재시작하고 health HTTP 200을 확인했으며, 이후 전체 테스트는 위 캐시 제한과 순차 실행으로 완료했다.
새 코드/V25를 기존 개발 Core·DB에 배포한 것은 아니다. 초기 검증 포트 충돌도 별도 포트 지정으로 분리했다.

### 원격 main 병합 후 호환성 확인

`skn-119`의 `42b7e1f`에 원격 `main`의 `69ff211`을 병합했다. 충돌한 ViewModel은 관심 공고 선택과
상태 조회 중지 상태를 모두 반환하도록 합쳤으며, 화면 테스트도 관심 공고 선택·큐 진행 상태 시나리오를 모두 유지했다.
아키텍처 설명은 비동기 접수 이후 네 제공처의 PDF/HWP/HWPX 첨부를 처리하는 경로로 맞췄다.

자동 병합된 신규 제공처 통합 테스트에는 동기 실행 당시의 HTTP 201 기대가 남아 있어,
202 접수·worker 실행 후 결과 GET의 HTTP 200을 확인하도록 수정했다. 새 제공처 수집 기능이나
기존 중복 실행 방지를 제거해서 충돌을 해소하지 않았다. 기존 프로세스별 검토 2개 제한 설명도
현재 계정별 활성 작업 3개·검토 큐 소비자 1개·공유 동시 실행 제한으로 정정했다.

병합된 코드의 재검증은 Core 136개 suite·1,256건(실패·오류·건너뜀 0, JDK 21 클린 빌드 18분 26초),
AI Service 941건, Frontend 91개 파일·1,086건과 lint·production build, 인프라 테스트 25건이 통과했다.
Core 테스트는 동일한 테스트 컨텍스트 캐시 제한 4를 사용했고, 유료 모델·실제 공식 파일 다운로드 검증은 실행하지 않았다.

격리 Compose 전체 검증도 `govbiz-verify-merge-skn119-20260912` 프로젝트에서 통과했다.
포트는 위 명령과 동일하게 MySQL 23306·Web 25173·Core 28080·Qdrant 26333을 사용했다.
양식 문답·네 제공처 동기화/검색, Core 재시작과 Redis AOF 복원, 두 RabbitMQ 큐의 소비자 재연결,
Elasticsearch·Qdrant·AI 장애/복구를 확인했다. 검증용 컨테이너·네트워크·볼륨은 종료 시 정리하며,
이 병합 검증은 기존 개발 환경에 새 코드를 배포하거나 유료 API를 호출하지 않는다.
