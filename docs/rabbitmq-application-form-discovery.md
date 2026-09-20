# RabbitMQ: 공식 신청 문서 분석과 큐 운영 조회

[문서 목록](README.md) · [호출 흐름](architecture.md) · [Compose 실행](../infrastructure/README.md)

후속 [리포트 메일 발송 큐](rabbitmq-daily-report-delivery.md)와 [카카오 연결 해제 큐](rabbitmq-account-oauth-unlink.md) 추가로 관리자 조회는 다섯 기능을 반환한다.
아래 세 큐 구성·테스트 수치는 V26 구현 당시 기록이며, 문서 분석의 동기 개발 경로는 그대로 유지한다.

## 목적과 범위

공식 신청 문서를 찾는 긴 HTTP 요청을 **작업 접수 → 백그라운드 분석 → 저장된 결과 조회**로 분리한다.
기업마당·K-Startup·과학기술정보통신부·충남 수출지원의 기존 첨부 수집·문항 추출·양식 캐시는 유지한다.
기존 RabbitMQ·Spring AMQP를 사용하며 새 서버, 라이브러리, 범용 작업 프레임워크는 추가하지 않는다.

AI의 추론 속도·정확도·토큰 사용량을 개선한 변경은 아니다. 대기열이 길면 완료까지 걸리는 시간은 늘 수 있다.
신청 문항에 대한 사용자 답변 해석, 실시간 검색, 수동 리포트 미리보기, SMTP·카카오 unlink는 이 큐에 넣지 않는다.

## 실행 흐름

1. `ApplicationFormDiscoveryJobController → ApplicationFormDiscoveryJobService`가 로그인·Origin·공고 식별자·UUID 요청 키를 확인한다.
2. `ApplicationFormDiscoveryJobRepository → MyBatis Mapper → XML → MySQL`이 짧은 transaction에서 계정 상태·한도를 확인하고 `QUEUED` 작업을 저장한다.
3. 작업 행 자체가 Outbox다. 접수 API는 첨부 다운로드·AI 호출 없이 `202 Accepted`와 작업 ID·Location을 반환한다.
4. `ApplicationFormDiscoveryOutboxScheduler → ApplicationFormDiscoveryQueueClient → RabbitMQ`가 `v1:<jobId>`만 발행한다.
5. `ApplicationFormDiscoveryJobConsumer → ApplicationFormDiscoveryJobService.executeQueued`가 기존 공유 실행 슬롯을 확보한 뒤 DB 실행권을 한 번 선점한다.
6. `ApplicationFormDiscoveryService → 제공처별 AttachmentClient → DocumentParser → AiApplicationPreparationFacade → Client → AI Service`로 분석한다.
7. 기존 `ApplicationFormSnapshotRepository`에 공용 양식을 보존하고, 작업 행에 결과·경고·캐시 여부를 저장한 뒤 ACK한다.
8. 화면은 3초 간격으로 이전 GET 완료 후 다음 GET을 예약한다. 완료·실패·결과 불명·통신 실패·화면 종료 시 자동 조회를 중단한다.

RabbitMQ, 공식 사이트, AI 호출은 DB transaction 안에서 실행하지 않는다. 메시지에는 문서 본문·계정 정보·API 키를 넣지 않는다.
Worker는 **실행 시점의 최신 카탈로그·공식 첨부·AI 설정**을 사용한다. 접수 당시 파일을 고정하는 기능은 아니다.
추출 결과의 파일 해시·파서·모델·프롬프트 버전은 기존 양식 스냅샷에 보존한다.
동일 버전 캐시도 첨부를 다시 내려받아 fingerprint를 비교한 다음 재사용한다. 다운로드까지 생략하는 캐시는 아니다.

## API와 화면

| 요청 | 동작 |
|---|---|
| `POST /api/v1/application-preparations/forms/discovery-jobs` | `{requestKey, sourceCode, sourceProgramId}` 접수. 새 작업과 동일 키 재조회 모두 202 |
| `GET .../forms/discovery-jobs/{id}` | 본인 작업 상태·결과 조회. 타인 작업과 없는 작업은 동일한 404 |
| `GET .../forms/discovery-jobs` | 본인의 최근 20개 작업 요약, ID 내림차순. 큰 결과는 상세 GET에서 조회 |
| `GET /api/v1/admin/queues` | 관리자 전용 읽기 전용 큐 운영 현황 |

모든 응답은 `Cache-Control: no-store`다. 분석 결과는 `result.items`, `result.warnings`, `result.cached`에 반환한다.
GET 목록의 `result`는 항상 null이며, 상세/POST에서 SUCCEEDED일 때만 결과를 포함한다.
실패는 최초 POST를 나중에 실패 응답으로 바꾸는 것이 아니라 작업 GET의 `status`·`failureCode`로 알린다.

