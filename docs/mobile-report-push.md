# 맞춤 리포트 앱 푸시

계정·리포트 생성·DB는 기존 Core/MySQL/RabbitMQ가 담당한다. Firebase DB/Auth나 새 Worker 서버를 추가하지 않는다.
Android FCM은 OS 푸시 전달 인증용으로만 사용한다. 앱에는 `expo-notifications`, 전달에는 Expo Push Service를 사용한다.
서버는 기존 Spring RestClient로 통신한다. iOS APNs 인증은 별도로 필요하다.

## 실행 흐름

기존 DailyReportScheduler는 이메일 또는 앱 수신자가 있는 계정을 기존 생성 Outbox에 예약한다.
앱만 받는 회원도 기업 등록·활성 모바일 세션이 있으면 SMTP 설정·이메일 확인 없이 생성한다.
생성 소비자는 수신 상태를 다시 확인하고 기존 검색·근거 답변을 호출한다. 비용 제한·계정당 서울 날짜별 한 건 정책은 유지한다.

`DailyReportPushScheduler → DailyReportPushService → DailyReportPushRepository → MyBatis Mapper → XML → MySQL`
은 공통 발송시각 이후 오늘의 READY 리포트를 기기별로 예약·선점한다. `(report_id, device_id)` 고유성으로 중복 예약을 막는다.
`DailyReportPushService → DailyReportPushClient → Expo Push Service → FCM/APNs → 앱`은 transaction 밖에서 전송한다.
외부 DTO는 `client/dto`, 변환은 `client/mapper`, 내부 업무 결과는 `domain`, 공개 HTTP 계약은 `controller/dto`에 둔다.

ACCEPTED는 Expo 접수, DELIVERED는 FCM/APNs 접수이며 사용자 기기 표시·열람을 보장하지 않는다.
15분 후 receipt를 확인하고 DeviceNotRegistered는 해당 토큰을 비활성화한다. 실패는 FAILED, 불명확 발송은 UNKNOWN이며 자동 재발송하지 않는다.
중단된 SENDING은 20분 후 UNKNOWN, 지난 날짜의 PENDING은 SKIPPED, 23시간 미확인 ACCEPTED는 UNKNOWN이다.
상태·안정적인 오류 코드만 남기며 외부 원문 오류나 인증정보를 공개 응답·로그에 노출하지 않는다.

기기 설정은 모바일 세션과 연결한다. 로그아웃은 FK SET NULL로 연결을 종료하고 절대/유휴 만료·정지·탈퇴 시 발송에서 제외한다.
발송 예약 당시 세션·토큰과 현재 기기의 계정·세션·토큰이 같아야 전송한다. 계정 전환 전 이전 세션을 폐기한다.
알림에는 ID·날짜와 일반 안내만 담는다. 기업명·추천 내용·로그인 정보는 넣지 않는다.
앱은 shared 스키마로 type/ID/날짜를 검증하고 임의 URL을 열지 않는다. 로그인 뒤 ID로 본인 리포트를 조회하며 AI를 재호출하지 않는다.

## HTTP 계약

| 요청 | 동작 |
|---|---|
| `GET /api/v1/me/daily-reports/push?deviceId={UUID}` | 본인 기기 `enabled`, `available`, `sendHour`, `schedulerEnabled`; no-store |
| `PUT /api/v1/me/daily-reports/push` | Bearer 인증, `{deviceId, token}` 등록, 204; 발송 미설정은 503 |
| `DELETE /api/v1/me/daily-reports/push?deviceId={UUID}` | 본인 기기 수신 끄기, 204; 이메일·OS 권한은 별개 |
| `GET /api/v1/me/daily-reports/{id}` | 기존 report envelope; 없거나 다른 소유자는 404 |

