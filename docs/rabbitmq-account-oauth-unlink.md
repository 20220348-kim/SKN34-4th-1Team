# RabbitMQ 카카오 탈퇴 연결 해제

## 적용 이유와 정책

기존 `AccountOAuthService`의 AFTER_COMMIT 호출은 실패를 로그로만 남겼다. 탈퇴 커밋 뒤 프로세스가 종료되면
연결 해제가 누락될 수 있었다. 반대로 단순 재시도 큐를 붙이면 재가입한 카카오 계정의 새 연결을 이전 작업이 끊을 수 있다.

따라서 **탈퇴와 작업 저장을 한 DB transaction으로 묶고, 연결 해제 성공을 확인하기 전까지 같은 카카오 계정의
재가입을 차단한다.** 응답 유실·시간 초과는 성공도 실패도 추정하지 않는다. 운영자 확인이 필요할 수 있다.
이는 서비스의 같은 `(KAKAO, subject)` 로그인·재가입 정책이다. 카카오 자체 로그인·동의 화면 접근을 막는 기능은 아니다.
다른 카카오 계정, Google, 이메일 가입을 일괄 차단하지 않는다.

새 라이브러리·별도 워커 서버 없이 기존 Core·MySQL·RabbitMQ를 사용한다. 검색·AI 점수화 경로에는 영향이 없다.

## 호출 흐름과 transaction

```text
DELETE /api/v1/me
  → AccountProfileService [DB transaction]
      → 기업·모집·제안·세션 정리 및 계정 삭제 표시
      → AccountOAuthUnlinkRepository → MyBatis → V28 작업 저장
      → Google identity 삭제 / Kakao identity 유지
      → AccountDeletedEvent → 대화 기록 정리 (같은 transaction)
  → 204: 로컬 탈퇴 완료. 외부 연결 해제 완료를 의미하지 않음

AccountOAuthUnlinkScheduler (전용 스레드, 최초 5초 / 완료 후 5초)
  ├─ queue-enabled=true: DB 발행 예약 → QueueClient → RabbitMQ → Consumer
  └─ queue-enabled=false: DB 작업을 직접 Service로 전달
      → AccountOAuthUnlinkService
          → Repository.claim [짧은 DB transaction: QUEUED → RUNNING]
          → KakaoOAuthClient.unlink [DB transaction 밖]
          → Repository.succeed [성공 상태 + 이전 identity 삭제를 한 transaction]
```

탈퇴 실패 시 작업도 rollback된다. 작업 저장 실패 시 탈퇴도 rollback되므로 유실된 작업을 정상 탈퇴로 숨기지 않는다.
기존 `AccountDeletedEvent`는 대화 기록 등 로컬 정리를 위해 유지하고, 공급자 식별자나 외부 HTTP 호출을 담지 않는다.

## 저장 구조와 재가입 충돌 방지

- `V28__create_account_oauth_unlink_job.sql`은 새 테이블만 추가한다. 기존 migration·기존 계정은 변경하지 않는다.
- 필드: 작업 ID, 이전 account ID, provider·subject, 상태·안정적인 실패 코드, 생성·시작·완료 시각, 다음 발행·발행 확인 시각.
- `(account_id, provider, subject)` UNIQUE로 같은 탈퇴를 중복 등록해도 상태를 초기화하지 않는다.
- 원래 `account_oauth_identity`의 `(provider, subject)` UNIQUE가 재가입을 DB 수준에서 차단한다.
  삭제된 계정은 로그인 계정 조회에서 제외되므로 남아 있는 identity로 이전 계정에 로그인할 수도 없다.
- OAuth callback의 사전 조회와 UNIQUE 충돌 후 재조회에서 `oauthError=unlink-pending`을 반환한다.
  Frontend는 잠시 후 재시도·지속 시 관리자 문의 안내를 보여 준다. 공급자 코드 교환 자체가 실패하면 기존 `failed` 안내다.
- 성공 시 정확히 **이전 account ID + KAKAO + subject**에 해당하는 identity만 삭제한다. 삭제 실패 시 성공 상태도 rollback한다.
- 이후 재가입은 새 account ID로 가능하다. 완료된 이전 작업 ID는 다시 선점되지 않아 새 계정의 연결을 건드리지 않는다.
- DB 작업에는 공급자 식별자만 최소 보관하며 이메일·토큰·인가 코드·어드민 키는 넣지 않는다. 식별자는 개인정보로 취급하고
  DB 접근·백업 권한을 제한한다. 완료 작업의 자동 보존 기간/삭제 정책은 아직 없으며 운영 정책 확정이 필요하다.

## 상태와 실패 처리