작성 화면은 본인의 최근 20개 분석 작업을 카드로 표시하고, 진입 시 URL의 공고와 일치하는 최근 작업 또는 전체 최신 작업을 자동 복원한다.
QUEUED/RUNNING이면 기존 작업 상세 GET과 3초 자동 조회를 이어가고, SUCCEEDED이면 저장된 결과를 바로 표시한다.
진입·로그인·목록 클릭과 복원 조회만으로 새 분석을 요청하지 않는다. 브라우저를 닫거나 로그아웃해도 이미 접수된 작업은 취소되지 않는다.
자동 조회 실패 후 다시 시도는 기존 작업 GET만 실행한다. 같은 화면에서 POST 응답이 유실된 경우에는 같은 UUID를 재사용하며,
화면을 나간 뒤에는 최근 작업 목록과 상세 GET으로 서버에 접수된 작업을 복구한다. 자동 재접수하지 않는다.
작업 목록 API는 최근 20개까지만 제공하며 전체 이력 페이지·삭제·취소·자동 정리는 아직 없다.

## 중복·상태·한도

V26 `application_form_discovery_job`에 아래 규칙을 적용한다.

- `(owner_account_id, request_key)`는 DB 고유키다. 같은 키·같은 공고는 기존 작업을 반환하며 다른 공고면 409다.
- `(source_code, source_program_id, active_slot)` 고유키는 계정이 달라도 같은 공고의 중복 분석을 막는다.
  QUEUED/RUNNING/UNKNOWN이 있으면 다른 키 요청은 409다. 타인 작업 ID·결과는 공개하지 않는다.
- 계정 행을 잠그고 해당 계정의 활성 작업 최대 3건을 검사한다. 초과 시 429다.
- 접수 POST에는 기존 계정별 요청량·공유 슬롯 제한을 적용한다. 동일 키 POST도 이 요청량 제한을 통과해야 한다.
  GET 조회는 새 접수가 아니다. Worker는 `executeBackground`로 실행 슬롯만 사용하며 접수 횟수를 다시 계산하지 않는다.
- 공유 슬롯 부족이면 DB 실행권을 얻기 전에 종료한다. QUEUED 상태를 유지하고 Outbox가 다시 전달한다.
- 실행 선점 및 유료 AI 호출 직전에 계정 정지·탈퇴와 실행 만료를 확인한다. 이미 시작된 외부 호출을 취소하는 기능은 아니다.
- RUNNING을 선점한 작업은 재전달로 다시 실행하지 않는다. 작업 상태의 DB 제약과 조건부 UPDATE로 보호한다.

| 상태 | 처리 |
|---|---|
| QUEUED | 접수·발행·실행 대기. 1시간 초과 또는 계정 비활성이면 FAILED |
| RUNNING | Worker 실행권 획득. 동일 ID 재전달은 실행하지 않음 |
| SUCCEEDED | 결과 저장 완료. 동일 키나 상세 조회는 저장된 결과만 반환 |
| FAILED | 원문 수집 실패·신청 문서 없음 등 확정된 실패. 새 작업은 사용자가 공고를 다시 선택해 요청 |
| UNKNOWN | 유료 호출 이후 결과 불명·완료 저장 불명 또는 RUNNING 20분 초과. 자동 재호출 및 새 키 분석 차단 |

만료 정리는 Outbox 스케줄러가 수행한다. 기능 스위치가 꺼져 있으면 GET은 상태를 변경하지 않으므로
예전 QUEUED/RUNNING이 보일 수 있다. 운영 API의 기능 활성 여부·오래된 시각도 함께 확인해야 한다.
20분이 지난 작업의 늦은 성공은 UNKNOWN 등을 덮어쓰지 못한다. `UNKNOWN`을 단순 실패로 취급해 일괄 재시도하지 않는다.
DB와 외부 AI를 원자적으로 묶을 수 없으므로 exactly-once 과금을 보장하지 않는다. 일별 비용 상한도 추가하지 않았다.

AI Service가 응답 수신 후 근거 검증 실패를 `422 / APPLICATION_FORM_AI_INVALID_RESPONSE`로 확정한 경우에는 FAILED로 종료한다.
기존의 포괄적인 503, 응답 유실, 시간 초과는 이 확정 실패로 간주하지 않는다. 이미 저장된 UNKNOWN을 일괄 해제하지 않으며,
개별 작업의 AI 로그로 검증 실패가 확인된 경우에만 운영자가 해당 작업을 FAILED로 정정할 수 있다. 정정 자체는 AI를 재실행하지 않는다.

## 브로커 설정·장애