기존 이메일 설정 계약은 그대로 유지한다. 새 공통 푸시 DTO·업무 계약은 shared에만 정의한다.
시각은 사용자별 선택이 아닌 기존 `DAILY_REPORT_SEND_HOUR`(서울, 기본 8시)를 사용한다.
생성 스케줄러는 5분 간격, 푸시는 30초 간격이다. 정확한 정각 도착은 보장하지 않는다.
수동으로 생성해 둔 오늘 리포트도 발송시각 이후 재생성 없이 재사용한다.

## Android 에뮬레이터 설정

1. Android Studio Device Manager에서 Google Play 서비스가 있는 AVD를 만들고 실행한다.
2. Expo 프로젝트를 연결하고 UUID를 `frontend/mobile/.env.local`의 `EXPO_PUBLIC_EAS_PROJECT_ID`에 넣는다.
3. Firebase 프로젝트에 Android 앱 `ai.govbiz.mobile`을 등록한다. `google-services.json`의 로컬 경로를
   `GOOGLE_SERVICES_JSON`에 지정하고, FCM v1 서비스 계정 인증을 Expo 프로젝트의 Android push credentials에 설정한다.
   서비스 계정 키와 Expo access token은 Git/채팅에 넣지 않는다. Firebase DB/Auth는 사용하지 않는다.
4. 앱 API는 `EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:8080`으로 연결한다.
   Docker Core 포트는 PC localhost에서 접근 가능해야 한다. 기존 로컬 바인딩이나 데이터는 임의로 변경하지 않는다.
5. 루트 `.env`에서 `DAILY_REPORT_ENABLED=true`, `DAILY_REPORT_QUEUE_ENABLED=true`, `DAILY_REPORT_PUSH_ENABLED=true`로
   설정하고 Core를 새 코드로 재빌드·시작한다. Flyway V46은 추가 테이블만 만든다. SMTP는 필수가 아니다.
   Expo enhanced push security를 쓰면 `DAILY_REPORT_PUSH_ACCESS_TOKEN`을 서버 secret에만 넣는다.
6. 루트에서 `pnpm install --frozen-lockfile`, `frontend/mobile`에서 `pnpm android`로 네이티브 개발 앱을 설치한다.
   JDK 21·Android SDK 경로가 필요하다. Android Expo Go는 원격 푸시를 지원하지 않는다.
7. 로그인·기업 등록 뒤 `전체 → 알림 설정 → 이 기기 앱 알림 켜기`를 누르고 OS 권한을 허용한다.
   같은 기기 등록으로 [관심 공고 마감 알림](deadline-reminders.md)의 앱 알림도 받는다(Android 채널 `deadline-reminders`).
   로그인만으로 권한을 요구하지 않는다. OS 권한 해제 시 앱 활성화에서 서버 수신도 끈다.

Expo/Firebase 프로젝트·인증이 없으면 자동 테스트와 JS export까지 확인할 수 있지만 실제 토큰 발급·푸시 수신은 확인할 수 없다.
자동 테스트는 실제 Expo 발송이나 유료 AI를 호출하지 않는다. 발송만 확인하려면 이미 READY인 오늘 리포트를 사용한다.
새 리포트 실생성은 기존 AI 비용이 발생할 수 있다. 임의 리포트로 장애를 숨기지 않는다.

## 검증

로컬은 관련 Kotlin 단위/HTTP/Client, 모바일 설정·알림 경로·계정 전환, shared DTO 테스트와 타입/Oxlint/JS export,
SQL·아키텍처 경계·설정·문서 참조 및 `git diff --check`를 확인한다.
기존 GovBiz CI의 Core clean build는 MySQL 8.4 Testcontainers로 UPSERT·세션 경계·중복 예약·소유권·rollback을 검증한다.
모바일 전체 test/typecheck/lint/export도 기존 CI에 포함된다. CI와 실기기/에뮬레이터 실수신은 별도 검증이다.

공식 안내: [Expo 설정](https://docs.expo.dev/push-notifications/push-notifications-setup/),
[FCM 인증](https://docs.expo.dev/push-notifications/fcm-credentials/),
[발송·receipt](https://docs.expo.dev/push-notifications/sending-notifications/).
