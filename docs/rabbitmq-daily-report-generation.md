# RabbitMQ 적용: 정기 일일 리포트 생성

## 적용 범위와 목적

정기 리포트 스케줄러에서 오래 걸리는 검색·추천·근거 답변을 분리했습니다. 스케줄러는 MySQL에 작업을 예약하고,
Core 안의 전용 RabbitMQ 소비자가 순서대로 생성합니다. 정기 실행 스레드가 계정마다 AI 응답을 기다리지 않으며,
브로커가 일시적으로 중단돼도 아직 실행하지 않은 작업은 DB에서 찾아 다시 발행할 수 있습니다.

**개별 AI 응답을 빠르게 하거나 토큰을 줄이는 변경은 아닙니다.** 별도 Worker 서버, 동시 생성 확대,
운영 고가용성 클러스터까지 구현한 것도 아닙니다. 소비자는 Core와 CPU·메모리·프로세스를 공유합니다.

- 이 문서의 적용 범위: 정기 일일 리포트의 **생성 작업**.
- 유지: 웹 `POST /api/v1/me/daily-reports/preview`는 기존 동기 생성·조회 계약, 기존 검색·근거 답변 구현 재사용.
- 이 생성 큐의 미적용 범위: 실시간 대화 검색, 공고 동기화·벡터 색인, 이메일 전송, 신청 양식 발견, 알림 등 다른 업무.
- 메일 발송은 후속 [발송 전용 큐](rabbitmq-daily-report-delivery.md)로 분리했습니다. 기존 DB 발송 권한과 `UNKNOWN` 정책을 유지합니다.
- 후속으로 [중복 지원·수혜 검토 분석](rabbitmq-combination-review.md)에 별도 큐를 적용했습니다. 리포트 큐의 예산·상태 정책과 구분합니다.
- 2026-09-13 후속 [공식 문서 분석·관리자 운영 조회](rabbitmq-application-form-discovery.md)에 이어 발송 큐도 운영 조회에 포함합니다. 수동 미리보기는 유지합니다.

### 처음 읽을 때 알아둘 용어

| 용어 | 이 프로젝트에서의 의미 |
|---|---|
| 생산자 / 소비자 | 작업 ID를 큐에 보내는 Core 코드 / ID를 받아 실제 리포트를 만드는 Core 코드 |
| Outbox | DB에 남겨 놓는 발행 대기 기록. DB 저장 직후 서버가 종료돼도 발행할 작업을 다시 찾는 기준 |
| Publisher confirm | RabbitMQ가 발행을 수락했다는 확인. AI 생성이나 메일 발송 완료라는 뜻은 아님 |
| ACK | 소비자가 메시지 처리를 마쳤다고 브로커에 알리는 응답. 정상 생성은 결과를 DB에 저장한 뒤 전송 |
| DLQ | 거부·만료 등으로 주 큐에서 빠진 메시지를 받는 별도 큐. 수신 해제로 `SKIPPED` 처리한 작업은 정상 ACK하며, 모든 업무 실패가 DLQ로 가는 것은 아님 |

## 실제 호출 흐름

```text
DailyReportScheduler (전용 단일 스레드, 완료 후 5분 간격, 발송 시작 시간·수신 설정 확인)
  → DailyReportService.enqueueScheduled
  → DailyReportRepository → MyBatis Mapper → XML → MySQL
      같은 transaction: 날짜별 리포트 예약 + 일일 시도 예산 + generation_job(QUEUED)

DailyReportOutboxScheduler (전용 스레드, 5초 간격)
  → DB에서 미실행 작업 조회·발행 시점 예약
  → DailyReportQueueClient → RabbitMQ (persistent + publisher confirm + mandatory return 검사)
  → 확인된 발행 시각을 DB에 기록

RabbitMQ → DailyReportGenerationConsumer (Core 내부, active consumer 1개 / prefetch 1)
  → DailyReportService.generateQueued
  → DB QUEUED → RUNNING 선점
  → 계정·수신 동의·기업·서울 날짜 재검사
  → 기존 검색 + 최대 3개 공고의 근거 분석 → AI Service
  → DB에 리포트와 작업 결과를 함께 저장 → ACK

다음 DailyReportScheduler 실행
  → READY 리포트 재사용 → 발송 Outbox → 별도 발송 큐/소비자 → 기존 deliver → DailyReportMailClient → SMTP
  (발송 큐 스위치가 false이면 기존 직접 SMTP 경로)
```

