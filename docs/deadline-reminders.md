# 관심 공고 마감 알림

관심 공고함에 담은 공고의 신청 마감 7일·3일·1일 전에 이메일과 앱 알림을 한 번씩 보냅니다. 알림 시점은 고르지 않습니다.
웹 `내 프로필 → 계정과 알림`과 모바일 `전체 → 알림 설정`이 같은 서버 설정을 읽고 저장합니다.
웹은 보내는 시점·지금 켤 수 없는 이유·서버 발송 꺼짐 안내를 제목 옆 `?` 도움말에 두고, 수신 주소 확인 링크만 줄 아래에 남깁니다.
파트너 제안·새 공고 알림은 보내는 기능이 없어 스위치 없이 `준비 중`으로만 표시합니다.

## 실행 흐름

- 설정: `NotificationSettingsController → NotificationSettingsService → NotificationSettingsRepository → MyBatis Mapper → XML → MySQL`
- 예약·선점·결과: `DeadlineReminderScheduler → DeadlineReminderService → DeadlineReminderRepository → MyBatis Mapper → XML → MySQL`
- 이메일: `DeadlineReminderService → DailyReportMailClient → SMTP` (맞춤 리포트와 같은 발송 경계·발신 주소)
- 앱 알림: `DeadlineReminderService → DailyReportPushClient → Expo Push Service → FCM/APNs` (같은 기기 등록·세션 경계)

스케줄러는 `DEADLINE_REMINDER_ENABLED=true`일 때만 만들어지며 전용 단일 스레드에서 이전 실행이 끝난 뒤 1분 간격으로 돕니다.
매 실행은 만료 정리 → (서울 기준 발송 시각 이후) 오늘 예약 → 채널별 선점·발송 순서입니다.
새 RabbitMQ 큐는 추가하지 않았습니다. 발송 기록 행이 대기열 역할을 하고, 채널마다 `PENDING → SENDING` 조건부 UPDATE로
한 프로세스만 발송권을 얻습니다. 메일·푸시 호출은 DB transaction 밖에서 합니다.

## 저장 구조 (V50·V52)

| 테이블 | 역할 |
|---|---|
| `account_notification_setting` | 계정별 마감 알림 켜기, 이메일·앱 알림 선택, 이메일을 처음 고른 시각. V50의 `deadline_reminder_days_before`는 V52부터 읽지 않음(값은 남겨 둠) |
| `deadline_reminder` | 발송 기록. V52 고유 키 `(account_id, source_code, source_program_id, kind, due_date, days_before)`로 마감일·일수마다 한 번만 예약 |

`due_date`는 예약할 때의 공고 신청 마감일이고 `days_before`는 그때 남은 일수(7·3·1)입니다. 마감일이 바뀐 공고는 새 마감일 기준의
별도 알림이 될 수 있고, 같은 마감일의 같은 일수 알림은 다시 보내지 않습니다. V52 전에 남은 발송 기록은 그대로 두며 새 키와 충돌하지 않습니다.
접수 상태는 저장하지 않고 발송 직전에 서울 날짜로 다시 계산합니다.
켜진 설정에 채널이 없거나, 동의 시각 없이 이메일을 고른 행은 DB CHECK가 거부합니다.

## 예약·발송 조건

- 예약: 활성 계정, 마감 알림 켜짐, 관심 공고함의 노출 중인 공고, 신청 마감일이 정확히 오늘(서울)+7일·3일·1일 중 하나.
  일수 목록은 `DeadlineReminderSetting.REMINDER_DAYS_BEFORE` 한 곳에 있고, 서버가 그날 실행되지 않으면 지나간 D-N 알림을 뒤늦게 보내지 않습니다.
  마감 5일 전에 담은 공고는 3일·1일 전 알림만 받습니다.
- 공통 재확인: 계정 정지·탈퇴, 설정·채널 해제, 관심 공고함에서 뺌·비노출, 마감(CLOSED), 마감일 변경이면 보내지 않습니다.
- 이메일: 리포트 메일 발송 설정(`DAILY_REPORT_MAIL_ENABLED`·SMTP)과 리포트 화면의 수신 주소 확인이 필요하며,
  확인한 주소가 지금 계정 이메일과 같아야 합니다. 가입 인증이나 개발 시드의 인증 표시는 수신 확인으로 보지 않습니다.
- 앱 알림: `DAILY_REPORT_PUSH_ENABLED`와 이 기기 앱 알림을 켠 유효한 모바일 세션의 기기가 필요합니다.
  Android 채널은 `deadline-reminders`이며, 알림을 누르면 앱이 공고 식별자로 공고 상세를 엽니다. 임의 URL은 열지 않습니다.
- 메시지: 공고 제목, 마감일(D-N), 공고 상세 링크만 담습니다. 이메일 끝에는 로그인 후 바꿀 수 있는 설정 화면 주소를 적습니다.

