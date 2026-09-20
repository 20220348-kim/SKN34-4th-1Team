# GovBiz Core Service

소스 디렉터리와 Compose 서비스·내부 DNS는 `core-service`, ECR 이미지 경로는 `govbiz/core-service`입니다.
Gradle·Spring 애플리케이션 이름과 health 응답은 `govbiz-core-service`로 통일했습니다.
현재 운영 환경은 없으며, 이전 런타임 이름으로의 별칭은 제공하지 않습니다.

## 공고 카탈로그 독립 서비스 전환

루트 Compose의 기본 분리 경로에서 `backend/catalog-service`가 공고 원본 DB·제공처 수집·색인 게시를 소유합니다.
Core는 내부 HTTP로 받은 완전한 snapshot을 자신의 읽기 projection에 반영하여 기존 공개 API와
관심 공고·파트너 FK를 유지합니다. `CATALOG_PROJECTION_ENABLED=true`이면 Core의 기존 수집·색인
writer는 조립되지 않습니다. 직접 실행 시 기본값 false는 기존 embedded 실행·AWS 호환을 위한 임시 경로이며,
루트 Compose에서는 true로 고정합니다. 기존 데이터 재사용 전에는 대조·전환 확인이 필요합니다.

아래 기존 수집 설명은 embedded 모드 기준입니다. 새로운 코드·DB·실행 경계, V41 migration,
격리 검증과 아직 수행하지 않은 운영 이전은 [Catalog 서비스 분리](../../docs/catalog-service-extraction.md)를 따릅니다.
계정·기업·신청·리포트 등의 업무는 이번 단계에서 다른 서비스로 이동하지 않습니다.

AWS 초기 운영 설정은 [별도 Compose 및 배포 안내](../../docs/deployment-aws-vercel.md)에 있습니다.
private RDS TLS 검증, Secure 쿠키, 개발 로그인 비활성화, Nginx 고정 IP만 신뢰하는 전달 헤더 설정을 사용합니다.
로컬 기본 `server.forward-headers-strategy=none`과 개발 실행 방식은 유지합니다. 실제 RDS/CloudFront 연결 검증은 배포 시 필요합니다.

브라우저에 공개하는 Spring Boot API입니다. 기업마당·K-Startup·과기정통부·충청남도 수출입공지 수집기를 제공하며, Elasticsearch 키워드·Qdrant 벡터 색인을 준비한 뒤 MySQL에
공개하고, 저장된 공고의 검색·상세 조회와 기업마당 공식 원문 근거 질문을 담당합니다.

