# RabbitMQ 적용: 정기 리포트 메일 발송

## 목적과 범위

기존 정기 스케줄러는 READY 리포트마다 SMTP 응답을 순서대로 기다렸다. 이제 발송 큐를 켜면
스케줄러는 발송 대기만 저장하고 Core 내부의 별도 소비자가 저장된 리포트를 전송한다.
느린 SMTP가 다음 계정의 생성·발송 예약을 막지 않게 하는 변경이며, SMTP 자체 속도나 도달률 개선을 보장하지 않는다.

- 적용: 정기 리포트의 **완성된 결과 이메일 전송**. 생성 큐와 소비자가 분리된다.
- 유지: 기존 리포트 내용·수신 확인·동의·해지·발송 상태·토큰 해시·SMTP Client.
- 미적용: 주소 확인 메일, 비밀번호 재설정 메일, 수동 미리보기, 실시간 검색, 카탈로그 수집·색인.
- 새 의존성·서버·메일 공급자·범용 큐 프레임워크는 추가하지 않는다.
- 큐 비활성 시 스케줄러의 기존 직접 SMTP 경로를 유지한다. 브로커 장애 시 자동으로 직접 발송하지는 않는다.

## 실제 흐름

1. 기존 `DailyReportScheduler`가 서울 발송 시각·구독 조건·계정별 배치 상한을 확인한다.
2. READY 리포트의 `DailyReportRepository.enqueueDelivery`를 호출한다. SQL이 발송 자격을 다시 검사하고 대기를 한 번 저장한다.
3. `DailyReportDeliveryOutboxScheduler`가 5초마다 최대 20건을 조회하고, 다음 발행 시각을 먼저 1분 뒤로 예약한다.
4. `DailyReportDeliveryQueueClient`가 `v1:<reportId>`만 persistent 메시지로 전달하고 publisher confirm·mandatory return을 확인한다.
5. `DailyReportDeliveryConsumer → DailyReportService.deliverQueued → deliver`가 DB 발송권을 조건부 선점한다.
6. 현재 계정·수신 주소·동의·기업 상태를 다시 확인하고 기존 `DailyReportMailClient → SMTP`를 호출한다.
7. DB에 SENT/UNKNOWN/SKIPPED를 저장하고 ACK한다. 결과 저장 실패는 재큐잉 없이 DLQ로 격리한다.

생성 완료 직후 바로 발송 큐에 넣지는 않는다. 다음 정기 주기(5분)에 예약하며, 큐 대기와 SMTP 지연이 추가될 수 있다.
이미 큐에 예약된 계정은 다음 배치 조회에서 제외하므로 앞 계정들의 발송 대기가 뒤 계정 예약을 계속 막지 않는다.
모든 RabbitMQ·SMTP 호출은 DB transaction 밖에서 수행한다.

## 예약 스케줄러 격리

기존에는 기업마당·K-Startup·충남 공고 수집과 `DailyReportScheduler`가 기본 `taskScheduler`의
단일 스레드를 공유했다. 발송 소비자를 큐로 분리해도 긴 공고 수집 중에는 리포트 예약 자체가 대기할 수 있었다.

- `DailyReportConfig`에서 `dailyReportTaskScheduler`를 만들고 `DailyReportScheduler`에 명시적으로 지정한다.
- 전용 스레드 1개(`daily-report-schedule-` 접두사)를 사용한다. 시작 지연 1분과 **이전 실행 완료 후 5분** 간격은 유지한다.
- `DAILY_REPORT_ENABLED=true`일 때만 생성한다. 큐만 켜고 정기 예약을 끈 환경에서는 생성하지 않는다.
- 발송 큐 on/off와 무관하게 예약 스케줄러를 분리한다. 발송 큐 off에서는 기존 직접 SMTP가 이 전용 스레드에서 실행된다.
- 생성·발송 Outbox 게시 스케줄러와 RabbitMQ 소비자의 별도 실행 경로는 변경하지 않는다.