- 주 exchange/queue: `govbiz.application-form-discovery.generation.v1`
- dead exchange/queue: `govbiz.application-form-discovery.generation.dead.v1`
- durable quorum, single-active-consumer, concurrency 1, prefetch 1, manual ACK.
- 주 큐: 최대 1,000개, reject-publish, TTL 1시간, delivery-limit 3, at-least-once dead lettering.
- DLQ: 최대 1,000개, reject-publish, 자동 재생 없음.
- 전용 Outbox 스케줄러: 5초마다 최대 20개 조회. 작업별 조건부 발행 예약은 1분 간격.
- persistent 메시지, publisher confirm·mandatory return 둘 다 확인한 뒤 `last_published_at` 기록.

브로커 장애·라우팅 실패는 DB의 QUEUED를 보존하고 발행만 재시도한다. 발행 재시도는 AI 재시도가 아니다.
잘못된 메시지 또는 완료 기록을 확정할 수 없는 DB 실패는 DLQ로 격리한다. 프로세스 중단 후 남은 RUNNING은 재호출하지 않는다.
세 종류의 큐는 분리되어 있지만 소비자는 같은 Core 프로세스·브로커·공유 AI 슬롯을 사용한다.
단일 RabbitMQ 노드의 quorum 큐를 고가용성 클러스터로 표현하면 안 된다.

## 관리자 운영 확인

관리자 계정으로 로그인한 브라우저에서 `/api/v1/admin/queues`를 열거나 인증된 개발 도구로 GET한다.
비로그인은 401, 일반 회원은 403이다. 정기 리포트·중복 검토·공식 문서 분석을 각각 반환한다.
관리자 화면 위젯·알림·Prometheus/Grafana·수동 복구 API는 이번 범위에 포함하지 않았다.

| 필드 | 정확한 의미 |
|---|---|
| `enabled` | 이 Core 인스턴스의 해당 기능 큐 설정 |
| `queue.available` / `deadQueue.available` | AMQP passive 조회 성공 여부. 장애·없는 큐는 false이며 수치는 null |
| `readyMessages` | 브로커에서 아직 소비자에게 전달하지 않은 메시지 수. unacked와 DB 작업 수는 아님 |
| `consumers` | 연결된 소비자 수. single-active-consumer의 대기 소비자도 포함할 수 있어 실제 실행 수가 아님 |
| `jobs[].count` | DB에 보관된 상태별 작업 수. 기간 제한 없는 누적 보관 건수이며 실패율이 아님 |
| `jobs[].oldestAt` | 해당 상태 중 가장 오래된 접수 시각. RUNNING은 실제 실행 시작 시각 |
| `unconfirmedPublicationCount` | QUEUED 중 `last_published_at`이 없는 건수. 브로커 실패 횟수라고 단정할 수 없음 |

비활성 기능의 broker 항목은 null이고 DB 현황은 계속 반환한다. DB 조회 실패는 오류로 반환하며 정상 0건으로 숨기지 않는다.
상태별 행이 없으면 해당 상태의 보관 작업이 없는 것이다. DB·브로커 수치는 서로 다른 시점의 관측이라 같을 필요가 없다.
중복 전달 때문에 메시지 수와 작업 수도 다를 수 있다. 조회 코드는 passive 확인만 하며 메시지 소비·purge·재발행·DB 작업 상태 변경을 하지 않는다.

증상별 확인 순서:

1. QUEUED가 오래됐으면 enabled, 브로커 available, 소비자 수, Core Outbox 경고 로그를 확인한다.
2. 발행 확인이 없으면 RabbitMQ 연결·binding·디스크 경보·큐 한도를 확인한다. 복구되면 Outbox가 기존 ID를 전달한다.
3. UNKNOWN 또는 DLQ가 있으면 DB 작업 ID/상태/`ai_started_at`·Core 로그·AI 측 호출 기록을 함께 확인한다.
4. 유료 호출 여부를 확인하기 전에는 RUNNING/UNKNOWN을 QUEUED로 바꾸거나 새 ID로 복제하지 않는다.
   작업 결과 정합성과 재호출 비용을 확인한 운영자만 별도 복구 절차를 결정한다. 일괄 재생 명령은 제공하지 않는다.

## 실행·검증

Compose와 `.env.example`의 `APPLICATION_FORM_DISCOVERY_QUEUE_ENABLED=true`가 기본이다.
Core 단독 실행 기본값은 false이며 신규 작업 POST는 503, 저장된 작업 GET은 유지한다.
최신 화면은 비동기 API만 사용한다. 구형 `POST .../forms/discover`는 **큐가 꺼진 단독 개발 환경에서만** 기존 동기 계약으로 남아 있고,
큐를 켠 환경에서는 409로 막아 실행권·멱등 처리를 우회하지 못하게 한다. 장애 시 동기 호출로 자동 전환하지 않는다.