완료 직후 즉시 메일을 보내는 구조가 아닙니다. 정상적으로는 다음 5분 주기에서 발송 예약하며, 계정 처리 상한 등에 따라
더 늦어질 수 있습니다. 외부 HTTP·RabbitMQ·SMTP 호출은 DB transaction 안에 넣지 않습니다.
예약 스레드는 공고 수집과 별도로 실행되며, 활성 조건과 격리 검증은 [예약 스케줄러 격리](rabbitmq-daily-report-delivery.md#예약-스케줄러-격리)를 참고하세요.

## 코드를 읽는 순서와 파일별 책임

모든 Kotlin 파일은 기존 `ai.govbiz.core.dailyreport` 기능 안에 배치합니다. 새로운 범용 메시징 프레임워크나
별도 AI Agent를 만들지 않았습니다. 아래 순서로 읽으면 예약 → 전달 → 실행 → 저장을 따라갈 수 있습니다.

| 파일 | 책임 |
|---|---|
| [DailyReportScheduler](../backend/core-service/src/main/kotlin/ai/govbiz/core/dailyreport/service/DailyReportScheduler.kt) | 발송 시간·대상 계정·배치 상한을 확인하고 정기 작업 예약. 이미 READY인 리포트는 기존 발송 경로로 전달 |
| [DailyReportService](../backend/core-service/src/main/kotlin/ai/govbiz/core/dailyreport/service/DailyReportService.kt) | `enqueueScheduled`로 예약, `generateQueued`로 선점·수신 자격 재검사·기존 검색/근거 분석 실행. 수동 미리보기와 생성 로직 공유 |
| [DailyReportRepository](../backend/core-service/src/main/kotlin/ai/govbiz/core/dailyreport/repository/DailyReportRepository.kt) | 리포트·예산·작업 예약의 transaction, 완료 저장, 입력/결과 JSON 변환 |
| [DailyReportMapper](../backend/core-service/src/main/kotlin/ai/govbiz/core/dailyreport/repository/mapper/DailyReportMapper.kt) / [Mapper XML](../backend/core-service/src/main/resources/mybatis/dailyreport/repository/DailyReportMapper.xml) | 실제 SQL 실행 계약과 조건부 선점·만료·재시도 차단 SQL. RabbitMQ 호출은 하지 않음 |
| [DailyReportOutboxScheduler](../backend/core-service/src/main/kotlin/ai/govbiz/core/dailyreport/service/DailyReportOutboxScheduler.kt) | 만료 정리, 미실행 작업 조회, 다음 발행 시점 예약, 발행 확인 시각 기록 |
| [DailyReportQueueClient](../backend/core-service/src/main/kotlin/ai/govbiz/core/dailyreport/client/DailyReportQueueClient.kt) | 작업 ID 메시지 발행, confirm과 반환 메시지 검사 |
| [DailyReportGenerationConsumer](../backend/core-service/src/main/kotlin/ai/govbiz/core/dailyreport/service/DailyReportGenerationConsumer.kt) | 메시지 형식 검증, Service 호출, ACK 또는 재큐잉 없는 거부 |
| [DailyReportRabbitConfig](../backend/core-service/src/main/kotlin/ai/govbiz/core/dailyreport/config/DailyReportRabbitConfig.kt) | 주 큐·DLQ·exchange·binding, 소비자 수·prefetch·수동 ACK, Outbox 전용 스레드 구성 |
| [DailyReportConfig](../backend/core-service/src/main/kotlin/ai/govbiz/core/dailyreport/config/DailyReportConfig.kt) / [DailyReportQueueProperties](../backend/core-service/src/main/kotlin/ai/govbiz/core/dailyreport/config/DailyReportQueueProperties.kt) | 큐 스위치 바인딩과 정기 실행/큐 설정 조합 검증 |
| [V23 migration](../backend/core-service/src/main/resources/db/migration/V23__create_daily_report_generation_job.sql) / [Compose](../infrastructure/compose.yaml) | 작업 테이블·제약조건 추가 / 브로커·볼륨·내부 연결 및 기동 순서 |

소비자는 Service를 통해서만 업무를 수행하고, Service·Repository가 큐의 `Channel`이나 ACK를 직접 다루지 않습니다.
DB는 기존 `Repository → MyBatis Mapper → XML → MySQL` 경계를 유지합니다.

## 저장 구조와 메시지

Flyway [V23](../backend/core-service/src/main/resources/db/migration/V23__create_daily_report_generation_job.sql)은
`daily_report_generation_job` 테이블을 추가합니다. 이 테이블 하나가 실행 기록과 **Outbox(발행 대기 기록)** 를 겸합니다.
기존 migration이나 공고·회원·리포트 데이터를 삭제하지 않습니다.

| 데이터 | 역할 |
|---|---|
| `report_id`, `generation_key` | 원래 리포트와 이번 생성 시도 연결. 복합 UNIQUE 및 FK |
| `status`, `created_at`, `started_at`, `finished_at` | 실행 상태·시각 |
| `deadline_at` | 대기 만료: 예약 후 1시간과 다음 서울 자정 중 이른 시각 |
| `next_publish_at`, `publish_attempts` | 다음 발행 시각과 발행 시도 횟수 |
| `last_published_at` | 브로커가 수락하고 라우팅됐다고 확인한 최근 시각. **생성 완료 표시가 아님** |

메시지는 `v1:123` 형식의 버전과 작업 ID뿐입니다. 이메일, 기업 조건, API 키, 인증 토큰, AI 출력은 넣지 않습니다.
소비자는 ID로 DB의 고정 입력 스냅샷을 읽습니다. 전달 포맷·길이·ID를 검증하고 메시지의 임의 클래스 역직렬화를 하지 않습니다.

| 작업 상태 | 의미 | 공개 리포트 상태 |
|---|---|---|
| `QUEUED` | 예약·발행 대기 또는 브로커에서 소비 대기 | `GENERATING` |
| `RUNNING` | DB 선점 후 생성 실행 | `GENERATING` |
| `SUCCEEDED` | 결과 저장 완료 | `READY` |
| `FAILED` | 처리 오류 또는 시작 전 대기 만료 | `FAILED` |
| `SKIPPED` | 계정·구독·기업·날짜 조건 변경으로 미실행 | `FAILED` + 건너뛴 이유 |
| `UNKNOWN` | 시작 후 20분 이상 완료 기록이 없어 결과 불명 | `FAILED` + 운영자 확인 안내 |

대기/실행을 화면에서 따로 표시하는 새 HTTP 상태나 관리 API는 추가하지 않았습니다. 기존 프런트엔드 계약은 유지합니다.

## 중복·재시도·비용 경계

1. 예약은 기존 계정·날짜별 최대 **2회**, 공유 일일 예산 기본 **20회** 안에서 수행합니다. 예산과 작업을 함께
   커밋하므로 작업 INSERT 실패 시 리포트와 예산도 rollback됩니다. 실패·건너뜀은 예산을 환급하지 않습니다.
2. 발행기는 한 번에 최대 20개를 조회합니다. 같은 작업은 1분 간격으로 재발행할 수 있고, 브로커 발행이 실패하면
   현재 배치를 멈춥니다. 발행 재시도는 새 생성 예약이 아니므로 생성 시도 예산을 다시 소비하지 않습니다.
3. 브로커 confirm을 받기 전 종료되거나, confirm 뒤 DB 기록에 실패하면 중복 메시지가 생길 수 있습니다.
   아직 `QUEUED`인 작업은 발행 확인 후에도 재발행될 수 있습니다. 이를 전제로 DB의 조건부 `QUEUED → RUNNING`
   전이가 같은 작업을 한 번만 선점하게 합니다. 이미 선점·완료·만료된 작업의 메시지는 AI를 다시 호출하지 않습니다.
4. 생성 시도마다 새 `generation_key`를 사용합니다. 이전 메시지·늦은 완료가 새 결과를 덮어쓸 수 없습니다.
   결과와 작업의 완료 전이는 하나의 transaction이며, 커밋 후 ACK 전에 연결이 끊겨도 재전달은 중복 실행하지 않습니다.
5. 대기 시간 만료와 서비스가 관측한 처리 실패는 기존 한도 안에서 재예약할 수 있습니다. 외부 HTTP timeout을 포함한
   처리 실패가 외부 제공자의 미과금을 뜻하지는 않으므로, 재시도에 비용이 들 수 있습니다.
6. 실행 중 프로세스 종료처럼 완료 기록이 남지 않은 작업은 시작 20분 후 `UNKNOWN`으로 전환합니다.
   해당 계정·날짜는 **자동/미리보기 재시도를 모두 차단**합니다. 늦게 돌아온 이전 결과도 저장하지 않습니다.
   운영자 복구 API는 없으며 DB 상태를 무작정 `QUEUED`로 바꾸거나 DLQ를 일괄 재생하면 안 됩니다.
7. `single-active-consumer`와 prefetch 1은 큐 소비를 직렬화합니다. 미리보기와도 Core 프로세스 내 생성 슬롯을
   공유합니다. 여러 Core의 수동 미리보기까지 전역 직렬화하거나, 네트워크 단절 뒤 여전히 동작 중인 외부 AI의
   실행/과금을 정확히 한 번으로 보장하는 분산 transaction은 아닙니다.

슬롯이 바쁘거나 DB 처리 결과를 확인할 수 없으면 메시지를 재큐잉하지 않고 DLQ로 보냅니다. 미선점 작업만 DB에서
다시 발행합니다. 시작한 작업은 자동 재실행하지 않으며 만료 검사로 `UNKNOWN`을 남깁니다.

## 브로커 구성

- RabbitMQ `4.3.5-management-alpine`, Spring Boot가 관리하는 `spring-boot-starter-amqp` 사용.
- 주 exchange/queue: `govbiz.daily-report.generation.v1`.
- DLX/DLQ: `govbiz.daily-report.generation.dead.v1`. 두 binding의 routing key는 주 queue 이름.
- durable direct exchange + durable quorum queue, persistent 메시지, 수동 ACK.
- 주 queue: 최대 1,000개, reject-publish, TTL 1시간, delivery limit 3, single-active-consumer.
- DLQ: 최대 1,000개, reject-publish. 주 queue의 dead-letter 전략은 at-least-once.
- DLQ 자동 재생·삭제는 없습니다. DLQ가 가득 차면 dead-letter 전달이 정체되고 주 queue도 영향을 받으므로 감시·정리가 필요합니다.
- publisher confirm은 최대 3초 대기하며 mandatory return도 확인합니다. confirm만 받고 실제 queue로 전달되지 않은 경우를 성공으로 기록하지 않습니다.
- Compose는 노드 이름이 유지되도록 `hostname: rabbitmq`, `rabbitmq-data` 볼륨을 사용합니다.
  초기 상태 점검은 `su-exec rabbitmq`로 서버와 같은 사용자 권한에서 실행해 root 소유 cookie 생성 경합을 피합니다.
  AMQP 5672·관리 UI 15672는 호스트에 공개하지 않습니다. 단일 노드이므로 quorum이라고 해서 고가용성인 것은 아닙니다.

큐 속성을 바꿀 때 기존 큐와 다른 immutable 인수를 무조건 재선언하면 시작 오류가 납니다. 데이터가 있는 queue/volume을
삭제하지 말고, 후속 변경 시 버전이 다른 큐로 전환하는 계획을 먼저 세워야 합니다.

## 실행 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `DAILY_REPORT_ENABLED` | `false` | 새 정기 작업 예약과 기존 리포트 발송 |
| `DAILY_REPORT_QUEUE_ENABLED` | 직접 Core `false`, Compose `true` | Outbox 발행·소비·만료 검사 |
| `RABBITMQ_HOST`, `RABBITMQ_PORT` | 직접 Core `127.0.0.1`, `5672` | Compose에서는 내부 `rabbitmq:5672` |
| `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD` | `govbiz`, `govbiz-rabbit-local` | 공개 개발 기본값. 운영 secret으로 교체 |
| `RABBITMQ_VHOST` | `govbiz` | Compose는 브로커/Core 모두 `govbiz` 고정 |

`DAILY_REPORT_ENABLED=true`인데 큐가 꺼져 있으면 시작 시 명시적으로 실패합니다. 큐만 켜도 새 정기 작업은 예약하지
않지만, **DB에 이미 예약된 작업은 실행할 수 있습니다.** 정기 예약과 기존 큐 작업의 추가 실행을 막으려면 정기 예약과 큐 스위치를
함께 끄고 실행 중인 작업 상태를 확인해야 합니다. 프로세스를 강제 종료한다고 이미 전송된 AI 요청이 취소되지는 않습니다.
평가 캡처/내보내기 전용 프로필은 큐·정기 예약·메일을 모두 명시적으로 비활성화합니다.

### 정기 예약과 큐 스위치의 차이

아래 표는 생성 큐와 정기 예약의 관계입니다. **메일 사용 여부와 V27 발송 큐는 별도 설정**입니다.
표의 발송 중지는 새 예약 기준이며, `DAILY_REPORT_DELIVERY_QUEUE_ENABLED=true`이고 SMTP가 가능하면 기존 발송 대기는 처리됩니다.

| `DAILY_REPORT_ENABLED` | `DAILY_REPORT_QUEUE_ENABLED` | 동작 |
|---|---|---|
| `false` | `false` | 새 정기 예약·정기 발송과 큐 발행/소비가 모두 꺼짐. 웹 수동 미리보기는 별도 경로 |
| `false` | `true` | 새 정기 예약·정기 발송은 하지 않음. 기존 대기 작업의 발행·생성·만료 검사는 실행 |
| `true` | `true` | 설정된 시간·수신 조건·예산 안에서 예약/발송하고 큐에서 생성. SMTP가 사용 가능해야 정기 스케줄러가 대상 계정을 처리 |
| `true` | `false` | 잘못된 조합으로 서버 시작을 거부. 동기 생성으로 우회하지 않음 |

큐와 정기 예약을 모두 꺼도 사용자가 누르는 수동 미리보기와 이메일 확인 요청까지 차단되는 것은 아닙니다.
두 스위치는 전체 AI/SMTP 사용 중지 스위치가 아닙니다. 이미 외부에 전송된 요청을 취소하거나 기존 작업을 삭제하지도 않습니다.

기존 개발 스택에는 우선 `rabbitmq` 서비스를 추가하고 Core를 새 코드로 빌드해야 합니다.
[안전한 백엔드 갱신 순서](../infrastructure/README.md)를 참고하세요.
로컬 `.env`와 기존 수집·색인·메일 스위치를 임의로 켜지 않습니다. RabbitMQ 추가 자체는 AI나 SMTP 호출을 요구하지 않습니다.

기본 사용자는 새 브로커 데이터 볼륨을 초기화할 때 만들어집니다. 이미 초기화한 볼륨의 인증 정보는 `.env`만 바꾼다고
변경되지 않습니다. 운영에서는 권한·인증 정보 회전, 네트워크 격리, TLS, 디스크 및 메모리 경보, 백업/복구를 별도로 설계해야 합니다.

## 운영 확인과 미구현 항목

아래 조회는 계정·기업·본문을 출력하지 않는 읽기 전용 점검 예입니다. 개발 스택 이름이 다르면 정확한 대상을 확인합니다.

```bash
docker compose --env-file .env --file infrastructure/compose.yaml exec --user rabbitmq rabbitmq \
  rabbitmqctl list_queues -p govbiz name type messages_ready messages_unacknowledged consumers
```

DB 도구에서는 작업 상태와 오래된 대기를 확인합니다(모든 시각은 서울 기준).

```sql
SELECT status, COUNT(*) AS job_count, MIN(created_at) AS oldest_created_at
FROM daily_report_generation_job
GROUP BY status;

SELECT id, report_id, status, publish_attempts, last_published_at, started_at, deadline_at
FROM daily_report_generation_job
WHERE status IN ('QUEUED', 'RUNNING', 'UNKNOWN')
ORDER BY created_at
LIMIT 100;
```

로그에는 job ID와 실패 구분만 남깁니다. 연결 실패 원문이나 개인 입력을 사용자 응답으로 노출하지 않습니다.
운영 전에는 오래된 대기·`UNKNOWN`·DLQ 적재·디스크 경보 알림을 연결해야 합니다. 작업 이력 자동 보관 기간/정리,
관리 화면, 안전한 수동 복구 도구, 별도 Worker 프로세스 및 운영 부하 측정은 후속 범위입니다.

### 증상별 확인 순서

| 증상 | 먼저 확인할 내용 | 조치 시 주의할 점 |
|---|---|---|
| 정기 작업 행이 생기지 않음 | 정기 예약 스위치, SMTP 사용 가능 여부, 서울 발송 시간, 수신 확인·동의, 기업 등록, 색인 준비, 일일 예산 | RabbitMQ만 켜서는 새 작업이 예약되지 않음. 시험 삼아 모든 계정의 자동 발송을 켜지 않음 |
| `QUEUED`와 발행 시도만 늘어남 | 브로커 상태·인증·vhost, 주 큐/binding, 큐/디스크 한도, 소비자 수, 현재 생성 슬롯 | `last_published_at`이 있어도 소비 완료를 뜻하지 않음. 원인 복구 후 미실행 작업은 자동 재발행되므로 새 리포트를 중복 생성하지 않음 |
| `RUNNING`이 오래 유지됨 | `started_at`, 해당 job ID의 Core 로그와 AI Service 상태 | 프로세스 중단 등으로 20분 이상 완료 기록이 없으면 만료 검사에서 `UNKNOWN`. 상태만 되돌려 재실행하지 않음 |
| `UNKNOWN`으로 실패 표시 | 해당 실행이 외부 요청을 보냈는지, 결과 저장 전에 종료됐는지 등 운영 기록 | 외부 사용량과 결과를 확인하기 전 자동/수동 재시도를 허용하지 않음. 안전한 운영자 복구 기능은 미구현 |
| DLQ에 메시지가 쌓임 | 메시지 형식, job ID의 DB 상태, 소비자 거부·연결 오류, 대기 만료 여부 | DLQ 메시지 수는 실패한 리포트 수와 같지 않음. 중복·이미 완료된 작업이 있을 수 있어 일괄 재생 금지 |
| 리포트는 READY인데 메일이 안 옴 | 정기 예약·발송 큐·메일 스위치, 다음 주기, 현재 동의·계정 상태, `delivery_status`, SMTP | [발송 큐 문서](rabbitmq-daily-report-delivery.md)의 대기·UNKNOWN 확인. `SENT`는 SMTP 접수이며 받은 편지함 도착 보장이 아님 |

처음 도입할 때는 브로커와 서버의 기동·큐 연결을 먼저 확인하고, 실제 AI 생성/메일 검증은 대상 계정과 비용 범위를
정한 뒤 진행합니다. 개발 데이터를 삭제하는 `down --volumes`, migration 이력 수정, DLQ 일괄 재생을 복구의 첫 조치로 삼지 않습니다.

## 검증 방법

- `backend/core-service`: JDK 21에서 `./gradlew clean build --no-daemon`.
- `DailyReportRepositoryIntegrationTest`: 실제 MySQL 8.4에서 예약/예산/작업 rollback, 동시 선점,
  한도, 대기 만료, 실행 불명 재시도 차단, 오래된 키 차단을 검증합니다.
- `DailyReportQueueIntegrationTest`: 실제 MySQL·RabbitMQ, AI 경계만 스텁. 소비자 중단 중 적재, 중복 메시지,
  브로커 중단 후 재발행, 라우팅 누락, 수신 해제, DLQ를 검증합니다.
- `infrastructure/scripts/verify-compose.sh`: 독립 검증 프로젝트와 가짜 upstream만 사용합니다. 실제 브로커/소비자
  연결, 브로커 중단 시 일반 카탈로그 유지, 같은 볼륨으로 재생성 후 Core 재시작 없는 소비자 재연결도 확인합니다.
- `python -B -m unittest discover -s infrastructure/scripts -p 'test_*.py'`, shell 구문, `git diff --check`.

위 검증은 연결·상태·장애 처리 검증이며 실제 AI 품질·토큰 절감·처리량 개선·SMTP 도달률의 증거가 아닙니다.

### 실행 결과 (2026-09-12)

- JDK 21 `./gradlew clean build --no-daemon`: 1,222건 통과, 실패·오류·건너뜀 0건. 기존 `live-source` 태그는 기본 제외입니다.
  리포트 관련 54건에는 실제 MySQL Repository 17건과 실제 RabbitMQ·MySQL 연결 5건이 포함됩니다.
- 인프라 스크립트 테스트 24건, shell 구문 및 `git diff --check` 통과.
- 최초 Compose 검사에서 root 상태 점검의 `.erlang.cookie` 소유권 경합을 발견했습니다. `su-exec rabbitmq`로
  수정하고 회귀 테스트를 추가한 뒤 **새 볼륨 기동부터 전체 Compose 검사를 다시 실행해 통과**했습니다.
- 격리 프로젝트 `govbiz-verify-rabbit-20260912`: quorum 주 큐/DLQ, 소비자 1개 연결, RabbitMQ 중단 중 카탈로그 200,
  같은 볼륨으로 RabbitMQ 재생성 후 Core 재시작 없는 소비자 재연결을 확인했습니다. 기존 Redis 복원·Qdrant/AI 장애 복구도 통과했습니다.
- 실제 유료 OpenAI·공고 API·SMTP 호출은 하지 않았고, 검증용 컨테이너·볼륨은 검증 스크립트가 정리했습니다.
  기존 `govbiz` 개발 스택·데이터·`.env`는 변경하지 않았습니다. 실제 개발 DB의 `V23` 적용은 이후 백엔드 배포 단계입니다.
- Frontend와 AI Service 코드는 바꾸지 않았으므로 해당 서비스의 전체 단위 테스트는 재실행하지 않았습니다.
  Compose에서는 이미지를 빌드하고 AI 스텁을 이용한 기존 서비스 연결 계약을 확인했습니다.

## 참고한 공식 문서

- [RabbitMQ 릴리스](https://www.rabbitmq.com/release-information)
- [Publisher confirms와 consumer acknowledgements](https://www.rabbitmq.com/docs/confirms)
- [Quorum queue·poison message·dead lettering](https://www.rabbitmq.com/docs/quorum-queues)
- [RabbitMQ 신뢰성·중복 전달](https://www.rabbitmq.com/docs/reliability)
- [Spring AMQP RabbitTemplate의 confirm/return](https://docs.spring.io/spring-amqp/reference/amqp/template.html)
- [Spring AMQP transaction 경계](https://docs.spring.io/spring-amqp/reference/amqp/transactions.html)