이는 실행 스레드 대기 원인의 격리다. 같은 DB·AI 자원의 경합, 리포트 배치 자체의 처리 시간이나
발송 큐 off에서 다음 계정이 SMTP를 기다리는 동작까지 제거하지 않는다. 다중 서버의 예약 중복은 기존 DB 제약으로 처리하며,
새 분산 락·큐·스키마·환경변수는 추가하지 않는다.

`DailyReportPropertiesTest`에서 비활성 시 Bean 부재, 발송 큐 on/off의 단일 스레드 및 실행 간격,
공고 수집 스레드를 막은 동안 리포트용 스레드가 실행되는 것을 검증한다. 기존 `DailyReportSchedulerTest`는
시간·일일 예산·자정 경계·직접 SMTP/발송 큐 분기 검증을 유지한다. 외부 메일·유료 AI는 호출하지 않는다.

2026-09-13 격리 보완 검증: 관련 테스트 14건 및 JDK 21 `./gradlew clean build --no-daemon`의
전체 1,290건(실패·오류·건너뜀 0, 18분 50초)이 통과했다. 기존 개발 컨테이너 재배포는 포함하지 않는다.

## 저장 구조와 상태

[V27](../backend/core-service/src/main/resources/db/migration/V27__add_daily_report_delivery_outbox.sql)은 기존 `daily_report`에
다음 nullable 컬럼과 CHECK·발행 조회 인덱스만 추가한다. 기존 migration·데이터는 수정·삭제하지 않는다.
리포트 한 건당 발송권이 하나이므로 별도 발송 작업 테이블이나 중복된 상태 모델을 만들지 않는다.

| 컬럼 | 역할 |
|---|---|
| `delivery_queued_at` | 발송 큐 예약 시각. NULL이면 구형 직접 발송 또는 아직 예약하지 않은 리포트 |
| `delivery_deadline_at` | 예약 후 1시간과 다음 서울 자정 중 이른 시각 |
| `delivery_next_publish_at` | 다음 발행 가능 시각. 발행 전에 조건부 UPDATE로 예약 |
| `delivery_last_published_at` | 브로커 수락·라우팅 확인 시각. 메일 발송 완료 표시가 아님 |

| 기존 `delivery_status` | 의미·처리 |
|---|---|
| `NOT_REQUESTED` | 아직 SMTP 선점 전. `delivery_queued_at`이 있으면 큐 대기이며 관리자 집계에서 QUEUED로 표시 |
| `SENDING` | DB 발송권 선점. 중복 메시지는 SMTP를 다시 호출하지 않음 |
| `SENT` | SMTP 접수 및 DB 기록 완료. 받은 편지함 도착 보장이 아님 |
| `UNKNOWN` | SMTP 응답 불명 또는 SENDING 20분 초과. 자동 재발송·재예약 차단 |
| `SKIPPED` | 실행 전 동의·계정·주소·기업 조건 변경, 대기 만료 또는 날짜 경과 |

공개 리포트 응답의 상태 enum은 바꾸지 않았다. 화면의 NOT_REQUESTED는 '미발송 (예약 전 또는 대기 중)'으로 표시하고,
정기 예약이 꺼져 있어도 기존 예약 메일은 처리될 수 있다고 안내한다.
신규 발송 상태 조회 화면이나 재발송 버튼은 추가하지 않았다.

## 중복·장애·보안 경계