Core·Frontend를 함께 갱신하고 V26을 적용해야 한다. 기존 DB/브로커 볼륨을 삭제하지 않는다.
큐 스위치를 켜면 기존 QUEUED도 처리되므로 실제 API 비용과 실행 대기 작업을 먼저 확인한다.
이번 개발 검증은 격리된 테스트 자원만 사용하며 사용자의 실행 중인 개발 DB에 migration을 적용하거나 서비스를 배포하지 않는다.

검증 경로:

- JDK 21 Core `./gradlew clean build --no-daemon`: 실제 MySQL 8.4·RabbitMQ Testcontainers, 외부 AI 스텁.
- `ApplicationFormDiscoveryQueueIntegrationTest`: 202/Origin/소유권/키 재사용, DB JSON·제약·한도,
  중복 메시지 1회 실행, 결과 불명·만료·계정 정지·늦은 완료, 브로커 중단/복구·binding 누락·DLQ·관리자 조회.
- 기존 네 제공처 실제 Service 경로의 수집·AI 응답·캐시 검증도 전체 Core 테스트에 포함.
- Frontend `pnpm test`, `pnpm lint`, `pnpm build`: 상태 자동 조회, 이력 복원, 응답 유실 키 재사용, 통신 실패 후 GET 재시도.
- 인프라 스크립트 unittest와 격리 Compose: 세 주 큐·DLQ, 소비자 연결, 브로커 재생성 후 재연결. 실제 OpenAI 대신 스텁 사용.

Docker 메모리가 작은 환경에서는 전체 Core 테스트와 Compose 검증을 동시에 실행하지 않는다.
Core 테스트 컨텍스트 캐시를 제한할 때만 `JAVA_TOOL_OPTIONS=-Dspring.test.context.cache.maxSize=4`를 사용한다.
이 테스트는 실제 공식 문서 추출 품질·운영 처리량·토큰 절감률을 입증하지 않는다.

### 2026-09-13 실행 결과

- JDK 21 `clean build`: **1,269건, 실패·오류·건너뜀 0**. 신규 큐 MySQL/RabbitMQ 통합 7건 포함.
- Frontend `pnpm test --maxWorkers=2`: **1,102건 통과**. 최신 코드의 lint·build도 통과.
  Core 전체 테스트와 동시 실행할 때 기존 카탈로그/모집글 테스트에서 일시적인 대기 제한 실패가 발생해
  Core 종료 후 Frontend 전체를 단독 재실행했다. 테스트 제한 시간을 늘리거나 실패한 기존 기능을 수정하지 않았다.
- 인프라 스크립트 unittest **25건 통과**. 최초 sandbox 실행의 로컬 HTTP 소켓 제한은 소켓 허용 후 재검증했다.
- 격리 Compose `govbiz-verify-form-20260913` **통과**: 세 종류의 quorum 주 큐·DLQ와 소비자 연결,
  RabbitMQ 중단 중 MySQL 조회 유지, 동일 볼륨으로 브로커 재생성 후 Core 재시작 없는 세 소비자 재연결을 확인했다.
  기존 네 제공처 스텁 동기화·문항 입력 저장·Elasticsearch/Qdrant/Redis/AI 장애 복구도 통과했다.
  실제 OpenAI·공식 공고 API·SMTP는 사용하지 않았다. 검증 종료 시 해당 프로젝트의 임시 컨테이너·볼륨만 정리한다.
- Frontend 빌드의 500KB 초과 번들 경고는 남아 있으며 이번 작업에서 번들 분할은 변경하지 않았다.

## 공고별 신청 양식 사전분석

신규·변경 공고의 상태와 시스템 분석 Outbox는 `application_form_availability`에 저장합니다. 공식 제공처 전체 동기화 성공 transaction에서 등록하고, 별도 Worker가 첨부 수집·파싱·AI 분석을 수행합니다. 성공 snapshot 저장과 AVAILABLE 활성화는 하나의 짧은 transaction입니다.

현재 사용자 작성 화면은 계정별 Discovery Job을 실행하지 않고 공고별 availability API에서 활성 snapshot을 읽습니다. 기존 계정별 discovery job API는 별도 책임으로 남아 있습니다. 새 작성은 활성 formVersionId만 허용하고, 기존 작성의 과거 버전과 최종 생성의 공식 원본 해시 대조는 유지합니다.

Discovery 전용 timeout은 model 210초 < AI run 240초 < Core read 270초 < Worker lease 1,800초입니다. 다른 신청 준비 기능의 전역 timeout은 변경하지 않습니다. [상태·재시도·백필 실행 방법](application-form-availability.md)을 참고하세요.