프로젝트 전체 설명은 [메인 README](../../README.md), 계층·Facade·DI 설계는
[아키텍처 README](../../docs/architecture/README.md#core-api-업무-흐름과-외부-경계), 기술 선택과 구현 범위는
[기술 구성](../../docs/technology.md)과 [구현 현황](../../docs/implementation-status.md),
실제 실행 순서는 [호출·데이터 흐름](../../docs/architecture.md)을 참고하세요.

## 카카오 탈퇴 연결 해제

탈퇴와 `V28` 연결 해제 작업을 같은 MySQL transaction에 저장합니다. 성공 전까지 이전 카카오 identity를 유지해
같은 공급자 계정의 재가입을 막고, OAuth 콜백은 `unlink-pending`으로 안내합니다.
`AccountOAuthUnlinkScheduler → QueueClient → RabbitMQ → Consumer → Service → KakaoOAuthClient`로 처리하며,
큐 없는 환경은 스케줄러가 동일 Service를 직접 호출합니다. HTTP는 DB transaction 밖에서 실행합니다.
`ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED`는 직접 Core false / Compose true, 전체 실행 스위치 `ACCOUNT_OAUTH_UNLINK_ENABLED`는 true입니다.
불명확한 응답·중단은 UNKNOWN으로 남기며 자동 재호출하지 않습니다. 대화 기록 삭제는 기존 탈퇴 transaction 안에서 유지합니다.
[상태·DB 차단·설정·운영자 확인·검증](../../docs/rabbitmq-account-oauth-unlink.md)을 참고하세요.

## 계정별 대화 기록

`ai.govbiz.core.chathistory`는 로그인 회원 본인의 대화 스냅샷을 보관합니다. `V19__create_chat_conversation.sql`로
기존 MySQL에 테이블을 추가하며 기존 migration·공고 데이터는 수정하지 않습니다.

| API | 동작 |
|---|---|
| `GET /api/v1/me/chat-conversations?before=123` | 본인 기록 요약 최대 30개와 `nextCursor`. 생성 ID 내림차순, 스냅샷 본문 제외 |
| `GET /api/v1/me/chat-conversations/{id}` | 본인 기록의 요약·버전·스냅샷 조회 |
| `PUT /api/v1/me/chat-conversations/{id}` | `{expectedVersion, snapshot}` 저장. 최초 버전 0, 이후 읽은 버전으로 갱신 |
| `DELETE /api/v1/me/chat-conversations/{id}` | 본인 대화의 제목·스냅샷 삭제. 본문 없는 204, 반복 요청도 동일 |

모든 요청은 세션 쿠키와 `X-Chat-Account`(화면 계정 이메일의 URL 인코딩 값)를 보냅니다. 소유자는 세션의 account ID로만
정하고, 헤더는 다른 탭에서 계정이 바뀐 경우 요청을 차단하는 사전조건입니다. 비로그인·계정 불일치는 401, 타인 기록은
조회 시 404, 허용 Origin 없는 상태 변경은 403입니다. 삭제는 기록의 존재 여부를 노출하지 않고 본인 범위에서만 204를
반환하므로 다른 계정의 같은 ID 기록에는 영향이 없습니다. 관리자도 타인의 개인 대화를 조회·삭제할 수 없으며 응답 캐시는 `no-store`입니다.

스냅샷 `schemaVersion=1`, 첫 사용자 메시지 ID와 경로 ID 일치, 메시지 200개·UTF-8 JSON 2,000,000바이트 이하를 검증합니다.
제목은 첫 질문에서 유니코드 문자 최대 80개로 만듭니다. 이것은 회원이 보관하는 화면 데이터로, 서버가 보증한 검색 결과나
AI 입력의 신뢰 근거로 사용하지 않습니다. 프론트엔드는 복원 시 DTO·공식 원문 링크 등을 별도로 검증합니다.
저장 transaction에서 계정 행을 잠그고 버전을 검사합니다. 오래된 다른 내용은 409이며 같은 JSON의 재전송은 멱등입니다.
`V21__add_chat_conversation_deletion.sql`은 `deleted_at`을 추가합니다. 삭제는 제목을 빈 문자열, 스냅샷을 `{}`로
비우고 최소 식별 정보·삭제 표시만 남깁니다. 목록·상세에서 제외하며 복구 기능은 없습니다. 최초 저장보다 삭제가 먼저
도착해도 같은 계정 잠금 아래 삭제 표시를 기록하고, 이후 모든 버전의 저장을 409로 거절해 자동 저장·다른 탭의 재생성을 막습니다.
삭제 응답 유실 시 같은 DELETE를 재시도할 수 있습니다. 계정 탈퇴 이벤트는 같은 transaction에서 삭제 표시까지 제거합니다.
저장·조회·삭제에는 외부 API·OpenAI 호출이 없습니다.

### V19 병합 충돌과 기존 DB 업그레이드

마이그레이션 순서는 `V19__create_chat_conversation.sql` → `V20__add_account_admin_management.sql` →
`V21__add_chat_conversation_deletion.sql`입니다. 관리자 기능 브랜치의 중복 V19는 SQL 내용을 바꾸지 않고 V20으로
이동했습니다. 이미 적용된 대화용 V19의 파일·체크섬·적용 이력은 유지하며, 빈 DB와 대화용 V19 적용 DB는 정상 기동으로
남은 버전을 순서대로 적용합니다. 데이터 초기화나 `flyway repair`는 필요하지 않습니다.

업그레이드 전에는 대상 DB의 `flyway_schema_history`에서 `version`, `script`, `checksum`, `success`를 확인하세요.
**관리자용 `V19__add_account_admin_management.sql`을 먼저 적용한 별도 DB는 바로 재기동하지 마세요.** 해당 DB는
대화용 V19 적용 DB와 이력이 다릅니다. 전체 백업과 관리자 스키마·SQL 체크섬 검증 후, DBA와 함께 관리자 이력의 버전·파일명을
V20에 맞추고 미적용 대화용 V19를 한 번만 out-of-order로 적용하는 별도 이력 정합화가 필요합니다. 기존 설치 순서·체크섬·
적용 시각은 보존해야 하며 이 저장소가 다른 DB의 이력을 자동 수정하지 않습니다. 무조건적인 `repair`, 이력 삭제,
`validate-on-migrate=false`, 볼륨 초기화로 충돌을 숨기지 마세요.

## 실행

기업 맞춤 리포트는 `ai.govbiz.core.dailyreport`에서 저장된 기업 조건·지원 목적을 기존 검색과 HTML 근거 답변에
연결합니다. `V12`는 수신 설정, 날짜별 리포트와 일일 생성 예산을 저장합니다. 수신 주소 확인·동의 후 SMTP로
발송하며 자동 발송은 기본 비활성화입니다. [API·설정·장애 경계와 사용 순서](../../docs/daily-reports.md)를 참고하세요.
관련도는 선정 확률이 아니며 PDF/HWP 전체 분석·뉴스 브리핑은 포함하지 않습니다.

정기 생성은 `V23`의 `daily_report_generation_job`에 리포트·예산과 함께 예약한 뒤 RabbitMQ로 전달합니다.
`DailyReportOutboxScheduler → DailyReportQueueClient → RabbitMQ → DailyReportGenerationConsumer → DailyReportService`이며,
Core 내부 소비자 1개가 기존 AI 경로를 재사용합니다. 웹 미리보기는 기존 동기 계약을 유지합니다.
정기 예약은 `dailyReportTaskScheduler`의 전용 단일 스레드에서 시작 1분 후, 이전 실행 완료 후 5분 간격으로 수행합니다.
공고 수집용 기본 스케줄러와 분리하며 `DAILY_REPORT_ENABLED=false`이면 예약 스케줄러 Bean도 생성하지 않습니다.
V27부터 발송 큐를 켜면 `DailyReportScheduler → Repository`가 기존 리포트 행에 발송 대기를 저장하고,
`DailyReportDeliveryOutboxScheduler → DailyReportDeliveryQueueClient → RabbitMQ → DailyReportDeliveryConsumer → DailyReportService → DailyReportMailClient`
에서 SMTP를 실행합니다. `DAILY_REPORT_DELIVERY_QUEUE_ENABLED`는 직접 실행 false / Compose true이며,
false면 기존 직접 SMTP 경로를 유지합니다. 기존 대기 작업은 정기 예약이 꺼져도 메일 설정이 있으면 전송될 수 있습니다.
[발송 상태·UNKNOWN·V27·설정·검증 상세](../../docs/rabbitmq-daily-report-delivery.md)를 참고하세요.
직접 Core를 실행할 때 큐는 기본 비활성입니다. 정기 실행에는 `DAILY_REPORT_ENABLED=true`와
`DAILY_REPORT_QUEUE_ENABLED=true` 모두 필요하며, 큐가 꺼진 정기 실행 설정은 시작 시 거부합니다.
브로커는 `RABBITMQ_HOST`/`RABBITMQ_PORT`/`RABBITMQ_USERNAME`/`RABBITMQ_PASSWORD`/`RABBITMQ_VHOST`로 연결합니다.
Compose에서는 큐만 기본 활성이고 새 정기 작업 예약·메일은 기본 비활성입니다. 기존 작업이 있다면 큐만 켜도 처리됩니다.
[Outbox·중복 처리·실행 불명·설정·검증 상세](../../docs/rabbitmq-daily-report-generation.md)를 참고하세요.

중복 지원 검토는 `ai.govbiz.core.combinationreview`에 세션 인증 기반 생성·목록·상세·입력 수정·삭제 API를 구현했습니다.
V10은 검토 입력, V11은 실행 스냅샷·원본 파일 이력을 저장합니다. 공식 첨부 자동 수집·PDF/HWP/HWPX 파싱과
단일 Agent 분석을 사용자 화면에 연결했습니다.
[기능 설계와 구현 경계](../../docs/duplicate-support-review-design.md)를 참고하세요.

| 중복 지원 검토 API | 동작 |
|---|---|
| `POST /api/v1/combination-reviews` | 제목·정확히 2개 사업의 현재 입력 생성. 201과 상세 본문·Location 반환 |
| `GET /api/v1/combination-reviews?size=20&beforeId=123` | 본인 목록, 생성 ID 내림차순. size 1~50, beforeId 생략 가능 |
| `GET /api/v1/combination-reviews/{id}` | 본인 상세 입력·버전 조회 |
| `DELETE /api/v1/combination-reviews/{id}` | 본인 검토와 선택 공고·실행 이력·보관 원문 삭제. 성공 시 204 |
| `PUT /api/v1/combination-reviews/{id}/inputs` | 제목·사업 목록 전체 교체. expectedRevision 일치 시 204, 충돌 시 409 |
| `POST /api/v1/combination-reviews/{id}/runs` | expectedRevision·requestKey·선택적 additionalFacts로 비동기 분석 접수. 신규 202 QUEUED, 동일 요청 재조회 200 |
| `GET /api/v1/combination-reviews/{id}/runs` | 본인 실행 목록, size/beforeId 커서 |
| `GET /api/v1/combination-reviews/{id}/runs/{runId}` | 당시 입력·근거·설정·결과 또는 실패 조회. 근거 문서는 공식 공고 상세 `sourcePageUrl`과 수집 첨부 `sourceUrl`을 구분해 반환 |
| `GET /api/v1/combination-reviews/{id}/runs/{runId}/sources/{documentIndex}` | 실행 당시 원본 파일 다운로드. documentIndex는 0부터 시작 |

소유자는 기존 세션 쿠키를 검증한 Account로 결정하며, 관리자도 타인 검토를 조회·수정할 수 없습니다.

V25부터 실행 행이 Outbox이며 `CombinationReviewOutboxScheduler → CombinationReviewQueueClient → RabbitMQ →
CombinationReviewRunConsumer → CombinationReviewRunService`로 기존 수집·파싱·AI를 실행합니다.
`COMBINATION_REVIEW_QUEUE_ENABLED`는 직접 실행 false / Compose true이며, false일 때 새 분석은 503으로 거절하고
동기 실행으로 우회하지 않습니다. 상태는 QUEUED/RUNNING/SUCCEEDED/FAILED/UNKNOWN/INTERRUPTED입니다.
UNKNOWN은 같은 검토의 새 실행도 차단합니다. [한도·만료·재발행·배포·검증 상세](../../docs/rabbitmq-combination-review.md)를 참고하세요.
없는 검토와 타인 검토는 같은 404를 반환합니다. 성공 응답은 `Cache-Control: no-store`이며 시각은 `+09:00`입니다.
쓰기 요청의 기존 Origin 방어를 유지하고 CORS에서 PUT·DELETE를 허용합니다. 상세 JSON·오류 코드는 위 설계 문서에 있습니다.

신청 문서 작성 도우미는 `ai.govbiz.core.applicationpreparation`에 구현합니다. V15는 로그인 계정이
소유한 신청 준비 건의 공고·양식 버전·분야·입력 revision을 저장합니다. V28은 문서 입력과 분리된 진행 단계·revision·변경 시각을 추가합니다. V18 이후 사용자가 선택한 네 제공처 공고의
공식 PDF/HWP/HWPX에서 발견한 신청 문서와 문항을 파일 hash·파서·모델·프롬프트 버전이 고정된 양식 스냅샷으로 저장합니다. 큰 문서 지도 JSON이 포함된 양식 조회는 DB에서 정렬하지 않고 Repository에서 ID 순서를 유지하므로 MySQL 전역 정렬 버퍼 증설을 요구하지 않습니다.
HWPX discovery 요청에는 원본 `sourceBase64`·`sourceSha256`을 내부 AI 계약으로 전달합니다. AI가 실제 표 구조를 읽은 뒤 문항을 추출하며 바이너리는 OpenAI로 전달하거나 양식 JSON에 추가 저장하지 않습니다. 새 필드를 받는 AI를 먼저 배포한 뒤 Core를 배포합니다.
기존 혁신바우처 manifest는 검수 기준과 기존 준비 건 복원을 위해 유지합니다.

로컬 데모 적재는 V35의 신청 준비와 V37의 중복 검토 nullable `demo_seed_key`로 목업과 일반 사용자 작업을 구분합니다.
두 기능 모두 계정별 목업 키만 유일하고 일반 API가 만드는 NULL 키 행은 계속 추가할 수 있습니다. 기본 시연 계정 admin·member마다 독립된 parent/child 행을 만들며
공개 API의 `owner_account_id` 계약은 바꾸지 않습니다. 자동 적재 흐름은 [인프라 데모 데이터](../../infrastructure/README.md#데모-데이터)를 따릅니다.

| 신청 준비 API | 동작 |
|---|---|
| `GET /api/v1/application-preparations/forms` | DB에서 AVAILABLE 공고의 양식·분야·문항 조회. AI 호출 없음 |
| `GET /api/v1/application-preparations/forms/availability?sourceCode=...&sourceProgramId=...` | 공고별 분석 상태·사유와 활성 snapshot 전체 조회. 현재 작성 화면의 시작 경로 |
| `POST /api/v1/application-preparations/forms/discovery-jobs` | UUID requestKey·공고 식별자로 V26 계정별 수동 작업 접수. 기존 API이며 현재 작성 화면에서는 호출하지 않음 |
| `GET /api/v1/application-preparations/forms/discovery-jobs` | 본인의 최근 20개 분석 작업을 공고명·공식 원문 URL과 함께 요약 |
| `GET /api/v1/application-preparations/forms/discovery-jobs/{id}` | 본인 작업의 공고명·공식 원문 URL·상태·결과 조회 |
| `POST /api/v1/application-preparations` | 공고·양식 버전·지원 분야를 검증해 본인 준비 건 생성. 201·Location·상세 반환 |
| `GET /api/v1/application-preparations?size=20&beforeId=123` | 본인 준비 건 목록을 생성 ID 내림차순으로 조회 |
| `GET /api/v1/application-preparations/{id}` | 본인 준비 건과 선택한 버전의 양식 문항 조회. 타인 건과 없는 건은 같은 404 |
| `PUT /api/v1/application-preparations/{id}/progress-stage` | 본인 준비 건의 진행 단계 변경. 독립된 진행 revision 충돌은 409 |
| `DELETE /api/v1/application-preparations/{id}` | 본인 준비 건 삭제. 확인 사실·AI 실행 기록은 FK cascade 삭제하고 공용 양식 스냅샷은 유지 |
| `POST /api/v1/application-preparations/{id}/sections/{sectionKey}/messages` | 현재 입력 revision과 요청 키로 사용자 답변을 AI가 해석해 확인 전 사실·미정 제안 반환 |
| `PUT /api/v1/application-preparations/{id}/sections/{sectionKey}/inputs` | 사용자가 확인한 문항 사실 전체 스냅샷 저장. revision 충돌은 409 |
| `POST /api/v1/application-preparations/{id}/sections/{sectionKey}/drafts` | 필수 답변 확인 후 문항 초안 생성. `expectedRevision`, nullable `expectedVersionId`, UUID `requestKey` |
| `PUT /api/v1/application-preparations/{id}/sections/{sectionKey}/content` | `expectedRevision`, `expectedVersionId`, `content`로 새 사용자 수정본 저장 |
| `POST /api/v1/application-preparations/{id}/sections/{sectionKey}/confirmations` | `expectedRevision`, `expectedVersionId`에 해당하는 최신 작성본을 사용자 확인 |

현재 화면은 아래 문서 API를 사용합니다. 위 문항별 텍스트 생성·수정·확인 API는 현재 UI에서 호출하지 않는 기존 계약입니다.

| 문서 API | 동작 |
|---|---|
| `GET /api/v1/application-preparations/{id}/documents` | 현재 입력 revision의 생성 파일 메타데이터 목록 |
| `POST /api/v1/application-preparations/{id}/documents` | `expectedRevision`으로 원본 양식 기입 및 같은 형식 파일 저장 |
| `GET /api/v1/application-preparations/{id}/documents/{fileId}/download` | 소유자 확인 후 binary attachment·no-store 반환 |

V32은 원본 SHA-256·기입 위치 JSON·결과 binary를 준비 건/revision별로 보관합니다. 입력 변경 중 생성된 파일은 409로 저장을 거절하며 준비 건 삭제 시 cascade 삭제됩니다. HWP는 hwplib 1.1.11, HWPX는 ZIP/XML, PDF는 PDFBox의 편집 가능한 AcroForm과 OFL NanumGothic을 사용합니다. 원본 첨부는 기존 공식 제공처 Client로 재수집하고 해시를 대조합니다. 임의 URL을 받지 않습니다.

HWP/HWPX의 파란 글씨는 `exampleText` 후보로 AI에 전달합니다. AI가 기입란의 예시·작성 힌트로 선택한 `clearExampleTargetIds`만 제거하고, 검은 항목명과 선택하지 않은 제목은 유지한 뒤 답변을 검은 글씨로 기입합니다. 색상만으로 모든 파란 글씨를 삭제하지 않습니다. 범위 주석이 있는 HWP 문단의 예시 삭제는 지원하지 않으며 명시적인 오류를 반환합니다. PDF의 기존 예시 제거는 지원하지 않습니다.
AI가 서로 다른 답변을 같은 HWP/HWPX 텍스트 칸에 배치하면 AI Service가 칸마다 첫 답변과 충돌하지 않은 위치를 고정하고, 나머지 충돌 답변을 고정된 칸을 금지한 한 번의 요청으로 다시 배치합니다. 첫 응답과 교정 응답의 예시 삭제 분류가 모두 유효하지 않으면 답변 없는 분류 요청으로 분리한 뒤 전체 위치 계약을 다시 검증합니다. 교정 뒤에도 안전한 고유 위치가 없으면 Core는 파일을 저장하지 않고 명시적인 생성 오류를 반환합니다.

HWP/HWPX의 모든 파란 문구 후보는 답변 유무와 관계없이 `clearExampleTargetIds`(예시·작성 힌트 삭제) 또는 `preserveExampleTargetIds`(제목·항목명·필수 안내 보존)에 정확히 한 번 포함되어야 합니다. AI Service와 Core API 양쪽에서 누락·중복·교집합·알 수 없는 ID를 거절합니다. 체크박스 답변을 Core가 모두 처리한 경우에도 예시 후보가 있으면 빈 facts로 분류를 요청합니다. 파일 편집 후 삭제 대상으로 선택한 문단에 파란 문구가 남았는지 다시 검사합니다. 의미 분류의 정확도와 실제 한글 조판 품질은 별도 검수가 필요하며, PDF의 기존 문구 삭제는 지원하지 않습니다.
V33은 생성기 버전을 고유키에 추가합니다. 다른 생성기 버전의 결과는 재사용하지 않으며, 기존 파일을 삭제하지 않고 같은 답변 revision으로 새 파일을 생성합니다. 이전 파일 ID의 소유자 다운로드는 유지됩니다.

팀 main의 V29(가입 이메일 인증)·V30(신청 진행 관리)과의 번호 충돌을 해결하기 위해 신청 문서 migration은 V31(텍스트 작성본)·V32(파일)·V33(생성기 버전)으로 이동했습니다. SQL 내용은 변경하지 않았습니다. 이전 skn-140의 V29~V31을 이미 적용한 개발 DB는 번호 변경만으로 재기동할 수 없습니다. 해당 DB는 백업 및 `flyway_schema_history`의 script/checksum과 실제 스키마를 확인한 별도 이력 이관이 필요합니다. 단순 `repair`나 데이터 볼륨 삭제로 처리하지 않으며, 신규 DB 또는 팀 main의 V30까지 적용된 DB가 이 migration 순서의 기준입니다.

현재 생성기 버전은 5입니다. 이전 버전의 파일을 재사용하지 않고 새로 생성하며 기존 다운로드는 유지합니다. HWP의 실제 체크박스/라디오 컨트롤을 `CHECKBOX` 대상으로 읽고, 값과 유일하게 일치하는 선택지는 Core가 직접 연결합니다. 나머지 위치는 AI가 선택합니다. 같은 선택 그룹의 기존 체크를 해제하고 해당 옵션만 선택하며, 서로 다른 답변을 같은 문단에 합치지 않습니다. HWP/HWPX의 밑줄 빈칸은 제자리 치환하고, 빈 문단·콜론으로 끝나는 항목명 외의 검은 본문에는 답변을 덧붙이지 않습니다.
HWP에서 표가 있는 섹션의 표 밖 빈 문단은 기입 후보에서 제외합니다. 예시 삭제 후 표 밖 문단이 비어도 답변 기입을 거절하며, 표 안의 빈 문단과 표가 없는 섹션의 입력란은 유지합니다.
HWP는 답변의 기울임·취소선·자간·장평을 정리하고, 글자 폭과 셀 너비로 줄 배치 레코드를 재작성합니다. 셀 높이가 부족하면 같은 행과 이를 걸치는 셀 높이를 함께 늘립니다. 이는 한글의 전체 페이지 조판 엔진을 대체하지 않으므로 복잡한 개체·페이지 배치는 실제 한글에서 확인해야 합니다. `UNKNOWN`과 미입력 값은 임의 칸에 ‘미정’으로 쓰지 않고 결과 화면에서 미기입 항목으로 안내합니다.

V31는 기존 텍스트 초안 실행과 작성본 버전을 저장합니다. 상세 응답 `contents`는 최신 ID부터 모든 작성본의 내용·종류·입력 revision·
생성 시간·사용자 확인 시간·`stale`을 반환합니다. 같은 요청 키의 성공한 초안 실행은 다시 호출하지 않고 현재 상세를 반환하며,
같은 키의 다른 요청 또는 미완료·실패 실행은 409입니다. 실패 후 새 요청 키로 명시적으로 재시도합니다.
초안 실행 중 입력이나 작성본이 변경되면 결과를 현재 작성본에 적용하지 않고 409를 반환합니다. DB transaction에는 AI 호출을 넣지 않습니다.
사용자 수정은 원본 사실 스냅샷을 유지하므로 이전 입력 기준의 문안을 수정하는 것만으로 현재 입력 확인 상태가 되지 않습니다.
입력이 변경된 문항은 현재 답변으로 새 초안을 생성한 뒤 필요한 수정과 확인을 진행합니다. 작성본 내용은 최대 15,000자이며
확인·수정·조회는 AI를 호출하지 않습니다. 준비 건 삭제 시 작성본과 초안 실행도 cascade 삭제됩니다.

`ApplicationFormDiscoveryOutboxScheduler → ApplicationFormDiscoveryQueueClient → RabbitMQ → ApplicationFormDiscoveryJobConsumer`
가 MySQL 실행권을 선점하고 기존 수집·추출 Service를 실행합니다. V26 작업 행이 Outbox이며 UNKNOWN은 새 분석도 차단합니다.
AI Service가 원문 근거 검증 실패를 `422 / APPLICATION_FORM_AI_INVALID_RESPONSE`로 확정하면 FAILED로 종료해 공고 재선택 후 새 요청을 허용합니다. 통신 유실·시간 초과는 UNKNOWN을 유지하며 자동 재호출하지 않습니다.
`APPLICATION_FORM_DISCOVERY_QUEUE_ENABLED`는 Compose에서 true, Core 단독 기본 false입니다. 새 API는 비활성 시 503입니다.
구형 동기 `POST .../forms/discover`는 큐 비활성 환경에서만 남기며, 큐 활성 환경은 409로 차단합니다.
관리자 전용 `GET /api/v1/admin/queues`는 생성·발송·중복 검토·공식 문서 분석·카카오 연결 해제 다섯 큐의 DB 상태·대기 메시지·소비자·DLQ를 읽기 전용으로 확인합니다.
[API·화면·한도·장애·운영 조회·V26 배포 상세](../../docs/rabbitmq-application-form-discovery.md)를 참고하세요.

목록·상세와 화면 진입은 AI Service·OpenAI·Qdrant를 호출하지 않습니다. 양식 발견과 생성은 각각 사용자의 명시적 POST와
허용된 Origin에서만 수행합니다. 공식 출처 확인과 AI 문항 추출은 기관 검수·선정 가능성 판단을 뜻하지 않습니다.
V16은 문항별 확인 사실과 AI 해석 실행의 요청 키·입력/출력 스냅샷·상태를 저장합니다. AI 호출은 DB transaction 밖에서
`Controller → Service → AI Facade → Client → AI Service`로 실행하고, 제안은 PUT 전까지 사실로 저장하지 않습니다.
[기능 범위와 후속 경계](../../docs/application-preparation-design.md)를 참고하세요.

신청 문서 자동 수집은 BIZINFO의 숫자형 `PBLN_...` 공고와 KSTARTUP·MSIT·CNTRADE_NOTICE의 숫자형 공고를 지원합니다.
각 제공처의 공식 상세에 직접 연결된 PDF/HWP/HWPX만 읽고 제공처와 원문 호스트·공고 ID가 일치하는지 다시 검증합니다.
K-Startup은 API의 `detl_pg_url`과 같은 공고 ID의 모집중·마감 상세만, 충남은 API 제목·본문과 단 하나로 일치하는 공식 게시판
상세만 사용합니다. 사용자 임의 URL·스캔 PDF/OCR·ZIP 내부 탐색·암호화 문서는 지원하지 않습니다.
같은 공고에 읽을 수 있는 공식 문서가 있으면 크기 제한을 넘거나 텍스트를 추출할 수 없는 첨부는 제외 사유와 파일명을
`coverageWarnings`에 남기고 분석을 계속합니다. 공고 하나의 모든 지원 형식 첨부가 제외되면 기존처럼 기술 실패로 종료합니다.
중복 지원 검토 한 실행에서 보존하는 원본은 최대 12개이며, 초과 조합은 일부만 분석하지 않고 `SOURCE_TOO_LARGE`로 종료합니다.
원문·입력·결과는 실행마다 보존하며 기존 검색 Qdrant 색인과 분리됩니다. 공식 공고 상세 주소와 실제로 수집한 첨부 주소도
구분해 보존하고, 자동 수집 근거를 사람 검수 완료로 표시하지 않습니다.
같은 요청 키는 AI를 재호출하지 않습니다. 새 접수는 계정 식별자로 기존 공개 요청 제한을 공유하며,
검토별 활성 실행 1개·계정별 활성 작업 3개를 제한합니다. 검토 큐는 소비자 1개로 처리하고,
worker도 기존 검색·AI 기능의 공유 동시 실행 슬롯을 사용합니다.

`CombinationReviewRunService`는 실행 순서와 저장을, `AiCombinationReviewFacade`는 AI 호출·계약 검증 경계를 담당합니다.
중복 지원 검토는 네 제공처 공고를 자동 분석하며, 현재 카탈로그의 공식 상세와 공고 식별자를 다시 검증한 뒤 첨부를 수집합니다.
두 기능이 함께 쓰는 공식 첨부 수집·파싱은 제공처별 `BizInfoAttachmentClient`·`MsitAttachmentClient`·
`KStartupAttachmentClient`·`CnTradeNoticeAttachmentClient`와
`supportprogram/client/document/SupportProgramDocumentParser`에 두고, AI DTO 변환은 `AiCombinationReviewMapper`가 담당합니다.
업무 실패는 `domain/exception`, 외부 시스템 실패는 `client/exception`에 두어 Repository·Client가 Service에 역으로 의존하지 않습니다.
이는 프로젝트의 기능 중심 레이어드 구조이며 범용 port/interface나 전달만 하는 Facade를 추가한 구조는 아닙니다.

JDK 21과 MySQL 8.4가 필요합니다. 실제 공고 동기화·자연어 검색에는 Nori가 설치된 Elasticsearch와 실행 중인 AI Service·Qdrant도
필요합니다. 전체 서비스를 함께 실행하는 방법은 [인프라 README](../../infrastructure/README.md)를 참고하세요.

저장소 루트에서 다음 명령으로 실행합니다. 네이티브 실행은 루트 `.env`를 자동으로 읽지 않으므로
필요한 환경변수를 현재 프로세스에 설정해야 합니다.
Core를 호스트에서 직접 실행할 때 `ELASTICSEARCH_BASE_URL`은 **호스트에서 접근 가능한 Nori 설치 ES**를
가리켜야 합니다. 기본 Compose의 ES는 9200을 호스트에 공개하지 않으므로 `bootRun`만으로 그 컨테이너에
연결되지는 않습니다. 전체 Compose 실행을 우선 사용하고, 별도 ES를 쓰는 경우 주소·인증·Nori 설정을 명시합니다.

```bash
cd backend/core-service
./gradlew bootRun
```

기본 주소는 `http://127.0.0.1:8080`입니다. 실행 시 Flyway가 MySQL 스키마를 적용합니다.
`DATA_GO_KR_SERVICE_KEY`가 비어 있으면 수집 작업은 실패를 기록하며 다음 주기에 다시 시도합니다.
빈 검색어 목록은 이미 공개된 제공처의 DB 스냅샷에서 최신 공고를 반환하며, 상세 조회와 함께 이후
제공처별 색인 장애에도 사용할 수 있습니다. 검색어가 있는 검색은 AI Service와 해당 공고 버전의
색인이 있어야 성공합니다. 새 카탈로그 공개에도 색인 준비가 필수이므로 기업마당 키만으로 동기화가
완료되지는 않습니다.

## 검색 품질 평가 fixture 내보내기와 캡처

### 실제 공고 fixture 초안 내보내기

실데이터 평가의 시작점은 `evaluation-fixture-export` 프로필입니다. 이 비웹 프로필은 현재 MySQL에서
색인 준비가 확인된 제공처의 공개 공고 중 지정한 `referenceDate` 기준 `OPEN` 공고만 읽고, 운영 색인과 같은 `SupportProgramIndexDocumentMapper.fromCatalog`로
`id`·`contentHash`·`text`를 만듭니다. 공고 수와 카탈로그 지문을 포함한 전체 fixture 초안을 기록하므로,
이후 캡처 결과가 같은 공고 스냅샷에서 나왔는지 확인할 수 있습니다.

이 프로필은 웹 서버·기업마당/K-Startup 동기화·누락 색인 복구를 끄며 Qdrant, AI Service, OpenAI를 호출하지 않습니다.
`name`, `reference-date`, `output-path`는 반드시 지정해야 합니다. 기준 날짜는 실행 시점의 오늘이 아니라
저장된 신청 시작·종료일로 접수 상태를 다시 계산하는 기준입니다.

```bash
cd backend/core-service
./gradlew bootJar

SPRING_PROFILES_ACTIVE=evaluation-fixture-export \
APP_SUPPORT_PROGRAM_SEARCH_FIXTURE_EXPORT_NAME=support-program-catalog-20260905-v1 \
APP_SUPPORT_PROGRAM_SEARCH_FIXTURE_EXPORT_REFERENCE_DATE=2026-09-05 \
APP_SUPPORT_PROGRAM_SEARCH_FIXTURE_EXPORT_OUTPUT_PATH=/absolute/path/support-program-fixture.json \
java -jar build/libs/govbiz-core-service-0.0.1-SNAPSHOT.jar
```

생성 파일의 `cases`는 빈 배열(`[]`)입니다. 질문의 `id`·`query`·`split`을 고정하고, 평가 전에 선택한
AI-only·혼합·사람 검토 방식으로 `relevantIds`와 판정 출처를 확정합니다. 미확정 항목을 무관으로
바꾸지 않으며 현재 공유 실행은 AI-only 기준입니다. 질문 묶음의 `name`과 각 `cases`의 `id`·`query`·`split`은
fixture와 순서·내용까지 같아야 합니다. 내보내기는 빈 적격 카탈로그, 누락된 정렬 시각, 중복 검색 문서 ID 등
검증에 실패하면 기존 출력 파일을 바꾸지 않으며, 모든 검증이 끝난 결과만 원자적으로 교체합니다.

### 실제 검색 흐름 캡처

fixture와 같은 질문 묶음을 준비한 뒤에는 공개 API를 반복 호출하지 않고
`evaluation-capture` 프로필을 실행합니다. 이 프로필은 웹 서버·기업마당/K-Startup 동기화·누락 색인 복구를 끈 뒤,
질문 묶음의 각 항목을 현재 `SupportProgramSearchService`에 전달합니다. 따라서 MySQL의 적격 공고 선정,
Qdrant·키워드 순위를 결합한 후보 최대 20개, AI 최종 추천 최대 5개라는 운영 검색 흐름에서 나온 ID를
그대로 JSON 파일에 기록합니다. fixture와 capture는 모두 `findSearchablePresent`로 준비된 제공처의
공고만 읽습니다. 기존 고정 평가 자료는 당시 스냅샷·실행 조건의 기록이며 이번 조회 범위로 다시 해석하지 않습니다.

질문 파일은 [예시](../../evaluation/support-program-search/query-set.example.json)를 복사해 준비합니다.
fixture 내보내기는 지정한 기준 날짜의 `OPEN` 공고만 담으므로, 캡처도 기본값인 `acceptingOnly=true`와
**같은 기준 날짜**로 실행해야 합니다.
실행 환경의 MySQL·Elasticsearch·AI Service·Qdrant는 실제 검색과 같은 상태여야 하며, AI 점수화 호출 비용이 발생할 수
있으므로 기본 실행이나 CI에는 포함하지 않습니다.

```bash
cd backend/core-service
./gradlew bootJar
SPRING_PROFILES_ACTIVE=evaluation-capture \
APP_SUPPORT_PROGRAM_SEARCH_CAPTURE_QUERY_SET_PATH=/absolute/path/query-set.json \
APP_SUPPORT_PROGRAM_SEARCH_CAPTURE_OUTPUT_PATH=/absolute/path/capture.json \
APP_SUPPORT_PROGRAM_SEARCH_CAPTURE_REFERENCE_DATE=2026-09-05 \
java -jar build/libs/govbiz-core-service-0.0.1-SNAPSHOT.jar
```

질문은 최대 100개이며, 하나라도 실패하거나 실행 중 카탈로그가 바뀌면 결과 파일을 쓰지 않습니다.
성공한 v2 캡처에는 기준 날짜·공고 수·카탈로그 지문·후보 ID·최종 추천 ID가 포함됩니다. 평가기는 fixture와
capture의 기준 날짜가 다르면 점수 계산을 거부합니다. 실제 공고의 검색 문서가 들어갈 수 있는 파일은
[평가 실행 보관 폴더](../../evaluation/support-program-search/runs/README.md)에서 관리합니다.
비밀정보를 제외한 고정 공유 실행의 스냅샷·판정·캡처·보고서는 Git에 포함하며, 새 실행과 임시 출력은
기본적으로 제외합니다. 선택한 판정 출처의 fixture와 비교해 지표를 계산하는 방법은
[검색 평가 자료](../../evaluation/support-program-search/README.md)를 참고하세요.

## 공개 API

검색, 대화 조건 해석, 공고별 근거 답변은 한 Core 프로세스에서 요청량·동시 실행 한도를 공유합니다.
기본값은 접속 주소별 최근 60초 6건, 전체 60건, 동시 4건이며, 초과 시 DB·AI 호출 전에
`429 SUPPORT_PROGRAM_RATE_LIMITED` 또는 `503 SUPPORT_PROGRAM_BUSY`로 거절합니다.
`Retry-After`·`retryAfterSeconds`를 반환하고 실제 작업 종료 시 동시 슬롯을 해제합니다.
Controller의 `SupportProgramRequestAdmissionService.execute`가 공개 요청 입장을 담당하고
기존 Search/Evidence Service의 업무 흐름은 유지합니다. 구현은 `supportprogram/service/admission`,
설정은 그 아래 `config`, 거절 예외는 `exception`에 둡니다.
설정·프록시/NAT 공유·비웹 평가 제외·다중 서버 한계는 [요청 제한 안내](../../docs/support-program-request-limits.md)에 있습니다.

| 메서드·경로 | 용도 |
|---|---|
| `GET /api/v1/health` | Core API 자체 생존 상태 |
| `GET /api/v1/health/ai-service` | AI Service의 내부 Health 응답 확인 |
| `GET /api/v1/support-programs/readiness` | 공개 공고 스냅샷·검색 색인·최근 동기화 결과 상태 |
| `GET /api/v1/support-programs/catalog` | AI 없이 키워드·지역·분야·접수 상태로 공고 목록을 필터링·정렬·페이지 조회 |
| `GET /api/v1/support-programs/search` | 현재 MySQL 공고 카탈로그 검색 또는 최신 목록(비로그인 2개·로그인 최대 5개) |
| `POST /api/v1/support-programs/search` | 이번 검색에만 기업 조건을 반영한 자연어 검색(비로그인 2개·로그인 최대 5개) |
| `POST /api/v1/support-programs/search/results` | 로그인 후 기존 검색 결과와 조건 복원(검색·모델 재호출 없음) |
| `POST /api/v1/support-programs/conversation/interpret` | 현재 발화로 조건 변경 초안을 만들며 사용자 확인 전에는 검색하지 않음 |
| `POST /api/v1/assistant/messages` | 도우미 자유 질문 한 건의 의도 분류·답변. 비로그인 허용, 세션이 있으면 관심 공고함·받은 제안함·기업 상태로 답함. 프런트 `VITE_ASSISTANT_AI_ENABLED=true`일 때만 호출됨 |
| `GET /api/v1/support-programs/detail` | 제공처 코드와 원본 ID로 현재 공고 상세 조회 |
| `POST /api/v1/support-programs/detail/answers` | 특정 공고의 공식 원문 근거 질문·답변 |
| `POST /api/v1/sample-items/prepare` | 계층 연결 학습용 예제 |
| `POST /api/v1/auth/signup` | 이메일·비밀번호 회원가입(201). 계정을 만들고 바로 브라우저 세션 쿠키 발급, 중복 이메일은 409 |
| `POST /api/v1/auth/login` | 이메일·비밀번호 로그인. 세션 JWT를 HttpOnly 쿠키로만 내려줌 |
| `POST /api/v1/auth/logout` | 세션 행 삭제와 쿠키 만료 |
| `POST /api/v1/auth/mobile/login`, `POST …/signup` | 앱 이메일 로그인·가입. 웹과 같은 입력, `{ accessToken, tokenType: "Bearer", expiresAt, account }` 응답, 쿠키 미발급 |
| `POST /api/v1/auth/mobile/logout` | Authorization Bearer 세션 폐기, 쿠키 미발급 |
| `GET /api/v1/auth/mobile/oauth/{provider}/authorize`, `POST …/exchange` | 앱 Google·Kakao 시스템 브라우저 로그인 시작과 PKCE 일회용 코드 교환. 아래 모바일 인증 계약 참고 |
| `GET /api/v1/auth/me` | 세션 쿠키 또는 Bearer로 현재 계정·권한 단계 조회 |
| `PUT /api/v1/me/password` | 로그인 세션으로 본인을 확인해 새 비밀번호만 받아 변경. 요청한 세션만 남기고 다른 기기 세션 종료 |
| `POST /api/v1/auth/password-reset`, `POST …/confirm` | 로그인 없이 가입 이메일로 30분 일회용 재설정 링크 요청(가입 여부와 무관하게 204), 토큰으로 새 비밀번호 저장(모든 세션 종료) |
| `GET /api/v1/me/deletion-preview`, `DELETE /api/v1/me` | 삭제 시 닫히는 모집글·제안 수 미리 보기와 계정 삭제(제안 철회·모집글 마감·기업 삭제·세션 삭제·`deleted_at`) |
| `GET /api/v1/auth/oauth/providers` | 키가 설정된 소셜 로그인 공급자(카카오·Google)와 시작 주소. 설정 확인용이며 화면은 이 목록을 기다리지 않고 두 버튼을 바로 그림 |
| `GET /api/v1/auth/oauth/{provider}/authorize`, `GET …/callback` | 소셜 로그인 시작(서명한 state 쿠키와 함께 공급자로 302)과 콜백(코드 교환·ID 토큰 확인 뒤 `sub`로 로그인 또는 가입, 세션 쿠키와 함께 프런트로 302). 같은 이메일의 기존 계정에는 자동 연결하지 않음 |
| `POST /api/v1/auth/dev-login` | `ACCOUNT_DEV_LOGIN_ENABLED=true`일 때만 등록되는 개발용 시드 로그인 |
| `GET /api/v1/admin/accounts/summary`, `GET /api/v1/admin/accounts` | 관리자 전용(`AdminPrincipal`: 세션 없으면 401, 관리자가 아니면 403). 요약 수치와 계정 목록(검색·상태·역할·로그인 방법·정렬·페이지). 삭제된 계정 제외 |
| `GET /api/v1/admin/accounts/{id}` | 관리자 전용. 계정·기업·활동 수·최근 조치 기록 20건 |
| `POST /api/v1/admin/accounts/{id}/suspend` `/unsuspend` `/sessions/revoke` | 관리자 전용. 사유(1~500자) 필수. 정지는 모든 세션 삭제, 자기 계정 422 `ADMIN_SELF_ACTION`, 다른 관리자 422 `ADMIN_TARGET_PROTECTED`, 이미 그 상태면 409. `account_admin_action`에 기록 |
| `GET /api/v1/me/company/lookup` | 로그인한 회원이 사업자등록번호로 국세청 등록 여부·상호·사업자 상태를 미리 보기(Bizno) |
| `GET` `POST` `PUT /api/v1/me/company` | 내 기업 조회·등록(계속사업자만, 201)·담당자 입력 항목 수정 |
| `GET` `POST` `DELETE /api/v1/me/saved-programs`, `GET …/status` | 관심 공고함. 로그인 회원이 현재 노출 중인 공고를 담고(같은 공고는 한 번) 빼며 최근 순서로 읽음. 없거나 숨겨진 공고는 404 `SUPPORT_PROGRAM_NOT_FOUND` |
| `GET` `PUT /api/v1/me/company/partner-profile` | 협업·파트너 설정(참여 역할·관심 분야·한 줄 소개·역량 태그) 조회·저장. 기업당 한 행 UPSERT |
| `GET /api/v1/partners/recruitments`, `GET .../{id}` | 파트너 모집글 목록(검색·찾는 역할·지역·내 글·정렬·페이지)과 상세. 세션 없이도 읽기 가능 |
| `POST /api/v1/partners/recruitments` | 기업을 등록한 회원이 접수 중인 공고 하나에 모집글 작성(201). 공고당 하나 |
| `POST /api/v1/partners/recruitments/{id}/proposals` | 기업을 등록한 회원이 남의 모집글에 참여 제안 보내기(201). 모집글당 하나 |
| `GET /api/v1/partners/proposals/{id}`, `POST .../accept` `.../decline` `.../withdraw` | 당사자만 제안 조회, 작성자의 수락·거절, 제안자의 철회 |
| `GET /api/v1/me/proposals?box=received\|sent` | 받은·보낸 제안함과 대기 건수 |

### 모바일 인증 계약

`AccountMobileAuthController → 기존 AccountLoginService/AccountSignupService → AccountRepository → MyBatis → MySQL`
흐름으로 웹과 같은 계정·세션 정책을 사용합니다. 앱은 JSON 응답의 `accessToken`을 기기 보안 저장소에 보관하고
`Authorization: Bearer <accessToken>`으로 기존 업무 API를 호출합니다. `rememberMe`에 따른 절대 만료와 유휴 만료,
관리자 정지·세션 폐기·비밀번호 변경 정책을 그대로 적용합니다. refresh token은 발급하지 않으며 만료되면 다시 로그인합니다.
가입 전 인증번호 발송/확인은 기존 `/api/v1/auth/signup/email-code`, `/verify`를 사용합니다.

웹 `/auth/login`, `/auth/signup`의 응답에는 토큰이 들어가지 않고 HttpOnly 쿠키 계약을 유지합니다.
쿠키와 Bearer가 함께 오면 계정 resolver는 쿠키를 우선하며 쿠키 쓰기 요청의 Origin 검사를 생략하지 않습니다.
앱은 쿠키를 보내지 않습니다(`credentials: omit`). 잘못되거나 중복된 Authorization은 비로그인 상태로 숨기지 않고 401입니다.

앱 소셜 로그인은 다음 순서입니다.

1. 앱에서 무작위 `state`(43~128자 URL-safe)와 PKCE `codeVerifier`(43~128자 RFC 7636)를 만들고
   `codeChallenge=base64url(SHA256(codeVerifier))`(padding 없는 43자)를 계산합니다.
2. 시스템 브라우저에서 `/api/v1/auth/mobile/oauth/{google|kakao}/authorize`를 열며
   `redirectUri`, `state`, `codeChallenge`, 선택 `rememberMe`를 query로 전달합니다.
   `ACCOUNT_MOBILE_OAUTH_REDIRECT_URIS`에 등록된 URI와 정확히 같아야 합니다. 기본 빈 목록은 시작을 차단합니다.
   개발 예시는 `govbiz://oauth/complete`이며 운영 앱 링크가 있으면 해당 HTTPS URI를 명시 등록합니다.
3. `AccountMobileOAuthService → AccountOAuthService → GoogleOAuthClient/KakaoOAuthClient`가 기존 공급자 설정을
   사용합니다. 공급자 콘솔의 redirect URI는 여전히 기존 HTTPS 서버 `/api/v1/auth/oauth/{provider}/callback`입니다.
   서명한 HttpOnly state 쿠키로 시작 브라우저를 확인하고 V40 `mobile_oauth_transaction`에서 callback을 원자적으로
   선점합니다. 여러 서버나 중복 callback에서도 공급자 코드 교환은 한 번만 실행됩니다. 외부 호출은 DB transaction 밖입니다.
4. 앱 복귀 URI에는 `code`(60초·1회용 무작위 43자)와 원래 앱 `state`만 붙습니다. 실패는 `error`와 `state`입니다.
   JWT·공급자 토큰·client secret은 URL로 전달하지 않습니다. 앱은 복귀 URI와 `state`를 확인한 후
   `POST /api/v1/auth/mobile/oauth/exchange` 본문 `{ code, codeVerifier, redirectUri }`로 교환합니다.
5. DB의 코드 해시·PKCE S256 challenge·redirect URI·만료를 확인해 코드 소비와 세션 생성을 한 transaction으로
   처리합니다. 동시 교환에서는 한 요청만 성공하고 저장 실패는 소비도 rollback합니다. 응답은 이메일 로그인과 같습니다.

시작 요청이 허용되지 않으면 400 `MOBILE_OAUTH_REQUEST_INVALID`, 만료·재사용·잘못된 PKCE 교환은
401 `MOBILE_OAUTH_EXCHANGE_INVALID`입니다. 검증 DTO 형식 오류는 기존 400 `REQUEST_VALIDATION_FAILED`입니다.
OAuth 실패 `error` 값은 기존 웹과 같은 `cancelled`, `expired`, `unavailable`, `failed`, `email-required`,
`account-exists`, `unlink-pending`, `suspended`, `rate-limited`입니다. 쿠키가 없거나 만료된 공급자 callback은 기존
웹 로그인 실패 화면으로 돌아가므로 앱은 시스템 브라우저 취소 후 재시작할 수 있어야 합니다.
앱 로그인 시작과 교환도 기존 접속 주소당 로그인 요청 제한을 사용합니다(한 Core 프로세스 기준).
V40에는 평문 코드·JWT가 저장되지 않으며 하루 이상 지난 transaction은 후속 로그인 시작 시 최대 100개씩 정리합니다.
실제 공급자·실기기 로그인은 별도 설정과 검증이 필요합니다.

### 직접 조건으로 찾기

`SupportProgramCatalogController → SupportProgramCatalogService → SupportProgramRepository → MyBatis Mapper → MySQL`
흐름으로 이미 공개된 DB 공고를 읽습니다. 기존 `findPublishedPresent()`를 사용하며 AI Service·OpenAI·Qdrant·
기업마당·K-Startup 외부 API를 호출하지 않습니다. 이후 색인 장애와 무관하게 목록을 읽고, AI 요청량 제한 슬롯은 사용하지 않습니다.

`keyword`는 공고명 또는 기관명의 대소문자를 구분하지 않는 단순 포함 검색이며, `region`·`category`는 제공처
태그의 정확한 일치입니다. 필터는 AND로 결합합니다. 지역 선택은 자격 판정이 아니며 서울을 선택해도 전국 태그를
자동 포함하지 않습니다. `status` 기본값은 `OPEN`, `sort`는 `RECENT`, `page`는 1, `pageSize`는 12입니다.
접수 상태는 기존 Repository의 서울 기준 현재 날짜 계산을 그대로 사용합니다.

`sourceCode`로 전체(빈 값)/`BIZINFO`/`KSTARTUP`/`MSIT`/`CNTRADE_NOTICE`를 구분하고, `KSTARTUP` 선택 시 `startupStage`·`applicantType`·
`founderAge`를 추가할 수 있습니다. 공고의 원본 분류를 정확히 비교하며 자격을 추정하지 않습니다.
응답의 `startupStages`·`applicantTypes`·`founderAges`는 전체 공개 K-Startup 스냅샷의 선택지입니다.

현재는 한 번 읽은 공개 스냅샷을 Service에서 필터링·정렬·페이지 분할합니다. 응답에는 총건수와 전체 스냅샷의
지역·분야 선택지도 함께 포함하며, 목록에 AI 추천 이유·점수·자격 검토를 붙이지 않습니다. 목록 요청의 페이지 크기는
최대 50입니다. 요청·응답·정렬 및 확장 시 고려사항은 [직접 조건 검색 계약](../../docs/support-program-catalog.md)에 있습니다.

### 도우미 자유 질문

`AssistantMessageController → AssistantMessageService → AiAssistantClient` 흐름으로 내부
`/internal/v1/assistant/answers`를 한 번 호출합니다. 요청은 질문(최대 500자), 최근 대화 6개, 현재 화면 경로와 공고 선택 여부,
프런트 도움말 항목 전량(1~40개)입니다. 도움말의 원본은 프런트 `helpContent.ts`이므로 Core는 사본을 두지 않고 요청에 실린 항목만 인용으로 인정합니다.
Core는 보내기 전에 사업자등록번호·전화·이메일·주민등록번호를 가리고, 요청량·동시 실행 한도는 검색·원문 질문과 같은 Bean을 공유합니다.
응답 의도는 `PRODUCT_HELP`(답+인용 1~3개, 첫 인용 항목의 이동 버튼)·`ACCOUNT_STATE`(`accountTopic`별로 Core가 관심 공고함·받은 제안함·기업을 읽어 답)·
`SEARCH`(`searchQuery`와 검색 화면 이동)·`PROGRAM_QUESTION`(원문 질문 화면 안내)·`OUT_OF_SCOPE`(기권 답)·`UNCLEAR`(확인 질문)입니다.
의도별 필드 조합·인용 id·스키마 버전이 어긋나면 답을 고치지 않고 502 `AI_SERVICE_INVALID_RESPONSE`로 끝냅니다.
이동 버튼의 경로는 Core 상수(`/app/chat`·`/app/saved-programs`·`/app/proposals`·`/app/profile`·`/app/partners`)와 요청에 실린 도움말 행동 경로만 씁니다.

`app.assistant.agent-enabled=true`(`ASSISTANT_AGENT_ENABLED`)면 `AiAssistantClient.agent`로 `/internal/v1/assistant/agent`를 대신 부릅니다.
로그인 회원이면 `AssistantToolTokenService`가 요청마다 계정 묶음 HMAC 토큰(`app.assistant.tool-token-ttl`, 기본 5분)을 발급해 `principal`로 싣고,
AI Service의 도구는 그 토큰과 공유 비밀(`app.assistant.tools-secret` = `ASSISTANT_TOOLS_TOKEN`, 32자 이상)로 `AssistantToolController`의
읽기 전용 내부 API(`GET /internal/v1/assistant/tools/company-profile|recruitments|saved-programs?accountId=`)를 되부릅니다.
`AssistantToolAuthInterceptor`가 비밀·토큰·계정 일치를 검사하고(401 `ASSISTANT_TOOL_UNAUTHORIZED`, 비밀이 없으면 503 `ASSISTANT_TOOLS_DISABLED`),
`AssistantToolService`는 연락처·사업자등록번호를 빼고 본문을 마스킹·절단해 돌려줍니다. 새 의도 `PARTNER_MATCH`·`SAVED_PROGRAMS_QUESTION`과
`ACCOUNT_STATE`의 답·카드(`cards[]`: 모집글 `/app/partners/detail?recruitmentId=`, 공고 `/app/support-programs/detail?sourceCode=&sourceProgramId=`)는
Core가 형식·경로·중복을 다시 검증하고, 관심 공고 묶음 질문은 첫 응답이 `needsDocuments`면 `AssistantSavedProgramDocumentService`가 관심 공고 최대 10건의
원문을 `SupportProgramEvidenceService.prepareChunks`로 확보·청킹하고 AI Service에 색인한 뒤(`app.assistant.document-prepare-timeout`, 기본 6초, 넘긴 공고는
청크 없이) `resumeIntent`로 한 번 더 불러 인용(`quote`)을 청크 원문과 대조합니다. 에이전트 경로는 주소당 분당 `app.assistant.agent-per-client-per-minute`(기본 3)의
추가 한도를 겁니다. `app.assistant.prefetch-queue-enabled=true`(`ASSISTANT_PREFETCH_QUEUE_ENABLED`, Compose 기본 켜짐)면 관심 공고를 담을 때
`saved_support_program.source_prefetch_*` outbox(V34)가 RabbitMQ 큐 `govbiz.saved-support-program.prefetch.v1`로 원문 수집·색인을 미리 돌리고
하루가 지나면 다시 갱신합니다.
대화 전문은 저장하지 않습니다.

### 후속 대화 조건 해석

`SupportProgramConversationController → SupportProgramConversationService → AiSupportProgramConversationClient`
흐름으로 내부 `/internal/v1/support-program-conversation/interpret`를 한 번 호출합니다.
대화 상태는 브라우저 메모리에만 두며 Core는 DB·검색·색인을 호출하거나 상태를 저장하지 않습니다.
새 메시지와 전체 키를 갖춘 확정 context, 선택적인 마지막 질문·미확정 draftContext 또는 pendingProposal,
최근 성공 검색 요약 lastSearch(context/resultCount)를 전달합니다. 두 미확정 상태는 동시에 받을 수 없습니다.
resultCount는 0 이상의 정수이며 검색 실패·취소는 결과 0건으로 전달하지 않습니다.
nullable 조건도 키 자체는 필수이며 미입력은 명시적 null입니다. boolean은 JSON boolean만 허용합니다.

Core가 서울 기준일과 `govbiz-support-program-conversation-v1`을 보내고, 응답의 최대 6개 SET/CLEAR 변경에서
중복 필드·현재 메시지의 정확한 근거 인용·실제 날짜·문자 및 길이 제한을 검증합니다. 새 계약은 UTF-16 기준으로
message/query 500, region 50, industry/supportPurpose 100, 날짜 10, 질문/근거 160입니다. 상대 업력으로 설립일을
생성할 수 없습니다. 미변경 필드는 유지하고, 마지막 질문의 draftContext → pendingProposal → context 순서로
병합 기준을 정하되 changedFields는 확정 context와
비교해 계산합니다. 공개 DTO·내부 AI DTO·도메인·검증 결과는 각 경계의 타입으로 분리합니다.

READY도 제안일 뿐이며 사용자가 확인한 뒤 기존 POST 검색을 별도로 호출합니다. 정보가 부족하면
CLARIFICATION_REQUIRED와 새 질문·초안을 반환합니다. 결과 설명은 ANSWERED와 answer로 반환하며
변경 updates는 없어야 합니다. answer는 UTF-16 1,000자 이내이고 LF/CR/tab 외 제어 문자를 허용하지 않습니다.
다른 상태의 answer는 null이어야 하며 기존 응답의 생략은 null로 처리합니다. 설명은 검색·조건 적용을 실행하지 않습니다.
추가 필드·ANSWERED를 사용하려면 세 서비스를 함께 반영합니다. 잘못된 AI 응답은 명시적 502 오류이며 질문이나
단문 검색으로 우회하지 않습니다. 해석과 확인 검색은 공유 요청 제한에서 각각 한 건입니다.
상세 계약과 상태 흐름은 [C02 안내](../../docs/conversation-condition-update.md)를 참고하세요.

### 검색·상세·근거 질문

키워드 색인 HTTP 경계는 `client/elasticsearch`, 공유 본문 구성은 `helper/SupportProgramIndexTextHelper`입니다.
`SupportProgramIndexSyncService`가 Elasticsearch → Qdrant를 준비한 뒤에만 제공처 스냅샷을 공개합니다.
기존 환경은 `V24`가 이전 준비 플래그를 재검증 대상으로 바꾸므로 **색인 복구 후** 자연어 검색이 가능합니다.
환경변수·장애 계약·테스트·업그레이드는 [Elasticsearch 적용 상세](../../docs/elasticsearch-lexical-search.md)를 참고하세요.
현재 v2는 지역명·업무 용어 사용자 사전과 검색 시 `여행사/여행업체` 동의어 확장을 사용합니다.
v1을 사용하던 환경은 **새 v2 인덱스 이름으로 전환하고 재색인**해야 합니다. 기존 공고·벡터·v1 색인은 삭제하지 않습니다.

- GET 검색: 필수 `query`는 최대 500 UTF-16 코드 단위이며 빈 문자열을 허용합니다. 탭·줄바꿈·캐리지 리턴을 제외한
  Unicode C 범주 문자(예: NUL·제로폭 문자·단독 surrogate)는 DB·AI 호출 전에 400으로 거부합니다.
  `acceptingOnly`의 기본값은 `true`이고
  이때 `OPEN` 공고만 대상으로 삼습니다. 검색어가 있으면 검증된 의미 검색 상위 20개와 전체 적격 공고의
  키워드 상위 20개를 같은 가중치의 RRF(`1 / (60 + 순위)`)로 결합하고, 최대 20개를 AI가 점수화하여
  기준을 통과한 0~5개를 선정한 후 아래 로그인별 노출 정책을 적용합니다. 키워드는 Elasticsearch Nori(`discard`, 사용자 사전·검색용 동의어)·BM25로 정렬하고
  동점은 최신순·제공처 포함 ID순입니다. RRF 동점은 의미 검색 순위·제공처 포함 ID순입니다.
  적격 공고의 전체 값과 순서가 같으면 제한된 단일 불변 스냅샷에서 문서 해시·두 색인의 버전 참조를 재사용합니다.
  DB 조회·접수 상태 계산·현재 벡터 확인은 매 검색 수행하고, 질문·검색 결과·랭킹은 이 캐시에 보관하지 않습니다.
  내용·순서·접수 상태가 바뀌면 전처리를 다시 수행합니다. DB·후보 준비·의미/키워드 검색·랭킹·전체 처리의
  시간과 성공/실패를 기록하며 질문·기업 조건·공고 원문은 로그에 남기지 않습니다.
  의미 검색 실패는 오류로 반환합니다. 게시된 공고나 미복구 기존 공고가 있지만 준비된 색인이 하나도 없으면
  자연어 검색은 빈 결과가 아니라 503을 반환합니다. 최초 빈 DB와 준비된 제공처의 정상 0건은 구별합니다.
  빈 검색어는 AI를 호출하지 않고 이미 공개된 DB 스냅샷에서 최신순 최대 5개를 선정하므로 이후 Qdrant 장애에도
  목록을 유지합니다. 아직 공개 세대·지문이 없는 신규/미검증 제공처의 공고는 이 최신 목록에 포함하지 않습니다.
- POST 검색: JSON의 `query`는 비어 있지 않은 최대 500 UTF-16 코드 단위 문자열이고,
  `acceptingOnly`는 생략 시 `true`입니다. 명시한 값은 JSON 부울만 허용하며 `null`·문자열·숫자는 거부합니다.
  선택 객체 `companyConditions`에는 `region`(50), `industry`(100), `supportPurpose`(100),
  `establishedOn`(10) 또는 `foundedYear`(정수)를 넣을 수 있습니다. 설립연도는 1900부터 서울 기준 올해까지이며 정확한 설립일과 동시에 지정할 수 없습니다. 상한은 앞뒤 공백을 포함한 입력의 UTF-16 코드 단위입니다.
  조건 텍스트는 제어·제로폭 문자 등 Unicode C 범주를 거부한 뒤 trim하고 빈 값은 미입력으로 처리합니다.
  설립일은 실제 달력의 `YYYY-MM-DD`로 `1900-01-01`부터 서울 기준 오늘까지이며, 빈 문자열·ASCII 공백만
  있는 값은 미입력입니다. 공백이 붙은 날짜·timestamp·존재하지 않는 날짜는 400입니다.
  모든 조건이 미입력이면 기존 질의만 전송합니다. 조건이 있으면 `SupportProgramSearchService`가
  질의와 지역·업종·지원 목적의 값만 최대 1,000자 내부 검색문으로 만들어 후보 조회에 반영하고,
  `AiSupportProgramRankingFacade`는 원질의를 바꾸지 않고 별도의 `companyConditions`와 ISO `referenceDate`를
  점수화 요청에 전달합니다. 설립일·서울 기준일·표제는 후보 검색어에 넣지 않으며 사용자 질의의 날짜는 보존합니다.
  지역 정보가 없거나 다르다는 이유만으로 Core에서 후보를 제외하지 않습니다.
  조건은 계정·기업 DB에 저장하지 않으며, 공개 `query`는 trim한 원질의 그대로입니다. 로그인 복원을 위한
  임시 결과 스냅샷에는 이번 검색 조건을 함께 보관합니다.
  Web은 등록 기업이 있는 계정의 새 대화에서 기존 회사 조회 API로 소재지·업종·설립연도를 읽고 요청 조건에 포함합니다.
  Core 검색에서 계정 정보로 조건을 다시 덮어쓰지 않으므로 대화에서 명시적으로 수정·해제한 조건이 유지됩니다.
  대화 계약의 선택 foundedYear와 FOUNDED_YEAR 변경 필드를 지원하며 설립일/연도 변경·해제는 기존 반대 정밀도 값을 지웁니다.
  설립연도는 Ranking Facade가 AI에 그대로 전달하며 특정 월·일로 변환하지 않습니다.
  GET 검색·POST 검색·대화 조건 해석·원문 근거 질문은 같은 요청 제한을 공유합니다.
- 공개 검색 노출: GET·POST 모두 `Controller → SupportProgramSearchPreviewService → SupportProgramSearchService`로
  검색하며, 응답은 `{query, programs, totalCount, resultToken, expiresAt}`입니다. `totalCount`는 이번에 선정된
  최대 5개의 개수이며 전체 DB 공고 수가 아닙니다. 비로그인은 처음 2개만 받고, 일반 회원을 포함한 로그인 계정은
  최대 5개를 모두 받습니다. 숨겨진 공고의 ID·표제·URL·본문 등 실제 내용은 비로그인 응답에 포함하지 않습니다.
  비로그인 결과가 3개 이상일 때만 소문자 UUID `resultToken`과 UTC ISO-8601 `expiresAt`이 존재하고,
  나머지 경우 두 값은 `null`입니다. 기존 내부 검색과 일일 보고서·평가의 최대 5개 결과는 그대로 유지합니다.
- 로그인 결과 복원: 인증된 `POST /api/v1/support-programs/search/results`에 `{resultToken}`을 보냅니다.
  `Controller → SupportProgramSearchPreviewService → SupportProgramSearchResultRepository → Redis`에서
  보관된 원본 결과를 그대로 반환하며 검색·카탈로그 MySQL 조회·모델 호출을 다시 실행하지 않습니다.
  세션 인증은 기존 MySQL 경로를 유지합니다. 응답은 검색 응답에 `context: {query, acceptingOnly, companyConditions}`를 추가한
  형태이며, `resultToken`과 `expiresAt`은 `null`입니다. 조건 텍스트는 최초 검색에서 정규화한 값이고
  기업 조건 미입력 값은 `null`입니다. 빈 GET 검색은 응답 `query`가 `""`, 대화용 `context.query`가 `null`입니다.
  이 조회는 검색·해석·근거 질문의 AI 요청 제한을 소비하지 않습니다. 세션 쿠키가 있는 POST에는 기존과 같이
  허용된 `Origin` 또는 `Referer`가 필요합니다.
  최초 복원 시 토큰이 `account.id`에 귀속되며 같은 계정의 재시도는 동일 결과를 반환합니다. 미인증·유효하지 않은
  세션은 401, 다른 계정·만료·미존재 토큰은 모두 410 `SUPPORT_PROGRAM_SEARCH_RESULT_EXPIRED`입니다.
  결과와 조건은 Redis의 `govbiz:search-result:v1:{SHA-256(token)}` hash에 JSON으로 30분 보관합니다.
  TTL과 `expiresAt`은 Redis 시계 기준이며 조회·로그인으로 연장하지 않습니다. Lua로 최초 계정 연결을 원자적으로
  처리해 여러 Core 인스턴스의 동시 복원도 한 계정에만 귀속됩니다. 같은 Redis를 쓰면 Core 재시작 후에도 복원됩니다.
  기존 128건 조기 퇴거는 제거했습니다. Compose는 `128mb/noeviction`으로 메모리를 제한하고 개별 JSON은 최대 2MiB입니다.
  저장소 연결·타임아웃·용량·역직렬화 오류는 503 `SUPPORT_PROGRAM_SEARCH_RESULT_STORE_UNAVAILABLE`로 반환하며,
  메모리 fallback이나 자동 재검색은 없습니다. 회원 검색 또는 2건 이하의 비회원 결과는 Redis를 사용하지 않습니다.
  대화 기록 원본·회원 세션·공고는 계속 MySQL에 저장합니다. 첫 검색의 AI 점수화 속도를 높이는 캐시 변경은 아닙니다.
  GET·POST 검색과 복원은 성공·오류 응답에 모두 `Cache-Control: no-store`를 사용합니다.

  Compose는 Redis 8.2.9와 `redis-data` AOF 볼륨을 추가합니다. `appendfsync everysec`이므로 비정상 종료 시
  최근 약 1초의 저장/계정 연결이 유실될 수 있고, 복제·자동 failover·강한 내구성을 제공하지 않습니다.
  TTL은 조회 가능한 기간입니다. 만료가 AOF·백업의 물리적 즉시 삭제를 보장하지 않으므로 디스크 접근 권한과 정리 정책도 관리해야 합니다.
  `SupportProgramSearchResultRedisConfig`는 Lettuce 전용 DNS 캐시를 최대 5초로 제한해 Redis 교체 후 IP 변경을
  재연결에서 반영합니다. JVM 전역 DNS나 외부 HTTP 클라이언트 설정은 바꾸지 않습니다.
  직접 Core를 실행할 때는 Redis를 별도로 준비하고 `REDIS_HOST`/`REDIS_PORT`를 지정합니다(기본 `127.0.0.1:6379`).
  연결/명령 제한은 `REDIS_CONNECT_TIMEOUT`/`REDIS_TIMEOUT`(기본 1초), 외부 운영 Redis의 인증·TLS는
  `REDIS_USERNAME`/`REDIS_PASSWORD`/`REDIS_SSL_ENABLED`로 주입합니다. 로컬 Compose의 Redis는 무인증 내부망 전용이며
  호스트 포트를 열지 않습니다. 운영에는 네트워크 격리·ACL·TLS·메모리/AOF 감시가 별도로 필요합니다.
- 자격 검토: 조건 유무와 관계없이 점수화 계약은 `govbiz-support-program-ranking-v5`입니다.
  저장된 공식 API 본문 `summary` 최대 6,000, 지원대상 `targetDescription` 최대 2,000 Unicode code point를
  AI에 전달합니다. 둘 중 하나라도 잘리면 `sourceTextTruncated=true`이며 대상·지역 모두 `UNKNOWN`만 허용합니다.
  태그의 지역·분야는 후보 검색 보조 정보이고 자격 충족 근거로 인용할 수 없습니다.
  AI 응답의 대상·지역 판정에는 설명(1~160자)과 근거 배열(0~1개)이 필요하며 `MATCH`는 근거 1개가 필수입니다.
  근거는 `SUMMARY` 또는 `TARGET_DESCRIPTION`에서 실제 전송된 문장의 정확한 부분 문자열(1~240자)만 인정합니다.
  설명·인용의 상한은 Unicode code point이고 제어·제로폭 문자 등 Unicode C 범주는 거부합니다.
  원문에 없는 인용·누락된 검토·불충족 `INCOMPATIBLE`·잘못된 정렬은 정상 추천으로 숨기지 않고 내부 계약 오류로 반환합니다.
  관련도는 `2 × (semanticRelevance + supportTypeFit)`로 계산하며 자격 `UNKNOWN`을 감점하지 않습니다.
  의미 관련성 20/40점 이상, 명백한 자격 불일치 제외 후 관련도순으로 최대 5개입니다. 기존 총점 60점 컷과 MATCH 우선은 제거했습니다.
  자연어 검색 결과의 `eligibilityReview`는 전체 상태 `MATCH`/`REVIEW_REQUIRED`, 기준 `OFFICIAL_API_TEXT`,
  대상·지역별 `status`, `explanation`, `evidence[{field,quote}]`를 추천 이유와 별도로 반환합니다.
  이는 HTML을 정리한 **공식 API 본문 기준**의 검토이며 상세 페이지 전체·첨부 PDF/HWP를 확인했다는 뜻이 아닙니다.
  최신 목록·상세의 `eligibilityReview`는 `null`입니다. 자격 검토는 검색 결과에만 존재하며 DB에 저장하지 않습니다.
- 검색 준비 상태: `readiness`는 필수 `sources` 배열로 제공처별 저장 공고 수·색인 준비·동기화 성공/실패를
  반환합니다. 전체 공고 수는 검색 가능한 제공처의 합계이고 `indexReady`는 한 제공처 이상 준비되었는지입니다.
  `SEARCHABLE_WITH_PARTIAL_SOURCES`는 일부만 준비된 상태이며 검색은 준비된 범위에서 가능합니다.
  `SEARCHABLE`은 공고 수가 0인 성공 스냅샷도 포함하며,
  `SEARCHABLE_WITH_SYNC_FAILURE`은 이전 스냅샷은 검색 가능하지만 최신 수집·사전 색인 시도가 실패한 경우입니다.
  `PREPARING`은 공개 공고 없는 초기 상태 또는 결과가 아직 없는 첫 동기화이고, `UNAVAILABLE`은 현재
  공개 스냅샷의 색인 준비가 확인되지 않은 경우입니다. 상태 행 없는 현재 공고의 제공처도 `UNAVAILABLE`로
  표시합니다. 초기 빈 DB에는 `BIZINFO`와 각각 수집을 활성화한 `KSTARTUP`·`MSIT`·`CNTRADE_NOTICE`를 포함합니다.
  시각은 `Asia/Seoul` 오프셋을 포함한 ISO-8601 문자열입니다.
- 상세: 필수 `sourceCode`는 `[A-Z][A-Z0-9_]{0,63}` 형식, `sourceProgramId`는 최대 255자이며 공백만 있는 값은 허용하지
  않습니다. 현재 노출된 행만 반환하며, 없는·미노출 공고는 404입니다. 검색 문맥이 없으므로 추천 이유는
  빈 배열, 추천 점수는 `null`입니다.
- 원문 근거 질문: `sourceCode`, `sourceProgramId`, 최대 500자의 `question`을 JSON body로 보냅니다. 현재 공개된
  `BIZINFO` 공고에만 제공하며, 사용자가 이 endpoint를 호출했을 때만 공식 HTTPS 상세 HTML을 수집합니다.
  MySQL 원문 캐시가 같은 URL로 6시간 이내면 재사용하고, 아니면 읽기 가능한 텍스트를 검증·저장한 뒤 최대 50개
  결정적 청크를 별도 Qdrant evidence 컬렉션에서 검색합니다. 같은 공고 ID·검증된 내용 해시의 불변 청크는
  Core 인스턴스에서 최근 사용한 최대 32개 공고까지 재사용합니다. 원문 최신성·공개 상태와 AI 색인·검색 검증은
  계속 수행하며, 갱신 실패 시 이전 청크로 답하지 않습니다. 답변은 `ANSWERED`(공식 원문 인용 1개 이상) 또는
  `INSUFFICIENT_EVIDENCE`(인용 없음)와 최대 5개 인용 발췌·공식 URL·청크 순서를 반환합니다. 첨부파일·PDF·OCR·다른
  제공처 원문은 지원하지 않습니다. 공식 원문 수집 실패는 503, 지원하지 않는 현재 제공처는 422입니다.
  상세 URL의 리디렉션은 매번 공식 HTTPS 호스트와 같은 `pblancId`인지 검증하며 최대 3회 따릅니다.
  HTML은 jsoup `1.23.2`로 파싱하고 `.support_project_detail`의 제목이 요청한 공고와 일치할 때
  `.view_cont` 본문만 추출합니다. 인용에는 검색된 청크 전체를 반환하며 청크당 최대 1,500 UTF-16 코드 단위입니다.
- 수집기는 `BIZINFO`·`KSTARTUP`·`MSIT`·`CNTRADE_NOTICE`이며 기업마당 외 수집기는 명시적으로 켜야 합니다. 자연어 검색·평가 fixture/capture는
  `findSearchablePresent`의 제공처 상태 JOIN으로 `index_ready=true`인 공고만 읽고, 색인 복구는
  미준비 공고도 제공처별로 처리합니다. 최신 목록은 `findPublishedPresent`로 공개된 스냅샷만 읽되
  이후 색인 장애와 분리합니다. 내부 식별자 `sourceCode:sourceProgramId`로 같은 원본 ID를 구분합니다.
  K-Startup도 같은 벡터 색인과 자연어 추천·필터·상세 조회를 사용합니다. 별도 공식 HTML 원문 질문은 기업마당만 지원합니다.

제공처별 복구 실패 격리와 구현/미구현 범위는 [6단계 다중 제공처 준비](../../docs/support-program-multi-source-preparation.md)에 정리합니다.

요청·응답 JSON과 상세 오류 계약은 [지원사업 API 계약](../../docs/support-program-search-contract.md),
SampleItem 예제는 [별도 계약](../../docs/sample-item-contract.md)에 있습니다.

## 설정

### 과기정통부·충청남도 수출입공지

- `MsitSupportProgramCatalogSyncService`와 `CnTradeNoticeSupportProgramCatalogSyncService`는 각각의
  구체 Facade/Client에서 전체 페이지를 검증한 뒤 기존 `SupportProgramIndexSyncService`로 색인하고
  `SupportProgramRepository`에서 해당 출처만 공개합니다. 중간 수집·색인 실패는 기존 스냅샷을 유지합니다.
- `MSIT_SYNC_ENABLED`와 `CNTRADE_NOTICE_SYNC_ENABLED`는 기본 `false`입니다. 각각 활용 승인과 최초
  임베딩 비용을 확인한 뒤 켭니다. 전용 `MSIT_API_KEY`/`CNTRADE_NOTICE_API_KEY`를 생략하면
  `DATA_GO_KR_SERVICE_KEY`를 사용합니다. 같은 키라도 API 활용 승인은 각각 필요합니다.
- 두 출처의 `*_API_BASE_URL` 기본값은 `https://apis.data.go.kr`, 연결/응답 제한시간은 `2s`/`20s`,
  `*_SYNC_INITIAL_DELAY`/`*_SYNC_FIXED_DELAY`는 `PT0S`/`PT6H`입니다.
- MSIT는 `businessAnnouncMentList`의 공식 상세 URL에 있는 `nttSeqNo`를 ID로 사용합니다.
  실응답이 페이지 크기를 10건으로 제한하므로 전체 수집에 시간이 걸립니다. 별도 스케줄러로 기존 수집과 격리합니다.
  API가 본문·접수 기간·지역·분야를 제공하지 않아 제목·담당 부서 기반으로 검색하며 신청 자격은 원문 확인이 필요합니다.
- CNTRADE_NOTICE는 `getNotiList`의 `lbbNo`가 ID이며 API 본문을 보존합니다. 지원사업뿐 아니라
  일반 수출입 공지도 포함합니다. API에 개별 상세 URL이 없어 확인된 **공식 공지 목록**을 제공하며 제목으로 찾습니다.
- 두 출처 모두 게시일을 접수일로 간주하거나 기관명으로 지역을 추정하지 않습니다. 접수 상태는 `UNKNOWN`,
  지역·분야는 빈 배열입니다. 필터 검색은 `ALL`/`UNKNOWN`에서, AI 검색은 접수 중 제한을 해제한 경우에 조회할 수 있습니다.
  K-Startup 전용 필터와 기업마당 전용 원문 추가 질문은 확장하지 않습니다.
- 2026-09-09 실호출 확인: MSIT 1·2페이지 성공(전체 4,248건 메타데이터). CNTRADE_NOTICE는 HTTP 200의
  `04 HTTP_ERROR`를 반환해 실제 수집은 미확인입니다. 문서 기반 스텁 통과를 실제 제공처 정상 동작으로 간주하지 않습니다.

공식 명세: [과기정통부 사업공고](https://www.data.go.kr/data/15074634/openapi.do),
[충청남도 수출입공지](https://www.data.go.kr/data/15097093/openapi.do).

기본값의 기준은 [`application.properties`](src/main/resources/application.properties)입니다.
Compose는 일부 주소·CORS 값을 내부 네트워크에 맞게 덮어씁니다.

| 환경변수 | 기본값 | 용도 |
|---|---|---|
| `SPRING_DATASOURCE_URL` | `jdbc:mysql://127.0.0.1:3306/govbiz` | MySQL JDBC 주소 |
| `SPRING_DATASOURCE_USERNAME` | `govbiz` | MySQL 사용자 |
| `SPRING_DATASOURCE_PASSWORD` | `govbiz-local` | 로컬 개발용 MySQL 비밀번호 |
| `SUPPORT_PROGRAM_REQUEST_PER_CLIENT_PER_MINUTE` | `6` | 검색·대화 조건 해석·근거 답변의 접속 주소별 최근 60초 한도 |
| `SUPPORT_PROGRAM_REQUEST_GLOBAL_PER_MINUTE` | `60` | 한 Core 프로세스의 검색·근거 답변 최근 60초 한도 |
| `SUPPORT_PROGRAM_REQUEST_MAX_CONCURRENT` | `4` | 검색·근거 답변 동시 처리 한도 |
| `DATA_GO_KR_SERVICE_KEY` | 빈 값 | 기업마당 수집용 공공데이터포털 키 |
| `KSTARTUP_API_KEY` | 빈 값 | K-Startup 조회서비스 활용 승인을 받은 공공데이터포털 키 |
| `KSTARTUP_API_BASE_URL` | `https://apis.data.go.kr` | K-Startup API origin |
| `KSTARTUP_API_CONNECT_TIMEOUT` / `KSTARTUP_API_READ_TIMEOUT` | `2s` / `10s` | K-Startup 외부 호출 제한시간 |
| `KSTARTUP_SYNC_SCOPE` | `RECENT_YEAR` | API에 1년 전 날짜 조건 전달. `RECENT_THREE_MONTHS`는 3개월 전, `OPEN`은 API 모집 중 공고만. 실응답에는 장기 공고도 포함될 수 있음 |
| `KSTARTUP_SYNC_ENABLED` | `false` | 최초 임베딩 비용 확인 뒤 활성화 |
| `KSTARTUP_SYNC_INITIAL_DELAY` / `KSTARTUP_SYNC_FIXED_DELAY` | `PT0S` / `PT6H` | 첫 수집 지연 / 완료 후 다음 수집 지연 |
| `ACCOUNT_SESSION_TTL` | `P30D` | "로그인 상태 유지"를 켠 세션의 절대 만료 기간 |
| `ACCOUNT_SESSION_SHORT_TTL` | `PT12H` | "로그인 상태 유지"를 끈 세션의 절대 만료 기간. 쿠키는 브라우저 세션 쿠키 |
| `ACCOUNT_SESSION_IDLE_TTL` | `P7D` | 마지막 사용 뒤 세션을 끝내는 유휴 기간 |
| `ACCOUNT_JWT_SECRET` | 없음(필수) | 세션 JWT HS256 서명 비밀키(32자 이상). 코드에 기본값이 없어 비어 있으면 기동 실패. Compose·`.env.example`은 로컬 개발용 값을 넣음 |
| `ACCOUNT_COOKIE_SECURE` | `true` | 세션 쿠키 `Secure` 속성. HTTPS가 없는 로컬 개발에서만 `false` |
| `ACCOUNT_DEV_LOGIN_ENABLED` | `false` | `true`이면 `POST /api/v1/auth/dev-login`이 등록되어 비밀번호 없이 시드 계정 세션 발급 |
| `ACCOUNT_DEV_LOGIN_EMAIL` | `admin@govbiz.local` | 개발용 관리자 시드 계정 이메일. 없으면 ADMIN 역할·이메일 인증 완료로 생성 |
| `ACCOUNT_DEV_LOGIN_MEMBER_EMAIL` | `member@govbiz.local` | `{"role":"USER"}`로 부를 때 쓰는 회원 시드 계정 이메일 |
| `ACCOUNT_DEV_LOGIN_PASSWORD` | `govbiz-admin1` | 시드 계정 생성 시 저장하는 비밀번호 |
| `ACCOUNT_PASSWORD_RESET_MAIL_ENABLED` | `false` | 비밀번호 재설정 메일 SMTP 전송. 꺼져 있으면 `ACCOUNT_DEV_LOGIN_ENABLED`가 켜진 환경에서만 링크를 WARN 로그로 남기고, 아니면 503 |
| `ACCOUNT_PASSWORD_RESET_FROM` | 빈 값 | 재설정 메일 발신 주소. 메일을 켜면 필수 |
| `ACCOUNT_PASSWORD_RESET_FRONTEND_BASE_URL` | `http://127.0.0.1:5173` | 메일 링크(`/reset-password#token=`)의 프런트 origin |
| `ACCOUNT_PASSWORD_RESET_TOKEN_TTL` | `PT30M` | 재설정 토큰 유효 시간 |
| `ACCOUNT_PASSWORD_RESET_MAX_REQUESTS_PER_HOUR` | `3` | 계정당 시간당 요청 한도 |
| `ACCOUNT_EMAIL_VERIFICATION_MAIL_ENABLED` | 재설정 메일 값 | 회원가입 인증번호 메일 SMTP 전송. 따로 주지 않으면 `ACCOUNT_PASSWORD_RESET_MAIL_ENABLED`를 물려받고, 꺼져 있으면 개발용 로그인 환경에서만 인증번호를 WARN 로그로 남김 |
| `ACCOUNT_EMAIL_VERIFICATION_FROM` | 재설정 메일 값 | 인증번호 메일 발신 주소. 따로 주지 않으면 `ACCOUNT_PASSWORD_RESET_FROM` |
| `ACCOUNT_EMAIL_VERIFICATION_CODE_TTL` | `PT10M` | 6자리 인증번호 유효 시간(최대 1시간) |
| `ACCOUNT_EMAIL_VERIFICATION_PASS_TTL` | `PT30M` | 인증을 마친 뒤 가입을 끝내야 하는 시간 |
| `ACCOUNT_EMAIL_VERIFICATION_RESEND_COOLDOWN` | `PT1M` | 같은 이메일로 다시 보낼 수 있기까지의 대기 시간 |
| `ACCOUNT_EMAIL_VERIFICATION_SEND_WINDOW` / `_MAX_SENDS_PER_WINDOW` | `PT10M` / `3` | 발송 횟수를 세는 창과 그 안의 최대 발송 수 |
| `ACCOUNT_EMAIL_VERIFICATION_MAX_ATTEMPTS` | `5` | 인증번호 하나에 허용하는 입력 시도 수 |
| `ACCOUNT_OAUTH_CALLBACK_BASE_URL` | `http://127.0.0.1:5173` | 브라우저가 `/api`에 닿는 origin. 공급자 콘솔 Redirect URI = 이 값 + `/api/v1/auth/oauth/{kakao\|google}/callback` |
| `ACCOUNT_OAUTH_FRONTEND_BASE_URL` | `http://127.0.0.1:5173` | 소셜 로그인 뒤 돌아갈 프런트 origin(`/oauth/complete`, 실패는 `/login?oauthError=`) |
| `ACCOUNT_OAUTH_GOOGLE_CLIENT_ID` / `…_SECRET` | 빈 값 | Google 웹 애플리케이션 클라이언트. 둘 다 있어야 켜짐 |
| `ACCOUNT_OAUTH_KAKAO_CLIENT_ID` / `…_SECRET` | 빈 값 | 카카오 REST API 키·Client Secret. 둘 다 있어야 켜짐 |
| `ACCOUNT_OAUTH_KAKAO_ADMIN_KEY` | 빈 값 | 연결 해제 어드민 키. 없으면 FAILED를 기록하고 같은 카카오 계정 재가입 차단 유지 |
| `ACCOUNT_OAUTH_UNLINK_ENABLED` / `ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED` | true / false (Compose true / true) | DB 연결 해제 worker 실행 / RabbitMQ 전달 모드 |
| `ACCOUNT_OAUTH_CONNECT_TIMEOUT` / `ACCOUNT_OAUTH_READ_TIMEOUT` | `2s` / `10s` | 공급자 호출 제한시간 |
| `BIZNO_API_KEY` | 빈 값 | 기업 등록 시 사업자등록번호를 확인하는 Bizno API 키. 비어 있으면 조회·등록이 503 `BIZNO_NOT_CONFIGURED` |
| `BIZNO_URL` | `https://bizno.net/api/fapi` | Bizno 조회 endpoint |
| `BIZNO_API_CONNECT_TIMEOUT` / `BIZNO_API_READ_TIMEOUT` | `2s` / `10s` | Bizno 연결·응답 제한시간 |
| `BIZINFO_API_BASE_URL` | `https://apis.data.go.kr` | 기업마당 API 주소 |
| `BIZINFO_API_CONNECT_TIMEOUT` | `2s` | 기업마당 연결 제한시간 |
| `BIZINFO_API_READ_TIMEOUT` | `10s` | 기업마당 응답 제한시간 |
| `BIZINFO_SOURCE_DOCUMENT_BASE_URL` | `https://www.bizinfo.go.kr` | RestClient 기본 origin. 실제 요청은 검증된 공고 `sourceUrl`의 절대 URI를 사용하므로 이 값으로 요청 주소를 변경하지 않음 |
| `BIZINFO_SOURCE_DOCUMENT_CONNECT_TIMEOUT` | `2s` | 공식 원문 연결 제한시간 |
| `BIZINFO_SOURCE_DOCUMENT_READ_TIMEOUT` | `10s` | 공식 원문 응답 제한시간 |
| `BIZINFO_SYNC_ENABLED` | `true` | 기업마당 수집·색인 준비·DB 공개 작업 실행 여부 |
| `BIZINFO_SYNC_INITIAL_DELAY` | `PT0S` | 첫 수집 작업까지의 지연 |
| `BIZINFO_SYNC_FIXED_DELAY` | `PT6H` | 이전 수집 작업 종료 후 다음 실행까지의 지연 |
| `AI_SERVICE_BASE_URL` | `http://127.0.0.1:8000` | 내부 AI Service 주소 |
| `AI_SERVICE_CONNECT_TIMEOUT` | `1s` | AI Service 연결 제한시간 |
| `AI_SERVICE_READ_TIMEOUT` | `35s` | AI Health·대화 조건 해석·원문 근거 답변 응답 제한시간 |
| `AI_COMBINATION_REVIEW_READ_TIMEOUT` | `75s` | 중복 지원·수혜 분석 전용 응답 제한시간 |
| `AI_RANKING_READ_TIMEOUT` | `55s` | 지원사업 최종 점수화 전용 응답 제한시간 |
| `AI_SEMANTIC_SEARCH_READ_TIMEOUT` | `30s` | 의미 검색·색인 응답 제한시간 |
| `ELASTICSEARCH_BASE_URL` | `http://127.0.0.1:9200` | 호스트 실행 시 키워드 색인·검색 주소. Compose는 `http://elasticsearch:9200`으로 고정 |
| `ELASTICSEARCH_INDEX_NAME` | `govbiz-support-program-lexical-v2` | 단일 키워드 인덱스 이름. v1에서 전환 시 새 인덱스·재색인 필요 |
| `ELASTICSEARCH_API_KEY` | 빈 값 | 선택 API Key. 개발 Compose는 인증 비활성이며 실제 키는 secret으로 주입 |
| `ELASTICSEARCH_CONNECT_TIMEOUT` / `ELASTICSEARCH_READ_TIMEOUT` | `2s` / `10s` | ES 연결·읽기 제한시간 |
| `SUPPORT_PROGRAM_INDEX_ENABLED` | `true` | 현재 공고의 Elasticsearch·Qdrant 확인·복구 여부. 새 공고 공개 전 필수 색인은 유지 |
| `SUPPORT_PROGRAM_INDEX_INITIAL_DELAY` | `PT0S` | 첫 키워드·벡터 색인 복구까지의 지연 |
| `SUPPORT_PROGRAM_INDEX_FIXED_DELAY` | `PT1M` | 이전 복구 작업 종료 후 다음 실행까지의 지연 |
| `APP_CORS_ALLOWED_ORIGIN` | `http://localhost:5173` | 허용할 Web origin |

추천 점수화만 AI 모델 `45s`·Agent 실행 `50s`·Core 읽기 `55s`로 제한합니다.
`AiServiceClientProperties.rankingReadTimeout`과 전용 `aiRankingRestClient`를 사용하며
`HttpAiSupportProgramRankingClient`에만 주입합니다. 공유 `aiServiceRestClient`의 `35s`와
의미 검색·색인의 `aiSemanticSearchRestClient` `30s`는 유지합니다. 대화 조건 해석·원문 근거 답변의
AI 모델·Agent 제한도 기존 `25s`·`30s`이며 Health와 함께 공유 Core 제한을 사용합니다.
중복 검토는 AI 모델 `60s`·Agent 실행 `70s`보다 긴 `aiCombinationReviewRestClient` `75s`를 사용합니다.
검색은 ES 키워드 검색 → 의미 검색 → 점수화를 순서대로 호출합니다. 각 Core 읽기 제한은
`10s`·`30s`·`55s`이며, 브라우저 제한은 기존 `90s`를 유지합니다. 따라서 모든 단계의 최대 대기시간을
보장하지 않으며 브라우저가 먼저 취소할 수 있습니다. 이 값은 요청 제한이며 응답시간 목표가 아닙니다.
AI의 HTTP 504나 Core 읽기 시간 초과는 기존대로 `TIMEOUT → 504 AI_SERVICE_TIMEOUT`으로 전달하며
빈 결과·일반 장애로 바꾸지 않습니다. 후보 수·모델·프롬프트·원문 자격 판단 계약은 바꾸지 않습니다.

`SUPPORT_PROGRAM_INDEX_ENABLED=false`는 별도 복구 스케줄러만 끕니다. 새 카탈로그 공개 전의 필수
색인은 계속 실행됩니다. 두 스케줄러는 각각 별도의 단일 스레드에서 실행되며 실패를 기록한 뒤
다음 주기에 다시 시도합니다. 현재 공개된 수동 동기화 HTTP API는 없습니다.

### 예산을 지정한 일회성 수집

`catalog-sync-once` 프로필은 HTTP 서버 없이 선택한 제공처를 한 번 수집하고 종료합니다. 일반 API 서버의
자동 수집/색인 복구 플래그는 계속 `false`로 유지합니다. 이 프로필에서는 초기화 단계에 모든 수집·복구·큐·메일
예약 작업과 Flyway를 강제로 끄므로, 이미 migration이 완료된 DB에만 실행해야 합니다.

```bash
java -Djdk.httpclient.disableRetryConnect=true -Djdk.httpclient.redirects.retrylimit=1 \
  -jar application.jar --spring.profiles.active=catalog-sync-once \
  --app.catalog-sync-once.sources=BIZINFO,KSTARTUP,MSIT \
  --app.catalog-sync-once.max-usd=1.00 \
  --app.catalog-sync-once.receipt-path=/persistent/catalog-initial.receipt
```

기본값은 **무료 사전 검사**(`apply=false`)입니다. 각 제공처 전체 페이지를 기존 Client/Facade로 검증하고,
실제 색인 입력의 UTF-8 바이트 수와 문서당 8,191 토큰 상한으로 보수적인 임베딩 비용 상한을 계산합니다.
`text-embedding-3-small`의 [공식 표준 입력 단가](https://developers.openai.com/api/docs/models/text-embedding-3-small)
$0.02/백만 토큰(2026-09-15 확인)을 사용하며, 허용 예산은
0 초과 $1 이하입니다. 실행 전 대상 AI Service가 이 모델·1536차원과 SDK `max_retries=0`을 사용하는지 확인해야 합니다.
다른 모델·요금 또는 별도 검색/답변 호출의 비용까지 제한하는 계정 전체 예산 기능은 아닙니다.
위 JVM 옵션은 [JDK HTTP Client의 자동 재전송](https://docs.oracle.com/en/java/javase/21/docs/api/java.net.http/module-summary.html)을
막아 같은 임베딩 요청이 네트워크 장애로 중복 실행되지 않도록 합니다. 예산을 제한한 실행에서는 생략하지 않습니다.

승인된 적용은 같은 명령에 `--app.catalog-sync-once.apply=true`를 추가합니다. 모든 선택 제공처의 전체 수집과
합산 비용 검사가 끝나기 전에는 DB/색인을 변경하거나 유료 API를 호출하지 않습니다. 검사한 동일 스냅샷을
제공처별 `색인 → Repository의 원자적 공개` 순서로 반영하며, 중간 실패 시 실패한 제공처의 기존 공개 목록은 유지합니다.
먼저 성공한 제공처까지 되돌리지는 않습니다. 실패를 정상 완료로 숨기거나 자동 재시도하지 않습니다.

영속 디렉터리의 receipt를 **배타적으로 생성하고 디스크에 동기화한 뒤** 적용을 시작합니다. 완료·실패·강제 중단 모두
같은 기록 경로로 다시 실행할 수 없습니다. Docker에서는 호스트 디렉터리를 마운트하고 `--restart=no`를 사용합니다.
기록을 삭제하거나 새 경로로 재실행하면 추가 과금될 수 있으므로, 기존 지출 확인과 새 승인이 필요합니다.
자동 수집을 계속 꺼두면 신규·수정 공고는 다음 수동 수집 전까지 반영되지 않습니다.

기업마당 키는 Encoding·Decoding 형식 모두 받을 수 있으며 Client가 요청 전에 정규화합니다.
목록 DTO는 검색·저장에 사용하는 원본 필드만 디코딩합니다. 사용하지 않는 신청 방법
(`reqstMthPapersCn`) 필드는 무시하며, 실제 사용하는 필드와 페이지 완전성 검증은 유지합니다.
실제 인증키·운영 DB 비밀번호는 환경변수로 주입하고 Git에 기록하지 않습니다. OpenAI 키는
Core API가 아닌 AI Service에만 설정합니다.

## 코드 구조

기본 패키지는 `ai.govbiz.core`, Gradle 프로젝트명은 `govbiz-core-service`입니다.

```text
supportprogram/
├── controller            # 공개 HTTP 진입점
│   └── dto               # 공개 요청·응답 계약
├── service/
│   ├── search             # DB 조회 → 의미·키워드 순위 결합 → AI 점수화
│   ├── conversation       # 대화 변경 인용 검증·초안 병합·확정 조건 대비 변경 계산
│   ├── detail             # 현재 공고 상세 조회
│   ├── saved              # 회원의 관심 공고함(담기·빼기·목록)
│   ├── readiness          # 제공처별 준비 상태와 전체 검색 범위 집계
│   ├── evidence           # 공식 원문 캐시·청킹 → 근거 검색·답변
│   ├── sync               # 수집·두 색인 준비·DB 공개와 별도 키워드/벡터 복구
│   ├── evaluation         # 비웹 fixture 내보내기·검색 품질 평가 캡처 프로필
│   └── dto                # 검증된 내부 실행 결과
├── facade                 # 기업마당 수집·공식 원문·AI 응답 검증·도메인 변환
├── client/
│   ├── bizinfo            # 기업마당 HTTP·목록/공식 HTML 검증·외부 DTO 정규화
│   ├── kstartup           # K-Startup 페이지 검증·공식 상세 URL·원문 대상·전용 분류 정규화
│   ├── elasticsearch      # Nori·BM25 색인/검색 HTTP, DTO·Mapper·설정·예외
│   └── ai                 # AI 내부 HTTP 계약·조건 해석·공고/원문 청크 색인과 답변
├── repository            # 도메인↔DB 행 변환·트랜잭션·저장·조회
│   └── mapper            # MyBatis Mapper, DbRow
├── domain                 # 업무 모델·서울 날짜 기준 접수 상태 규칙
└── helper                 # 지원사업 하위 흐름이 함께 쓰는 보조 작업
account/
├── controller            # 로그인·로그아웃·내 계정, 개발용 로그인, 기업 등록·수정 HTTP 진입점
│   └── dto               # 공개 요청·응답 계약
├── service               # 회원가입, 로그인 검증·시도 제한, JWT 세션, 소셜 로그인, 비밀번호 변경·계정 삭제, 기업 등록(사업자등록번호 조회)
├── client/bizno          # Bizno 사업자등록번호 조회 HTTP·응답 검증·오류 변환
├── client/oauth          # 카카오·Google 인가 주소·코드 교환·ID 토큰 클레임 확인, 카카오 연결 끊기
├── repository            # 계정·세션·소셜 로그인 연결·기업 저장과 조회, DbRow 변환
│   └── mapper            # MyBatis Mapper, DbRow
├── domain                # 계정·역할·세션·소셜 로그인 공급자·기업 업무 모델
├── helper                # HS256 JWT 발급·검증·해시, 세션·소셜 로그인 상태 쿠키 발급·읽기, 이메일 정규화
├── web                   # Account 파라미터 resolver, Origin 검사 interceptor와 MVC 등록
└── config                # BCrypt, 세션·개발 로그인·소셜 로그인 설정
partner/
├── controller            # 파트너 모집글 목록·상세·작성, 제안 보내기·수락·거절·철회, 제안함 HTTP 진입점
│   └── dto               # 공개 요청·응답 계약
├── service               # 작성·제안 조건(기업 등록·공고 접수 중·마감일·공고당 하나·당사자) 확인과 조회
├── repository            # 모집글·제안 저장, 기업·계정·공고 조인 조회, 검색·필터·정렬·페이지, 제안 수
│   └── mapper            # MyBatis Mapper, DbRow
└── domain                # 모집글·제안·역할 업무 모델, 조회 시점 모집·제안 상태 계산
_health                    # Core API Health
_health_ai_service         # AI Service Health의 Controller → Service → Client
_sampleitem                # 학습 예제
_common                    # 실제 공유하는 HTTP·AI 설정·JSON·CORS·서울 기준 시계·오류 처리
```

외부 호출의 기본 흐름은 `Controller → Service → Facade → Client`입니다. Facade는 하위 호출·검증·변환을
묶을 때 사용하며, DB 접근은 `Service → Repository → MyBatis Mapper → Mapper XML → MySQL`입니다.
Facade와 Domain은 MyBatis Mapper를 직접 호출하지 않습니다.

| 타입 | 소유 위치·역할 |
|---|---|
| `Request`, `Response` | 공개 HTTP 계약은 해당 기능의 `controller/dto` |
| 외부 `Request`, `Payload` | 상대 시스템별 `client/dto` |
| `Result` | 검증된 실행 결과는 `service/dto` |
| 업무 모델 | 프레임워크에 의존하지 않는 `domain` |
| `DbRow` | `repository/mapper`의 DB 행 타입. Repository 밖으로 노출하지 않음 |
| `Helper` | 실제 반복 보조 작업. 특정 기능의 하위 흐름이 함께 쓰면 해당 기능의 `helper`, 둘 이상의 기능이 함께 쓰면 `_common/helper` |

SQL은 [`SupportProgramMapper.xml`](src/main/resources/mybatis/supportprogram/repository/SupportProgramMapper.xml)에
명시하며 JPA·JdbcClient·annotation SQL을 혼용하지 않습니다. Repository가 JSON 배열과 DbRow를
변환하고 `SupportProgramStatusResolver`를 호출합니다. 상세 규칙은 [AGENTS.md](../../AGENTS.md)를 따릅니다.

## 데이터 관리와 오류 처리

- Flyway [V1](src/main/resources/db/migration/V1__create_support_program.sql)은 공고 테이블,
  [V2](src/main/resources/db/migration/V2__add_support_program_sync_generation.sql)는 최신 수집 시작 세대,
  [V3](src/main/resources/db/migration/V3__create_support_program_source_document.sql)는 공고별 공식 원문
  테이블, [V4](src/main/resources/db/migration/V4__create_support_program_sync_status.sql)는 공개 스냅샷의
  세대·지문·공고 수·색인 준비와 최근 동기화 결과,
  [V5](src/main/resources/db/migration/V5__create_account.sql)는 계정과 세션 테이블,
  [V6](src/main/resources/db/migration/V6__create_company.sql)는 계정당 하나인 기업 테이블(사업자번호 UNIQUE),
  [V7](src/main/resources/db/migration/V7__add_support_program_startup_details.sql)은 K-Startup 전용 분류 JSON과 형식·제공처 제약,
  [V8](src/main/resources/db/migration/V8__create_partner_recruitment.sql)은 계정·기업·공고에 묶인 파트너 모집글 테이블,
  [V9](src/main/resources/db/migration/V9__create_partner_proposal.sql)은 모집글과 제안 계정·기업에 묶인 파트너 제안 테이블,
  [V10](src/main/resources/db/migration/V10__create_combination_review.sql)은 중복 검토 건과 선택 사업,
  [V11](src/main/resources/db/migration/V11__create_combination_review_run.sql)은 실행 스냅샷과 원본 파일 테이블,
  [V12](src/main/resources/db/migration/V12__create_daily_report.sql)는 일일 리포트 구독·발송 테이블,
  [V13](src/main/resources/db/migration/V13__create_company_partner_profile.sql)은 기업당 하나인 협업·파트너 설정 테이블,
  [V14](src/main/resources/db/migration/V14__create_account_password_reset.sql)는 비밀번호 재설정 토큰 해시 테이블,
  [V17](src/main/resources/db/migration/V17__create_account_oauth_identity.sql)은 소셜 로그인 연결 테이블(`(provider, subject)`
  UNIQUE)을 만들고 소셜로만 가입한 계정을 위해 `account.password_hash`를 nullable로 바꿉니다.
  적용된 migration은 수정하지 않고 새 버전을 추가합니다.
- 전체 수집·검증·색인이 끝난 뒤 최신 시작 세대만 공개합니다. 해당 제공처 행 미노출 처리와 UPSERT를
  하나의 짧은 DB transaction으로 묶고, 같은 transaction에서 스냅샷 지문·공고 수·`indexReady=true`·성공
  시각을 기록합니다. 외부 HTTP 호출은 transaction 밖에서 수행합니다.
- 수집 또는 공개 전 필수 색인이 실패하면 현재 세대일 때만 실패 시각을 기록합니다. 이때 이전 공개 스냅샷의
  공고·색인 준비 상태는 바꾸지 않습니다. 별도 복구가 실패하면 자신이 읽어 색인한 세대·지문·공고 수와 상태 행이
  여전히 일치할 때만 `indexReady=false`로 바꿉니다. 복구 성공도 같은 조건에서만 준비 완료를 기록합니다.
- 복구는 제공처별로 벡터를 확인하고 상태를 갱신합니다. 한 제공처의 실패 이후에도 다른 제공처를 처리하고,
  전체 처리가 끝나면 실패를 오류로 전달합니다. 최신 수집 실패와 기존 공개 스냅샷 복구 실패는 서로 다른 상태입니다.
- Repository의 `findSearchablePresent()`는 공개 스냅샷과 색인 준비를 모두 요구하고, 최신 목록용
  `findPublishedPresent()`는 공개 스냅샷만 요구합니다. Mapper의 `findPublishedPresent(requireIndexReady)`가
  같은 SQL에서 색인 조건만 선택하며, 색인 복구용 전체 조회 `findPresent()`와 혼용하지 않습니다.
- V4 적용 전부터 있던 공고에는 공개 세대·검색 문서 지문·과거 색인 성공 여부가 없습니다. 다만 현재 공개된
  제공처별 공고가 1건 이상이고 해당 제공처 전체 색인 복구가 성공하면, 그때 읽어 색인한 지문·공고 수를 sentinel 세대 `0`과
  함께 한 번만 채택합니다. 빈 초기 DB는 `PREPARING`, 복구 전 legacy 공고는 `UNAVAILABLE`이며, 실제 새 스냅샷의 지문은 이
  bootstrap이 덮어쓰지 않습니다.
- 원본 ID 표기의 대소문자만 바뀌어도 UPSERT가 최신 표기를 저장하여 DB ID와 벡터 ID를 맞춥니다.
  DB 고유키의 비교는 `utf8mb4_0900_ai_ci` collation을 따릅니다.
- 접수 상태를 DB에 고정 저장하지 않습니다. 조회 시 날짜를 우선 적용하고, 날짜만으로 판단할 수
  없는 경우 원문 표현을 확인합니다. 명시적 종료 표현은 상시 접수 표현보다 우선합니다.
- 검색·색인 흐름은 [아키텍처](../../docs/architecture.md)에, 20,000건 상한·자동 벡터 삭제 미연결 등
  현재 제약은 [구현 현황](../../docs/implementation-status.md)에 정리합니다.

검색·AI 외부 경계의 실패는 `application/problem+json`으로 변환합니다. 내부 URL·라이브러리 예외는 공개하지 않습니다.

| 관측한 상황 | 공개 HTTP | `code` |
|---|---:|---|
| Elasticsearch 통신·시간 초과·부분 실패·문서 버전/가시성 검증 실패 | 503 | `SUPPORT_PROGRAM_SEARCH_INDEX_UNAVAILABLE` |
| AI 내부 503 또는 연결 불가, 기존 공고가 있지만 준비된 제공처가 없는 자연어 검색 | 503 | `AI_SERVICE_UNAVAILABLE` |
| 조건 해석·점수화·색인 API의 내부 408·504 또는 연결·읽기 시간 초과 | 504 | `AI_SERVICE_TIMEOUT` |
| 예상하지 않은 HTTP 상태 | 502 | `AI_SERVICE_UPSTREAM_ERROR` |
| 잘못된 JSON·빈 body·응답 계약 위반 | 502 | `AI_SERVICE_INVALID_RESPONSE` |
| 공식 원문 제공처 수집·HTML 검증 실패 | 503 | `SUPPORT_PROGRAM_EVIDENCE_UNAVAILABLE` |
| 현재 공고 제공처가 원문 근거 질문을 지원하지 않음 | 422 | `SUPPORT_PROGRAM_EVIDENCE_NOT_SUPPORTED` |

AI Service는 시간 초과 외 LLM 실행 실패와 색인 미준비·Qdrant 실패를 내부 503으로 반환하므로 일반적으로 공개 503이
됩니다. 조건 해석·점수화의 모델·HTTP·Agent 시간 초과는 내부 504 → 공개 `504 AI_SERVICE_TIMEOUT`으로
구분합니다. Health API의 내부 408·504는 점수화 API와 달리 `UPSTREAM_ERROR`로 분류합니다.
기업마당 수집 오류는 검색 요청에서 발생하는 오류가 아니라 백그라운드 작업의 실패로 기록됩니다.
Elasticsearch 실패는 AI 오류와 별도 경계이며 ES 직접 시간 초과도 위 503으로 반환합니다.
복구가 모든 제공처를 미준비로 기록한 뒤에는 검색의 사전 검사에서 `AI_SERVICE_UNAVAILABLE`이 나올 수 있습니다.
두 오류 모두 빈 검색 결과로 숨기지 않으며, 자세한 구분은 [키워드 색인 복구·장애 계약](../../docs/elasticsearch-lexical-search.md#동기화준비-상태복구)을 참고하세요.

## 검증

`backend/core-service` 디렉터리에서 JDK 21 환경으로 실행합니다. Repository 통합 테스트가 실제
`mysql:8.4` Testcontainers를 실행하므로 Docker가 필요합니다.

```bash
./gradlew clean test --no-daemon
```

테스트는 Controller 계약·Client/Facade 응답 검증·상태 계산·동기화 순서·공식 원문 HTML 검증·근거 청크/인용 계약과
MySQL의 JSON, 복합 식별자, UPSERT, rollback, 시작 세대에 따른 공개 제어, 공개 스냅샷 준비 상태 전이를 검증합니다. 전체 서비스 연결 검증은
[인프라 README](../../infrastructure/README.md)의 Compose 검증 절차를 참고하세요.

C02 회귀는 공개 HTTP의 nullable 필수 키·엄격한 타입·문자/날짜 경계, 내부 AI JSON의 누락 필드·오류 변환,
현재 발화 인용·미변경 조건 보존·직전 초안 병합·CLEAR 기본값·변경 목록 순서·기존 검색과의 공유 요청 제한을
검증합니다. `SupportProgramConversationServiceTest`, `SupportProgramConversationControllerTest`,
`AiSupportProgramConversationClientTest`는 외부 모델과 DB를 사용하지 않습니다.

2026-09-07 C02 검증은 Temurin JDK 21.0.12와 실제 MySQL 8.4.11(Testcontainers `mysql:8.4`)에서 전체
`clean test`를 실행해 47개 스위트·508개 테스트가 통과했습니다(실패·오류·건너뜀 0). 신규 C02 75개와
기존 433개를 모두 포함하며, 테스트 필터나 대체 DB·유료 모델 호출은 사용하지 않았습니다.

같은 날 랭킹 전용 timeout을 분리한 뒤에도 JDK 21.0.12·MySQL 8.4.11에서 필터 없이 전체
`./gradlew clean test --no-daemon`을 다시 실행해 47개 스위트·512개 테스트가 통과했습니다
(실패·오류·건너뜀 0). 설정 바인딩·전용 bean 주입·실제 HTTP 읽기 제한·공개 timeout 오류 매핑과
기존 MySQL 통합 43개를 포함하며, 개발 서비스 변경이나 유료 모델 호출 없이 검증했습니다.

`SupportProgramEvidenceIntegrationTest`는 실제 Core HTTP·MySQL과 고정한 공식 HTML 2건으로 RAG 경계를
통합 검증합니다. 기본 실행에서 원문/AI 외부 HTTP는 스텁이며 API 키를 사용하지 않습니다.
명시적으로 별도 로컬 AI 주소와 새 캡처 경로를 지정한 경우에만 실제 AI 경로를 호출할 수 있습니다.
실행 조건·범위·기록은 [RAG 평가 안내](../../evaluation/support-program-evidence/README.md)를 참고하세요.

HWP 체크박스의 FORM_OBJECT Caption은 주변 문항과 함께 별도 근거 블록으로 보존한다. 공식 신청 문항의 단일 선택지는 AI Service가 원문 인용에 포함된 `options`로 추출하고, Core API가 다시 검증한 뒤 양식 스냅샷과 공개 응답에 보존한다. Frontend는 선택지를 라디오 버튼으로 표시한다. 기존 스냅샷에서 `options`가 없으면 빈 목록으로 읽으며, 선택형 문항의 선택지를 확인하지 못한 경우 공식 원문 확인을 안내한다.

## 공고별 신청 양식 사전분석

신규·변경 공고의 상태와 시스템 분석 Outbox는 `application_form_availability`에 저장합니다. 공식 제공처 전체 동기화 성공 transaction에서 등록하고, 별도 Worker가 첨부 수집·파싱·AI 분석을 수행합니다. 성공 snapshot 저장과 AVAILABLE 활성화는 하나의 짧은 transaction입니다.

현재 사용자 작성 화면은 계정별 Discovery Job을 실행하지 않고 공고별 availability API에서 활성 snapshot을 읽습니다. 기존 계정별 discovery job API는 별도 책임으로 남아 있습니다. 새 작성은 활성 formVersionId만 허용하고, 기존 작성의 과거 버전과 최종 생성의 공식 원본 해시 대조는 유지합니다.

Discovery 전용 timeout은 model 210초 < AI run 240초 < Core read 270초 < Worker lease 1,800초입니다. 다른 신청 준비 기능의 전역 timeout은 변경하지 않습니다. [상태·재시도·백필 실행 방법](../../docs/application-form-availability.md)을 참고하세요.

## 신청 문서 MCP 파이프라인

질문·입력칸 대응에서 선택 문항의 미지원 위치는 `documentMap.unmappedFieldIds`로 받으며, 공개 양식 필드의 `documentWritable=false`로 UI에 전달한다. 필수 미매핑 항목은 여전히 양식 검증에서 거절한다. 생성 시 저장된 답변은 binding 유무로 분리하고, binding이 있는 답변만 AI 문서 계획과 편집기로 전달한다. 미기입 답변의 식별자·표시명·당시 값·사유와 기입/미기입 답변 수는 생성 파일의 `placements_json.answerSummary`에 저장하므로 이후 답변 수정과 무관하게 목록 재조회에서 같은 값을 반환한다. 과거 파일에 이 정보가 없으면 현재 답변으로 추정하지 않는다. 자동 기입 가능한 답변이 하나도 없으면 `APPLICATION_DOCUMENT_NO_WRITABLE_INPUT`으로 원본 반환 없이 중단한다. 여러 표 열을 한 질문으로 묶은 이전 양식은 `APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED`를 유지한다. Core의 원문·소유권·revision·빈칸·값·결과 검증은 유지한다.

생성 경로는 Core의 공식 첨부·소유권·revision 관리와 AI Service의 형식별 MCP 실행을 연결한다. HWP는 Core hwplib의 구조 검사·범위 편집·재열기, HWPX는 Hangeul 파일 모드, PDF는 MCP 정리 후 PDFBox AcroForm 처리이다. AI는 HWP의 hwpTargets를 받아 지도와 계획만 반환하며 Core가 원본·plan hash·revision·bindings/scope를 독립 검증한다. HWP에 Windows·한컴 한글·브리지 설정이 필요하지 않다. 과거 직접 HWPX 편집 경로는 현재 생성에서 사용하지 않는다. 부분 초안 정책 식별자를 포함한 새 fingerprint로 과거 생성 결과와 구분하고 다운로드 이력을 보존한다. 구현 범위와 미지원 구조·검증 상태는 [MCP 구조](../../docs/application-document-mcp-architecture.md), [설치](../../docs/application-document-mcp-setup.md), [검증 기록](../../docs/application-document-mcp-validation.md)를 확인한다.