## 상태와 오류 코드

| 채널 상태 | 의미 |
|---|---|
| `NOT_REQUESTED` | 예약 당시 그 채널을 고르지 않음 |
| `PENDING` → `SENDING` | 발송 대기 → 발송권 선점 |
| `SENT` | SMTP 접수 또는 Expo가 한 기기 이상 접수. 받은 편지함·기기 표시를 보장하지 않음 |
| `FAILED` | 발송하지 않았거나 Expo가 거절. 예: `CheckFailed`, `DeviceNotRegistered`, `PushRejected` |
| `UNKNOWN` | 결과를 확인하지 못함(`SendUnconfirmed`) 또는 20분 넘게 `SENDING`(`Expired`). 자동 재발송하지 않음 |
| `SKIPPED` | `AccountInactive`, `ReminderDisabled`, `ProgramUnavailable`, `ProgramClosed`, `DeadlineChanged`, `EmailNotConfirmed`, `MailUnavailable`, `PushUnavailable`, `NoActiveDevice`, 지난 날짜(`Expired`) |

Expo가 `DeviceNotRegistered`를 돌려준 기기 토큰은 다음 알림부터 쓰지 않습니다. 오류 칸에는 외부 원문 대신 안정적인 코드만 남깁니다.

## API

| 메서드·경로 | 동작 |
|---|---|
| `GET /api/v1/me/notification-settings` | 본인 설정과 `emailConfirmed`, `emailDeliveryAvailable`, `pushDeliveryAvailable`, `pushDeviceRegistered`, `schedulerEnabled`, `sendHour`, `reminderDaysBefore`(`[7,3,1]`). no-store |
| `PUT /api/v1/me/notification-settings` | `{"deadlineReminder":{"enabled":true,"email":true,"push":false}}` 전체 저장. 같은 응답 반환. 예전 클라이언트가 보낸 `daysBefore`는 무시 |

로그인 회원 본인만 쓸 수 있고, 쿠키가 붙은 PUT은 기존 Origin 검사를 거칩니다. 모바일은 Bearer 세션을 씁니다.
필드가 빠지거나 채널 없이 켜면 400 `REQUEST_VALIDATION_FAILED`, 이메일을 켤 때 수신 주소 미확인이면
409 `EMAIL_CONFIRMATION_REQUIRED`, 메일·앱 알림 발송 미설정이면 503 `EMAIL_DELIVERY_UNAVAILABLE`·`PUSH_DELIVERY_UNAVAILABLE`입니다.
끄기와 채널 해제는 발송 설정과 관계없이 저장합니다. 앱 알림은 기기를 등록하기 전에도 미리 고를 수 있습니다.

## 설정

| 설정 | 기본값 | 의미 |
|---|---|---|
| `DEADLINE_REMINDER_ENABLED` | `false` | 마감 알림 예약·발송 스케줄러 |
| `DEADLINE_REMINDER_SEND_HOUR` | `9` | 서울 기준 예약·발송 시작 시각(0~23) |
| `DEADLINE_REMINDER_MAX_PER_RUN` | `50` | 한 번 실행에서 발송을 시도하는 알림 상한(1~500). 남은 알림은 다음 실행에서 처리 |

메일은 `DAILY_REPORT_MAIL_ENABLED`, `DAILY_REPORT_FROM`, `DAILY_REPORT_FRONTEND_BASE_URL`, `SMTP_*`를,
앱 알림은 `DAILY_REPORT_PUSH_ENABLED`, `DAILY_REPORT_PUSH_ACCESS_TOKEN`을 그대로 씁니다. 평가 capture/export 프로필은 스케줄러를 끕니다.
스케줄러를 켜면 조건을 충족한 모든 계정에 실제 메일·푸시가 나가므로 발신 설정과 대상 범위를 먼저 확인하세요.

## 검증

- Core 단위·HTTP 계약: `DeadlineReminderServiceTest`, `NotificationSettingsServiceTest`, `NotificationSettingsControllerTest`,
  `DeadlineReminderPropertiesTest`, 리포트 메일·푸시 Client 테스트(메시지 내용·헤더 주입·Expo 응답 변환).
- MySQL 8.4 Testcontainers: `DeadlineReminderRepositoryIntegrationTest` — UPSERT·동의 시각·CHECK·rollback, 7·3·1일 전 예약 범위와 고유 키,
  복합 식별자·한글·특수문자, 선점·만료, 기기 목록과 세션 만료·토큰 비활성화.
- 웹·모바일·shared: 설정 DTO 검증(`reminderDaysBefore` 필수), 보내는 시점 문구, 도움말 안 안내, 저장 중 조작 잠금과 실패 시 되돌림,
  준비 중 표시, 알림을 누른 뒤 공고 상세 이동.

자동 테스트는 외부 SMTP·Expo를 호출하지 않습니다. 실제 메일 도착·기기 표시는 별도 확인이 필요합니다.