- 예약은 `delivery_queued_at IS NULL` 조건으로, 발송은 `NOT_REQUESTED → SENDING` 조건으로 한 번만 획득한다.
- 브로커 중단·응답 유실·라우팅 실패 시 DB 대기가 남는다. 기한 안의 미선점 리포트만 다시 발행한다.
- 재전달은 가능하지만 DB 선점이 중복 SMTP 호출을 막는다. 이것이 SMTP exactly-once 도착 보장은 아니다.
- SMTP가 접수한 뒤 연결이 끊길 수 있으므로 예외를 무조건 재시도하지 않는다. UNKNOWN은 운영자 확인이 필요하다.
- SMTP 성공 뒤 DB 저장이 실패하면 SENDING과 DLQ가 남고, 만료 검사에서 UNKNOWN이 된다. 재전달·직접 경로 모두 재발송하지 않는다.
- 큐 대기가 만료되거나 계정·구독이 부적격이 되면 SKIPPED로 종료한다. 늦게 도착한 메시지는 발송권을 얻지 못한다.
- SMTP 미설정 상태에서는 발송권을 선점하지 않는다. DB 대기를 유지하고 기한 안에서 다시 전달한다.
- 선점과 외부 SMTP 사이에 구독 상태가 바뀌는 아주 짧은 경합을 원자적으로 없앨 수는 없다. 발송 직전 재검사하며 이미 전송한 메일을 회수하지 못한다.
- 메시지에는 이메일·기업 정보·본문·API 키·해지 원문 토큰이 없다. 해지 토큰은 실행 중 메모리에서 만들고 DB에는 해시만 저장한다.
- 주 큐/DLQ는 `govbiz.daily-report.delivery.v1` / `govbiz.daily-report.delivery.dead.v1`이다.
  durable quorum·single-active-consumer·동시 소비 1·prefetch 1·수동 ACK, 각 최대 1,000건/reject-publish를 사용한다.
  주 큐 TTL은 1시간, delivery limit은 3, dead-letter 전략은 at-least-once다. 기존 큐 정의는 변경하지 않는다.
- 단일 RabbitMQ 노드·Core 프로세스 내부 소비자이므로 운영 고가용성이나 별도 Worker 장애 격리는 아니다.

## 설정과 전환

| 설정 | 기본값 | 영향 |
|---|---|---|
| `DAILY_REPORT_DELIVERY_QUEUE_ENABLED` | 직접 Core false / Compose true | 발송 Outbox·소비자 사용. false면 정기 스케줄러가 기존 직접 SMTP 경로 사용 |
| `DAILY_REPORT_ENABLED` | false | 새 정기 생성·발송 예약. **이미 큐에 예약된 발송을 중지하는 스위치는 아님** |
| `DAILY_REPORT_QUEUE_ENABLED` | 직접 Core false / Compose true | 기존 AI 생성 큐. 정기 스케줄러 사용 시 true 필수 |
| `DAILY_REPORT_MAIL_ENABLED` | false | 기존 주소 확인 및 리포트 SMTP 전송 허용. SMTP 연결·발신자 설정도 필요 |
| `DAILY_REPORT_SEND_HOUR` | 8 | 서울 기준 발송 가능 시작 시각. 소비자도 확인 |

큐를 켜는 것만으로 새 리포트를 생성하거나 수신 동의를 만들지는 않는다. 그러나 **기존 발송 대기와 SMTP 설정이 있으면
정기 예약 스위치가 false여도 소비자가 메일을 보낼 수 있다.** 완전히 발송을 중지하려면 정기 예약·메일·발송 큐 스위치를
확인하고 실행 중 SENDING도 점검한다. 이미 외부에 전송한 SMTP 요청은 설정 변경으로 취소되지 않는다.

발송 큐를 false로 전환하면 기존 정기 스케줄러가 기한 내 미선점 대기도 직접 처리할 수 있다. DB 선점은 동일하다.
UNKNOWN·SENDING을 임의로 NOT_REQUESTED로 되돌리거나 큐/볼륨을 삭제하지 않는다.
기존 개발 환경의 자동 발송·메일 설정은 작업 중 임의로 활성화하지 않는다.

적용 전 기존 설정·대기 발송을 확인하고, 백업 후 Core 재빌드·재기동으로 Flyway V27을 적용한다.
기존 MySQL/RabbitMQ 볼륨을 초기화할 필요는 없다. 평가 capture/export 프로필은 발송 큐도 명시적으로 끈다.