| 상태 | 의미 | 자동 HTTP 재시도 | 재가입 |
|---|---|---|---|
| `QUEUED` | 아직 외부 호출을 선점하지 않음. 브로커 장애에도 MySQL에 남음 | 발행/선점 전 전달만 재시도 | 차단 |
| `RUNNING` | 워커가 실행권을 선점함 | 중복 메시지는 실행하지 않음 | 차단 |
| `SUCCEEDED` | 요청한 subject와 같은 숫자 `id`의 성공 응답 및 DB 반영 완료 | 없음 | 허용 |
| `FAILED` | 어드민 키 미설정으로 HTTP 호출하지 않음 (`NOT_CONFIGURED`) | 없음 | 차단, 설정·운영 확인 필요 |
| `UNKNOWN` | HTTP 오류·시간 초과·응답 검증 실패, 또는 5분 이상 RUNNING | 없음 | 운영 확인 전까지 차단 |

성공 응답의 `id` 검증은 [카카오 공식 연결 해제 계약](https://developers.kakao.com/docs/ko/kakaologin/rest-api#unlink)을 따른다.
비어 있는 본문·다른 ID·문자열 ID는 성공으로 인정하지 않는다. 특정 HTTP 오류를 임의로 '이미 해제됨'으로 취급하지 않는다.

외부 호출 성공 뒤 DB가 실패하면 RUNNING으로 남고 메시지는 DLQ로 간다. 다음 정상 스캔에서 시작 후 5분이 지난
RUNNING을 UNKNOWN으로 바꾼다. 외부 작업과 DB를 하나의 transaction으로 묶을 수 없으므로 exactly-once 완료를 보장하지 않는다.
만료 후 늦게 도착한 성공 응답도 UNKNOWN을 자동 덮어쓰거나 identity를 해제하지 않는다.

## RabbitMQ 전달 설정

- 주 큐·exchange: `govbiz.account.oauth-unlink.v1`
- DLQ·dead exchange: `govbiz.account.oauth-unlink.dead.v1`
- 본문은 `v1:<양수 작업 ID>` ASCII 최대 32바이트. provider subject·키는 메시지에 없다.
- persistent 메시지, publisher confirm 3초와 mandatory return 확인. 예약 후 유실도 다음 1분 이후 재발행한다.
- 한 번의 스캔 최대 20건. 주 큐/DLQ durable quorum, 최대 1,000건, reject-publish.
- 주 큐 single-active-consumer, consumer 1개, prefetch 1, manual ACK, TTL 1시간, delivery-limit 3,
  at-least-once dead lettering. TTL은 브로커 메시지 만료이며 DB 작업 삭제가 아니다.
- 성공·FAILED·UNKNOWN을 DB에 기록했거나 이미 선점/완료된 메시지는 ACK. 잘못된 본문과 결과 저장 오류는 reject(no requeue) → DLQ.
- 동일 메시지가 여러 번 전달될 수 있다. DB `QUEUED → RUNNING` 조건부 갱신으로 실행권을 하나만 부여한다.

## 설정과 모드 전환

| 환경변수 | 직접 Core 기본 / Compose 기본 | 의미 |
|---|---|---|
| `ACCOUNT_OAUTH_UNLINK_ENABLED` | `true` / `true` | 스캔·소비자 실행. false여도 탈퇴 시 작업 저장·재가입 차단은 유지 |
| `ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED` | `false` / `true` | true는 RabbitMQ, false는 전용 스케줄러 직접 실행 |
| `ACCOUNT_OAUTH_KAKAO_ADMIN_KEY` | 빈 값 / 빈 값 | 외부 호출 인증. 없으면 FAILED로 기록 |

큐를 끄는 것은 작업 처리를 끄는 것이 아니다. 연결 해제 전체를 멈추려면 `ENABLED=false`로 **모든 Core 인스턴스**를
갱신한다. 기존 실행 중 요청까지 취소하는 기능은 아니다. 큐 모드에서 브로커가 고장 나도 직접 실행으로 우회하지 않는다.
직접 모드 또한 기존처럼 탈퇴 응답에서 기다리지 않고 백그라운드 실행한다. 다른 동기화와 전용 스케줄러를 분리했다.
평가용 capture/export profile은 두 설정을 false로 고정한다.

V28 및 최신 Core·Frontend를 함께 적용한다. 이전 Core의 AFTER_COMMIT 동작과 혼재되지 않도록 구버전 인스턴스를 모두
종료한 뒤 전환한다. 과거 이미 삭제된 identity는 복원하지 않으므로 과거 실패 건까지 소급 복구하는 기능은 아니다.

## 운영 확인과 수동 복구 원칙

`GET /api/v1/admin/queues`의 `account-oauth-unlink`에서 상태별 작업 수·가장 오래된 시각·발행 미확인 수와
주 큐/DLQ 관측치를 확인한다. 관리자 권한이 필요하고 읽기 전용이며 subject·키는 반환하지 않는다.
`enabled`는 이 기능의 **RabbitMQ 모드 활성 여부**다. false여도 직접 모드가 실행 중일 수 있다.
직접 모드에서는 발행 확인 시각이 없으므로 '발행 미확인'을 브로커 장애로 해석하면 안 된다.

1. `QUEUED` 증가: worker 설정, 어드민 키 설정 여부, DB·브로커 연결, 큐 binding·소비자 상태를 확인한다.
2. `FAILED/NOT_CONFIGURED`: 키를 안전하게 설정한다. 자동 재실행하지 않는다. 운영 기록에 대상 작업 ID와 원인을 남기고,
   워커를 정지한 상태에서 **실제 외부 호출이 없었던 해당 FAILED 작업**임을 확인한 뒤 제한적으로 QUEUED 재예약할 수 있다.
3. `UNKNOWN`: 모든 실행 인스턴스와 진행 중 요청이 정리됐는지 확인하고, 이전 계정·subject와 카카오 측 해제 결과를
   별도 확인한다. 앱 로그인 재시도 중 새 동의가 생겼을 가능성도 확인한다. 불확실하면 차단을 유지한다.
4. 카카오 해제 완료가 확정된 경우에만 운영 변경 기록·근거를 남기고, 정확한 작업 및 이전 identity를 잠근 짧은 DB
   transaction에서 상태 확정과 identity 해제를 함께 처리한다. 영향받는 행을 확인하고 예상과 다르면 rollback한다.
   단순히 작업만 성공 표시하거나 identity만 삭제하지 않는다.

일괄 UNKNOWN→QUEUED, DLQ 전체 재발행, 차단 identity 무조건 삭제는 금지한다. 이전 요청이 새 연결을 끊을 수 있다.
현재 자동 재시도/강제 해제 API·운영자 복구 UI·외부 결과 자동 조회·알림은 없다. DB 수동 조치는 승인·기록을 전제로 한다.

## 검증 범위

`AccountOAuthUnlinkQueueIntegrationTest`는 실제 MySQL 8.4·RabbitMQ에서 탈퇴 rollback, provider 격리, 재가입 UNIQUE,
동시 선점, 큐 off 직접 처리, 중복/오래된 메시지, UNKNOWN, DB 결과 저장 실패, 브로커 장애·라우팅 복구·DLQ를 검증한다.
카카오 Client는 대역이다. HTTP 성공 응답 검증은 `KakaoOAuthClientTest`, 로그인 화면 계약은 OAuth API/Frontend 테스트가 담당한다.
격리 Compose 검증은 새 주 큐/DLQ·소비자와 브로커 재시작 복구를 확인하며 카카오 자격증명을 비운다.
실제 카카오 연결 해제·실계정 재가입 검증은 별도 승인이 필요하다.

### 최종 실행 결과 (2026-09-13)

| 검증 | 결과 |
|---|---|
| JDK 21, `JAVA_TOOL_OPTIONS='-Dspring.test.context.cache.maxSize=4' ./gradlew clean build --no-daemon` | 142개 suite·1,305건 통과, 실패·오류·건너뜀 0. 17분 3초 |
| 새 큐 통합 / 모드 설정 | 실제 MySQL 8.4·RabbitMQ 10건 / 큐 on·off·전체 중지 설정 3건 통과. Core 전체에 포함 |
| Frontend, Node 24·pnpm 11.22, `pnpm test --maxWorkers=2` | 전체 91개 파일·1,103건 통과 |
| `pnpm lint`, `pnpm build` | 통과. 기존 500 kB 초과 번들 경고는 남음 |
| 인프라 `python -B -m unittest discover -s infrastructure/scripts -p 'test_*.py'` | 25건 통과 |
| 격리 Compose `govbiz-verify-unlink-20260913-1559` | 새 큐 포함 다섯 기능의 quorum 큐·DLQ·소비자, 브로커 재생성 후 재연결 및 기존 서비스 장애/복구 검증 통과 |
| 문서 상대 링크·`git diff --check` | 통과 |

Frontend의 최초 기본 병렬 실행에서는 기존 검색 화면 테스트 2건이 5초 제한을 넘겼고 후속 1건의 상태 검증도 실패했다.
테스트 코드·시간 제한은 바꾸지 않고 동시 worker만 2개로 제한한 **전체 재실행**이 통과했다.
기본 병렬 설정의 안정성을 해결했다고 주장하지 않는다.

실제 카카오·유료 OpenAI·SMTP 호출은 하지 않았다. 기존 `govbiz` 개발 컨테이너의 재시작이나 V28 운영 적용도 하지 않았다.