## 관리자 조회

기존 관리자 전용 `GET /api/v1/admin/queues`에 `daily-report-delivery` 항목을 추가한다.
DB 집계는 `delivery_queued_at IS NOT NULL`만 포함해 기존 직접 발송 이력과 구분한다.
대기 상태는 QUEUED, 그 외는 SENDING/SENT/UNKNOWN/SKIPPED를 그대로 표시한다.
SENDING의 oldestAt은 발송 선점 시각, 나머지는 큐 예약 시각이다. 전체 보관 이력 집계이지 최근 실패율이 아니다.
미확인 발행 건수는 대기 중 `delivery_last_published_at IS NULL`인 수이며 브로커 장애 확정 건수가 아니다.
브로커 readyMessages는 미확인 ACK 작업을 제외한다. 이 API는 메시지 삭제·소비·재발행을 하지 않는다.

## 검증 방법

- `DailyReportDeliveryQueueIntegrationTest`: 실제 MySQL 8.4/RabbitMQ, SMTP·AI 스텁.
  중복 예약·동시 선점·rollback·CHECK·ID-only 메시지·브로커 복구·라우팅 실패·수신 자격 변경·UNKNOWN·DLQ·큐 off 경로를 확인한다.
- 기존 리포트 Service/Scheduler/Repository와 관리자 조회 회귀 테스트를 함께 실행한다.
- Core 전체: JDK 21에서 `./gradlew clean build --no-daemon`.
- 인프라: `python -B -m unittest discover -s infrastructure/scripts -p 'test_*.py'`.
- 격리 Compose: `./infrastructure/scripts/verify-compose.sh`. 네 주 큐/DLQ와 소비자 재연결을 검사하고 실제 메일은 강제로 끈다.

실제 SMTP 도달률·처리량·리포트 추천 품질은 위 스텁 검증의 범위가 아니다.

### 최종 검증 기록 (2026-09-13)

- JDK 21 `./gradlew clean build --no-daemon`: **1,280건**, 실패·오류·건너뜀 0. 신규 발송 큐 MySQL/RabbitMQ 통합 9건 포함.
- Node 24 / pnpm 11.22 `pnpm test --maxWorkers=2`: **1,102건, 91개 파일** 통과. `pnpm lint`, `pnpm build` 통과.
  Core와 병렬 실행할 때 일부 기존 화면 테스트가 시간 초과해 해당 실행을 중단하고, 제한 시간을 늘리지 않은 채 Core 종료 후 전체를 단독 재검증했다.
  build의 기존 큰 번들 경고는 남아 있으며 이번 발송 큐 작업의 범위 밖이다.
- 인프라 unittest: **25건** 통과. 개발자 설정과 무관하게 메일을 끄고 발송 큐 검증을 켜는지 확인했다.
- `govbiz-verify-delivery-20260913` 격리 Compose: 이미지 빌드, 네 quorum 주 큐/DLQ·소비자 연결,
  브로커 중단 중 MySQL 조회 유지, 동일 볼륨의 브로커 재생성 후 Core 재시작 없는 네 소비자 재연결 통과.
  기존 네 제공처 fixture·신청 문서 입력·하이브리드 검색·Elasticsearch/Redis/Qdrant/AI 장애 복구 검증도 통과했다.
- 실제 OpenAI·공식 제공처 API·외부 SMTP는 사용하지 않았다. 검증용 컨테이너·볼륨·네트워크만 정리하며,
  기존 개발 Core/DB에는 V27을 적용하거나 자동 발송을 활성화하지 않았다.
- 문서의 로컬 링크 및 `git diff --check` 확인.

설계 근거: 중복 전달을 고려한 소비자와 발행 확인은 [RabbitMQ 신뢰성 안내](https://www.rabbitmq.com/docs/reliability),
confirm/return 확인은 [Spring AMQP 공식 문서](https://docs.spring.io/spring-amqp/reference/amqp/template.html)를 참고했다.
