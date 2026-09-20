# GovBiz 서비스 호출·데이터 흐름

[문서 목록](README.md) · [아키텍처 README](architecture/README.md)

신청 문서의 입력칸별 질문 흐름은 공식 첨부 → OpenAI 질문 추출 → native 입력 영역 매핑 → Core 양식 스냅샷 → 질문 UI로 이어진다. 선택 문항의 미지원 위치는 공개 `fields[].documentWritable=false`로 표시한다. 문서 생성에서는 binding이 있는 저장 답변만 형식별 편집 경로로 전달하고, 미기입 답변은 생성 파일과 revision에 연결된 불변 스냅샷으로 목록·다운로드 화면에 표시한다. 포괄적인 이전 질문의 재분석은 기존 discovery-jobs API를 명시적인 클릭으로 호출하며 기존 작성본·답변을 유지한다. 세부 경계는 [신청 문서 MCP 구조](application-document-mcp-architecture.md)를 참고한다.

현재 production 코드의 서비스 경계와 실행 흐름을 설명합니다. 계층·DI·디자인 패턴은
[아키텍처 README](architecture/README.md), 기술·버전은 [기술 구성](technology.md),
완료 기능과 남은 제약은 [구현 현황](implementation-status.md), 환경 설정은
[인프라 README](../infrastructure/README.md)를 참고하세요.

## 웹·앱 공통 코드

`frontend/web`와 Expo React Native `frontend/mobile`은 `frontend/packages/shared`의 domain·유스케이스·DTO 검증을 가져옵니다.
공고 호출은 `웹/앱 화면 → 공통 유스케이스 → 플랫폼 Repository → 공통 공고 HTTP 클라이언트 → Core API`
로 이어집니다. 공통 클라이언트에는 공개 API 주소와 fetch만 주입하며 Vite/Expo 환경변수·브라우저 저장소·React를 참조하지 않습니다.
웹은 기존 쿠키 설정을 유지하고 앱의 세션 저장·네비게이션은 모바일 쪽에서 담당합니다.
기존 웹의 domain/model 파일은 공통 구현을 재수출하므로 두 구현이 따로 변경되지 않습니다.
[공동 관리와 검증 명령](mobile-monorepo.md)을 참고하세요.

앱 이메일 인증은 `AccountMobileAuthController → 기존 로그인/가입 Service → AccountRepository → MyBatis → MySQL`이며,
네이티브에서 받은 Bearer JWT도 웹과 같은 DB 세션 만료·폐기 규칙을 사용합니다. 웹은 HttpOnly 쿠키를 유지하며,
쿠키와 Bearer가 함께 오면 쿠키를 우선하고 Origin 검사를 그대로 적용합니다.
소셜 로그인은 `앱 시스템 브라우저 → AccountMobileOAuthController → AccountMobileOAuthService → 기존 OAuthService/Client → 공급자`
를 거쳐 기존 HTTPS 서버 callback으로 돌아옵니다. 서명 state 쿠키와 V40 MySQL transaction의 일회용 선점이 콜백 재사용을 막습니다.
허용된 앱 URI에는 60초 일회용 코드만 전달하고, 앱의 PKCE S256 검증 뒤 코드 소비·세션 생성을 같은 DB transaction에서 처리합니다.
OAuth 외부 호출 중에는 DB transaction을 열지 않습니다. [정확한 인증 API와 설정](../backend/core-service/README.md#모바일-인증-계약)을 참고하세요.

## 서비스 경계

소스 폴더는 `backend/{core-service,catalog-service,ai-service,ops-service}`로 통일합니다.
Compose 서비스·내부 DNS는 `core-service`·`catalog-service`·`ai-service`·`ops-service`를 사용합니다.
Core ECR 경로는 `govbiz/core-service`, Ops Kubernetes 리소스명은 `ops-service`, Ops DB 서비스는 `ops-mysql`입니다.
health 응답은 각각 `govbiz-core-service`·`govbiz-ops-service`이며 현재 운영 환경은 없습니다.
아래의 Core API는 `core-service`가 제공하는 HTTP API를 뜻합니다.

저장소는 React·Core API·Catalog Service·AI Service·Django Ops를 함께 관리하는 모노레포입니다.
`backend/ops-service`는 전용 MySQL을 쓰는 별도 프로세스이며 현재 상태 확인 API만 제공합니다.
Ops와 Core의 계정·관리 업무 연동은 아직 구현하지 않았고, 아래 AWS 운영 경로에 Ops를 추가하지 않았습니다.
[소스 통합과 로컬 실행](ops-monorepo-migration.md)을 참고하세요.

루트 `compose.yaml`은 `infrastructure/compose.catalog.yaml`을 포함해 공고 카탈로그 분리를 기본 적용합니다.
Catalog는 별도 프로세스·DB로 네 제공처 수집, 정규화, 검색 색인과 공개 snapshot을 소유합니다.
Core는 `CatalogProjectionScheduler → Service → 인증된 HTTP Client → Catalog`로 완전한 응답을 받은 뒤,
Service가 짧은 transaction을 시작한 뒤 `CatalogProjectionRepository → MyBatis → Core MySQL`로
조회용 복제본·신청서 분석 등록·checkpoint를 함께 갱신합니다. HTTP 수신은 transaction 밖입니다.
기존 관심 공고·파트너 모집의 FK와 공고 숫자 ID는 유지하며 서로의 DB에 직접 연결하지 않습니다.
Core 공개 API는 적용 완료된 복제본을 읽습니다. 인증·통신·검증 실패 시 기존 복제본을 유지하고 실패를 기록합니다.

이 모드에서 Core의 수집·색인 writer bean은 생성되지 않습니다. 기존 구현은 전환 호환성을 위해 남아 있으며,
`infrastructure/compose.yaml` 단독 실행과 AWS 재배포용 템플릿은 기존 embedded 모드입니다.
현재 운영 환경은 없으며 이 변경으로 AWS를 배포하지 않습니다. 아래 기존 수집 흐름 설명은 embedded 모드를 기준으로 하며,
분리 모드의 계약·소유권·제약은 [Catalog 분리 안내](catalog-service-extraction.md)를 참고하세요.

AWS 운영 진입 경로는 `Vercel routing middleware → CloudFront VPC origin → Nginx → Core`입니다.
미들웨어는 프록시 공유 비밀값·신뢰 IP만 추가하며 업무/AI 실행을 맡지 않습니다. Core는 운영 Compose에서
Nginx 한 IP의 전달 헤더만 신뢰하고 기존 계정·Origin 검증을 유지합니다.
[운영 설정 안내](deployment-aws-vercel.md)와 [배포 확인 기록을 반영한 구성도](assets/architecture/README-aws-deployed.md)를 참고하세요.
구성도는 실시간 상태 확인이나 모든 운영 기능의 검증 완료를 의미하지 않습니다.

기존 계정별 수동 분석 API는 `ApplicationFormDiscoveryJobController → ApplicationFormDiscoveryJobService → Repository → MyBatis → MySQL`
로 V26 분석 작업과 Outbox를 함께 저장하고 202를 반환합니다.
`ApplicationFormDiscoveryOutboxScheduler → QueueClient → RabbitMQ → ApplicationFormDiscoveryJobConsumer → JobService`
가 공유 실행 슬롯·DB 실행권을 선점한 뒤, 기존 세션 Account가 명시적으로 요청한 네 제공처 공고를
`ApplicationFormDiscoveryService → 제공처별 AttachmentClient → 공식 첨부 → SupportProgramDocumentParser →
AiApplicationPreparationFacade → AI Service`로 분석합니다. 검증된 응답은 `ApplicationFormSnapshotRepository → MyBatis → MySQL`에
파일 hash·파서·모델·프롬프트 버전과 함께 저장해 동일 추출 버전에서 재사용합니다. 발견 양식을 선택한 뒤
`ApplicationPreparationService → ApplicationPreparationRepository`가 계정 소유 준비 건을 생성합니다. 화면 진입과 목록·상세
조회만으로 DB 쓰기나 AI 호출을 실행하지 않으며, 기존 classpath manifest는 검수 기준과 이전 준비 건 복원에 사용합니다.
문항 답변은 `ApplicationPreparationService → AiApplicationPreparationFacade → AiApplicationPreparationClient → AI Service`로
DB transaction 밖에서 해석합니다. 요청 키와 당시 입력을 먼저 짧은 transaction으로 예약하고, 검증된 제안 또는 실패 상태를
별도 transaction으로 저장합니다. 사용자가 제안을 확인한 PUT만 문항 사실을 전체 교체하고 입력 revision을 증가시킵니다.
본인 준비 건의 DELETE는 `ApplicationPreparationRepository → MyBatis → MySQL`에서 소유자 조건으로 한 행을 지우고,
확인 사실·AI 실행 기록은 FK cascade로 삭제하지만 공용 `application_form_snapshot`은 유지합니다.
Frontend는 `/app/application-preparations`의 목록·삭제, `/new`의 지연 조회 관심 공고 팝업과 전체 카탈로그 공고 검색·선택을 첫 단계로,
저장된 신청 양식 확인 버튼으로 공고별 availability API를 조회한 뒤 활성 snapshot을 별도 두 번째 단계로 표시하고, `/:preparationId`의 공식 문항
상세와 질문·사실 확인을 연결합니다. AI 제안은 저장하지 않고 사용자가 선택·수정한 전체 문항 입력만 revision을 올려 저장합니다.
신청 문서와 중복 지원 검토의 공고 검색은 공용 `SupportProgramSearchFilters`에서 검색어·지역·지원 분야·출처·접수 상태를 입력받고,
각 ViewModel → `BrowseSupportProgramsUseCase` → 기존 catalog HTTP API로 전달합니다. 검색 버튼은 1페이지부터 조회하고,
페이지 이동은 마지막으로 적용한 조건을 유지합니다. 조건 해제·전체 초기화는 공고 선택을 유지한 채 다시 조회합니다.
문서 생성은 `ApplicationDocumentController → ApplicationDocumentService → 공식 첨부 Client →
ApplicationDocumentEditor → AiApplicationPreparationClient → AI Service Router → Service → 위치 선택 Agent → OpenAI`로 이어집니다.
공식 첨부 SHA-256이 선택한 양식 버전과 일치할 때 원본의 문단·표 셀 또는 PDF 페이지를 분석합니다.
AI는 답변을 다시 쓰지 않고 기입 위치만 선택합니다. Core가 답변 전체의 매핑을 검증하고 원본에 사용자 값을 기입합니다.
서로 다른 답변이 같은 HWP/HWPX 텍스트 칸을 선택한 AI 응답은 그대로 사용하지 않습니다. AI Service가 칸마다 첫 답변과 충돌하지 않은 위치를 고정하고 나머지 충돌 답변을 고정된 칸을 금지한 한 번의 요청으로 다시 배치하며, 필요하면 답변 없는 예시 분류 요청을 분리한 뒤 전체 계약을 다시 검증합니다. 교정 실패는 정상 결과로 숨기지 않습니다.
HWP/HWPX는 파란 텍스트 후보와 표 문맥을 함께 전달하여 예시 삭제 대상도 선택합니다. Core는 후보 ID를 검증하고 선택된 파란 예시만 제거한 뒤 검은 글씨로 기입합니다. PDF의 기존 텍스트 삭제는 지원하지 않습니다.

HWP/HWPX의 모든 파란 문구 후보는 답변 유무와 관계없이 `clearExampleTargetIds`(예시·작성 힌트 삭제) 또는 `preserveExampleTargetIds`(제목·항목명·필수 안내 보존)에 정확히 한 번 포함되어야 합니다. AI Service와 Core API 양쪽에서 누락·중복·교집합·알 수 없는 ID를 거절합니다. 체크박스 답변을 Core가 모두 처리한 경우에도 예시 후보가 있으면 빈 facts로 분류를 요청합니다. 파일 편집 후 삭제 대상으로 선택한 문단에 파란 문구가 남았는지 다시 검사합니다. 의미 분류의 정확도와 실제 한글 조판 품질은 별도 검수가 필요하며, PDF의 기존 문구 삭제는 지원하지 않습니다.
HWP는 hwplib 1.1.11, HWPX는 ZIP/XML, PDF는 PDFBox와 OFL NanumGothic 글꼴을 사용합니다.
PDF 입력값은 AcroForm 필드로 남겨 다시 편집할 수 있습니다. 문서를 다른 확장자로 변환하지 않습니다.
`ApplicationDocumentRepository → MyBatis → MySQL`이 V32의 생성 파일·원본 hash·기입 위치를 저장합니다.
V33의 생성기 버전으로 이전 결과와 구분하여 같은 답변 revision의 수정된 초안을 재생성하며 이전 파일은 보존합니다.
생성기 5는 HWP 선택 컨트롤의 정확한 값 매칭을 Core에서 처리하고 나머지 답변 위치를 AI에 요청합니다. 체크 그룹 갱신·밑줄 빈칸 치환·HWP 줄 배치 재계산 뒤 저장합니다. 미정 답변은 기입 대상에서 제외하고 Frontend가 누락 항목을 표시합니다. 표가 있는 HWP 섹션의 표 밖 빈 문단은 위치 후보에서 제외하고, 예시 삭제 후 빈 문단이 되는 경우도 기입 단계에서 거절합니다. 이전 생성기 결과는 재사용하지 않습니다. 전체 페이지 조판과 실제 양식의 의미적 배치 품질은 자동 테스트와 별도로 검수해야 합니다.
외부 호출은 DB transaction 밖에서 실행하고 저장 시 입력 revision을 잠금으로 재확인합니다.
같은 revision의 저장 파일은 재사용하며, 현재 프로세스에서 같은 준비 건의 동시 생성은 거절합니다.
Frontend는 입력 화면과 `/:preparationId/documents` 결과 화면을 분리합니다. 원본 파일 단위로 다운로드하며,
내려받은 파일에서 수정하거나 이전 입력 화면에서 답변을 수정·저장한 뒤 다시 생성합니다.
V31의 문항별 텍스트 작성본 API·기록은 남아 있으나 현재 UI는 호출하지 않습니다.

`/app/saved-programs`의 진행 관리에서는 신청 준비 건의 단계를 조회·변경합니다. 단계 변경은 문서 입력 revision과 분리된 진행 revision으로 보호합니다.

로컬 Compose의 개인 목업 경로는 `demo-seed → application-preparations.sql / combination-reviews.sql → MySQL`입니다.
기본 시연 계정 admin·member마다 신청도우미 2건과 중복 검토 2건의 독립 parent/child 행을 만들고, 로그인 계정의 `owner_account_id` 조회 경계를 그대로 유지합니다.
V35·V37의 `(owner_account_id, demo_seed_key)` 유일 제약은 목업 중복만 막으며, 일반 사용자 작업의 NULL 키는 여러 행을 허용합니다.
기존 DB에서도 두 SQL을 증분 실행해 누락분을 복구하고 사용자 기록과 대상 밖 기존 목업은 보존합니다. 신규/기존 환경 모두 같은 SQL을 사용하며
대상 이메일 기본 탐색·override와 세부 실행법은 [데모 데이터](../infrastructure/README.md#데모-데이터)에 있습니다.

Frontend는 현재 공고의 활성 분석 작업을 3초마다 확인하며, 조회 재시도는 새 분석을 만들지 않습니다.
AI Service의 명시적 근거 검증 실패(`422 / APPLICATION_FORM_AI_INVALID_RESPONSE`)는 Client의 전용 예외 → DiscoveryService의 업무 오류 → JobService의 FAILED 저장으로 연결됩니다. 공고 재선택 후 새 요청은 허용하되 자동 재호출하지 않으며, 통신 유실·시간 초과는 UNKNOWN으로 차단합니다.
관리자 큐 운영 조회는 `QueueOperationsController → QueueOperationsService → Repository/MyBatis/MySQL + QueueOperationsClient/RabbitMQ`
로 생성·메일 발송·중복 검토·문서 분석·카카오 연결 해제의 다섯 큐 보관 상태·브로커 관측치를 읽습니다. 메시지 소비/재발행/DB 작업 상태 수정은 없습니다.
[실행권·만료·결과 불명·관리자 지표·운영 한계](rabbitmq-application-form-discovery.md)를 참고하세요.

중복 지원 검토의 현재 입력은 `기존 세션 Account 해석 → CombinationReviewController → CombinationReviewService
→ CombinationReviewRepository → CombinationReviewMapper → Mapper XML → MySQL`로 생성·조회·수정·삭제합니다.
목록은 소유자·생성 ID 커서로 조회하고, 수정은 소유자·입력 버전 조건으로 원자적으로 교체합니다. 삭제도 소유자 조건으로 수행하며
선택 공고·실행 이력·보관 원문은 외래 키로 함께 삭제됩니다.
타인 검토와 없는 검토는 404, 본인 검토의 버전 충돌은 409입니다. 세션 쿠키 쓰기 요청의 Origin 검사는 유지합니다.
분석 POST는 `CombinationReviewRunController → CombinationReviewRunService`로 들어가 입력을 접수합니다.

1. `CombinationReviewRunRepository → MyBatis → MySQL`: 소유자·버전·요청 키 확인 후 QUEUED 입력 스냅샷 예약.
   실행 행 자체가 Outbox이며 새 POST는 202로 반환합니다. `CombinationReviewOutboxScheduler → CombinationReviewQueueClient
   → RabbitMQ → CombinationReviewRunConsumer → CombinationReviewRunService`가 DB에서 실행을 한 번 선점합니다.
2. 소비자는 선택한 제공처에 따라 `BizInfoAttachmentClient`, `MsitAttachmentClient`, `KStartupAttachmentClient`,
   `CnTradeNoticeAttachmentClient`를 통해 검증된 공식 상세의 직접 연결 첨부를 수집. 충남은 API 제목·본문과 게시판 상세를 교차 검증.
3. `SupportProgramDocumentParser`: PDFBox, Apache Tika HWP5 또는 HWPX ZIP/XML로 텍스트·위치를 추출. 신청 문서 발견과 중복 지원 검토가 같은 안전 경계를 사용.
   공고별로 읽을 수 있는 문서가 있으면 크기 제한 초과·텍스트 추출 불가 첨부는 경고와 함께 제외하고, 모두 제외되면 실행을 실패 처리.
4. `CombinationReviewRunRepository`: 원문 바이트·해시·메타데이터·텍스트를 짧은 transaction에서 보존. 검증한 공식 공고 상세 주소와
   첨부 다운로드 주소를 서로 다른 필드로 저장해 화면의 공고 페이지 이동과 보관 원본 다운로드를 구분.
5. `AiCombinationReviewFacade → AiCombinationReviewClient → AI Router → CombinationReviewService → CombinationReviewAgent → OpenAI` 단일 호출.
6. AI와 Core에서 사업쌍·단계·인용을 검증하고 실행 성공/실패 저장. AI는 서버가 원문에서 만든 인용 선택지 번호만 고르고,
   코드가 정확한 원문과 근거 ID를 복원한다. 다른 사업쌍의 선택지나 범위 밖 번호는 실패 처리. 현재 입력은 덮어쓰지 않음.

네트워크 호출은 DB transaction 밖에서 수행합니다. 같은 요청 키는 기존 실행을 반환하고 새 키의 동시 실행은 DB에서 막습니다.
계정별 새 접수는 기존 공개 요청량 제한을 공유하며, 계정 전체 미완료 작업은 최대 3건입니다. 검토 큐 소비자는 1개이며
RUNNING과 UNKNOWN 재전달은 재실행하지 않습니다. 기존 Qdrant 검색은 사용하지 않습니다.
자동 수집 원문은 사람 검수 전으로 표시합니다. 사용자 화면은 3단계 입력·분석 흐름으로 연결되어 있으며
[비동기 접수·원문 관리·결과 불명·운영](rabbitmq-combination-review.md)을 참고하세요.

Core의 Run Service는 실행 순서·근거 묶음 구성·상태 저장을 맡습니다. AI Facade는 요청 변환·Client 호출·응답 검증을 감추고,
`client/mapper/AiCombinationReviewMapper`가 전송 DTO와 내부 모델 사이를 변환합니다. Facade는 상위 Service나 DB를 호출하지 않습니다.
검토 없음·입력 버전·실행 충돌은 프레임워크와 무관한 `domain/exception`에 둡니다. 수집/AI 통신 실패는 `client/exception`,
AI 경계 실패는 `facade/exception`에서 표현하고 Service가 공개 실행 오류로 바꿉니다. Repository와 Client는 Service 타입을 참조하지 않습니다.

```text
브라우저 → React Web → Core API
                       ├→ MySQL: 현재 공개 공고 카탈로그·공고별 공식 원문
                       ├→ Elasticsearch: Nori·BM25 키워드 후보 색인·검색
                       ├→ 공공데이터포털: 기업마당·K-Startup 공고 수집
                       ├→ 기업마당 공식 HTTPS 상세 페이지: 명시적 원문 질문 시 HTML 수집
                       └→ AI Service
                           ├→ OpenAI: 문서·질의 임베딩, 조건 변경 해석·후보 점수화·근거 답변
                           └→ Qdrant: 공고 검색·원문 근거 청크의 분리된 벡터 컬렉션
```

Core API는 공개 HTTP 계약, 기업마당·K-Startup 수집, MySQL 접근과 접수 상태 계산을 소유합니다. AI Service는
Core가 전달한 공고 문서·원문 청크의 색인·검색·점수화·근거 답변을 담당하며 MySQL에 직접 접근하지 않습니다.

브라우저는 Core API의 `/api`만 호출합니다. Compose에서 Vite는 `/api`를 `core-service:8080`으로 프록시하며,
AI Service는 호스트에 포트를 게시하지 않습니다. MySQL·Qdrant·Core API·Web의 개발용 포트는
`127.0.0.1`에 바인딩합니다. 기업마당·K-Startup 키는 Core API에, OpenAI 키는 AI Service에만 주입합니다.
이는 개발 환경의 서비스 배치이며 운영 인증·접근 제어가 구현됐다는 의미는 아닙니다.

## 로그인 회원의 대화 기록

`WorkspaceLayout/useChatHistory → ChatConversationUseCase → ChatConversationRepository → data/api →
ChatConversationController → ChatConversationService → ChatConversationRepository → MyBatis Mapper → XML → MySQL`로
대화 화면 스냅샷을 보관합니다. Frontend Repository와 Core Repository는 각 애플리케이션의 경계를 담당합니다.
새 전송은 현재 대화에 누적하고 새 대화의 첫 전송은 별도 기록을 만듭니다. 비회원과 미전송 초안은 저장하지 않습니다.
사이드바 요금제 아래 목록은 생성 ID 기반 30개 단위 커서 조회를 사용합니다. 기록을 열면 기존 Redux 상태만 복원하며
검색·해석·OpenAI를 재호출하지 않습니다. 공고 결과는 저장 당시 내용이라는 안내를 표시합니다.

Core는 세션 account ID로 모든 SQL을 제한하고 `X-Chat-Account` 사전조건으로 다른 탭의 계정 변경을 감지합니다.
`V19`의 복합 UNIQUE와 FK는 소유자별 ID를 보호하며 저장 transaction의 계정 행 잠금·expectedVersion 검사로
중복 생성·동시 덮어쓰기를 막습니다. 동일 내용 재전송은 멱등이며 충돌은 409로 드러냅니다. 이 스냅샷은 회원이 저장한
화면 데이터로 신뢰된 검색 결과나 서버 권한의 근거가 아닙니다. 탈퇴 이벤트의 대화 삭제는 탈퇴 transaction에 참여합니다.

카카오 탈퇴 연결 해제는 `AccountProfileService → AccountOAuthUnlinkRepository → MyBatis → MySQL(V28)`로
탈퇴와 작업 저장을 원자적으로 처리합니다. 공급자 identity는 성공 전까지 재가입 차단용으로 유지합니다.
`AccountOAuthUnlinkScheduler → QueueClient → RabbitMQ → Consumer → AccountOAuthUnlinkService → KakaoOAuthClient`로
외부 호출을 DB transaction 밖에서 실행하고, 결과 저장·이전 identity 해제만 짧은 transaction으로 묶습니다.
큐 off는 같은 DB 작업을 스케줄러가 직접 처리합니다. UNKNOWN은 재실행하지 않으며 재가입 차단을 유지합니다.
[설정·경합 방지·운영자 확인](rabbitmq-account-oauth-unlink.md)을 참고하세요.
브라우저는 계정 변경 때 진행 요청·메모리를 폐기하고, 조회 중 새 입력·화면 이동이 발생하면 늦은 복원을 적용하지 않습니다.
저장 실패는 현재 창의 내용을 유지한 채 안내하며 자동 fallback·강제 덮어쓰기를 하지 않습니다.
기록별 삭제는 같은 계층을 따라 `DELETE /api/v1/me/chat-conversations/{id}`로 처리합니다. `V21`의 `deleted_at`을
설정하면서 제목·스냅샷을 비우고, 저장과 같은 계정 행 잠금으로 늦은 최초 저장·갱신까지 차단합니다. 삭제는 멱등 204,
삭제된 ID의 조회는 404, 재저장은 409입니다. 다른 계정의 데이터에는 영향을 주지 않습니다.
Frontend는 확인 후 삭제 요청을 보내고 성공 시에만 목록·메모리를 지웁니다. 현재 대화 삭제 시 Redux 요청 ID도 초기화하며,
삭제 중 다른 대화로 전환했다면 그 대화는 보존합니다. 늦은 목록·상세·저장 응답은 삭제한 기록을 다시 표시하지 않습니다.
삭제 실패 시 기록을 유지하고 재시도를 안내합니다. 원문 공고·Qdrant 색인·다른 업무 문서는 삭제하지 않습니다.
병합 충돌을 해소한 마이그레이션 순서는 대화 테이블 V19 → 관리자 계정 관리 V20 → 대화 삭제 V21입니다.
대화용 V19의 기존 이력은 변경하지 않습니다. 관리자용 V19가 적용된 별도 DB의 주의사항은
[Core API 업그레이드 안내](../backend/core-service/README.md#v19-병합-충돌과-기존-db-업그레이드)를 따릅니다.

## 기업 맞춤 일일 리포트

`DailyReportController → DailyReportService`는 저장된 기업 조건·지원 목적을 기존 검색에 전달하고,
추천 최대 3건 중 기업마당 공고에 기존 근거 답변을 연결합니다. 수집·검색·근거 답변 Agent를 새로 복제하지 않습니다.
`DailyReportRepository → MyBatis Mapper → XML → MySQL`에서 수신 설정·일별 입력과 결과·생성 시도 예산을 보존합니다.
수동 미리보기는 기존 동기 호출을 유지합니다. 정기 스케줄러는 리포트·예산·작업 Outbox를 함께 저장하고,
`DailyReportOutboxScheduler → DailyReportQueueClient → RabbitMQ → DailyReportGenerationConsumer → DailyReportService`로 생성합니다.
`DailyReportScheduler`는 `DailyReportConfig`가 정기 실행 활성 시에만 만드는 `dailyReportTaskScheduler`를 사용합니다.
공고 수집용 기본 스케줄러와 다른 단일 스레드이며 시작 지연 1분·완료 후 5분 간격은 유지합니다.
Core 내부 전용 소비자가 기존 검색·근거 답변을 재사용하며 DB 선점으로 중복 실행을 차단합니다. 별도 Worker 서버는 아닙니다.
메일은 이후 스케줄러 주기에서 V27 리포트 행의 발송 Outbox에 예약합니다.
`DailyReportDeliveryOutboxScheduler → DailyReportDeliveryQueueClient → RabbitMQ → DailyReportDeliveryConsumer → DailyReportService → DailyReportMailClient → SMTP`
로 전송하며 기존 NOT_REQUESTED → SENDING 선점과 UNKNOWN 재발송 금지를 재사용합니다.
발송 큐를 끄면 기존 스케줄러 직접 SMTP 경로가 유지됩니다. [발송 큐 상세](rabbitmq-daily-report-delivery.md)를 참고하세요.
생성·발송 예약 및 결과 저장만 짧은 transaction에서 수행하고 AI·원문 HTTP·SMTP 호출은 transaction 밖에서 수행합니다.
프런트엔드는 본인 리포트·설정과 명시적 이메일 확인·해지 화면을 제공합니다. 점수는 검색 관련도이며 선정 확률이 아닙니다.
[리포트 API·수신 동의·중복/비용 제한·운영 설정](daily-reports.md)에 상세 경계를 정리합니다.
[RabbitMQ 적용 상세](rabbitmq-daily-report-generation.md)는 예약/발행 transaction, 실패·중복·`UNKNOWN`, 운영 한계를 설명합니다.

## 검색·상세 조회·원문 근거 질문

공개 대화 해석·검색·근거 질문은 입력 검증 뒤 Controller에서 `SupportProgramRequestAdmissionService`를 거쳐
기존 업무 Service를 실행합니다. 하나의 Bean이 접속 주소별/전체 최근 60초 및 동시 작업 한도를 공유하며,
거절 시 하위 Service를 호출하지 않고 429 또는 503을 반환합니다. 잠금은 입장 판단·카운터 갱신에만 사용하고
외부 호출 중에는 유지하지 않습니다. `finally`로 정상·예외 종료 모두 동시 슬롯을 반환합니다.
준비 상태·상세 GET·Health·백그라운드 동기화·비웹 평가는 이 공개 제한과 분리합니다.
전달 헤더를 기본 신뢰하지 않으며 Compose 프록시/NAT 뒤에서는 주소별 한도를 공유할 수 있습니다.
단일 프로세스 보호이며 분산 한도·전역 비용 상한은 아닙니다. [설정·경계·검증](support-program-request-limits.md)을 참고하세요.

### 후속 대화의 조건 변경 해석

`POST /api/v1/support-programs/conversation/interpret`는 확정 상태·새 메시지·선택적인 미확정 제안 또는
마지막 질문과 초안, 최근 성공 검색의 조건·결과 수 요약을 처리합니다. Core의 전용 Service와 AI Client를 통해 AI Service의 조건 해석 Agent를 호출하고,
변경 목록을 검증·병합해 제안 또는 보완 질문을 반환하고, 결과 설명 질문에는 변경 없는 ANSWERED 응답을 반환합니다. 전체 상태 재작성으로 조건이 누락되지 않도록
변경 목록에 없는 필드는 코드로 유지합니다. 변경 전후 필드 목록은 Core가 계산합니다.

이 단계는 Search Service·Repository·MySQL·Qdrant를 호출하지 않습니다. Web은 미확정 제안을 별도로 보관하고
사용자가 확인했을 때만 조건을 적용해 아래 기존 POST 검색을 실행합니다. 해석과 확인 검색은 별개의 공개 요청입니다.
질문·설명·오류·취소는 확정 조건을 바꾸지 않으며, 사용자가 확인한 검색 실패의 재시도는 다시 해석하지 않습니다.
입력을 시작해도 미확정 제안을 보관해 다음 발화에 전달합니다. 새 검색을 시작하면 이전 결과 요약을 비워
실패·취소를 과거의 0건 성공 결과와 혼동하지 않습니다. 설명은 전달된 사실에 한정하고 원인을 추측하지 않습니다.
서버 대화 세션·영구 프로필·무제한 이력·Agent graph는 추가하지 않습니다.
[C02 계약·검증 기록](conversation-condition-update.md)에 상태·문자·날짜·실패 경계를 명시합니다.

### 도우미 자유 질문

`POST /api/v1/assistant/messages`는 화면 오른쪽 아래 도우미 위젯의 자유 질문을 받습니다. 주제·질문 알약(C1)은 네트워크 없이
프런트 도움말 데이터로 답하고, 프런트 스위치 `VITE_ASSISTANT_AI_ENABLED=true`일 때만 자유 입력이 이 경로로 옵니다(기본 꺼짐, 꺼지면 알약 안내로만 답함). Core는 길이 상한·개인 정보 마스킹·공유 요청 한도를 거친 뒤
AI Service의 `/internal/v1/assistant/answers`를 한 번 호출해 의도 하나와 그 의도의 필드(인용·검색어·계정 영역·확인 질문)를 받습니다.
AI Service는 DB를 보지 않고 도구도 없습니다. 상태 답(`ACCOUNT_STATE`)은 Core가 세션 계정으로 관심 공고함·받은 제안함·기업 등록을
읽어 문장을 만들고, 검색(`SEARCH`)·원문 질문(`PROGRAM_QUESTION`)은 실행하지 않고 기존 화면으로 이동 버튼만 붙입니다.
인용 id는 요청에 실린 도움말 안에서만, 이동 경로는 Core 상수와 도움말 행동 경로 안에서만 인정하며 어긋나면 502로 버립니다.
대화는 브라우저 세션 저장소에만 남고 서버는 저장하지 않습니다. 분류·인용 회귀는 [도우미 의도 분류 평가](../evaluation/assistant/README.md)로 확인합니다.

Core 설정 `app.assistant.agent-enabled=true`(루트 `ASSISTANT_AGENT_ENABLED`, 기본 꺼짐)면 같은 질문을 AI Service의
`/internal/v1/assistant/agent`(LangGraph 도구 에이전트)로 보냅니다. 분류 뒤 회원 자료가 필요한 의도(`PARTNER_MATCH` 모집글 매칭,
`ACCOUNT_STATE` 내 상태, `SAVED_PROGRAMS_QUESTION` 관심 공고 묶음 질문)만 AI Service가 Core 내부 읽기 도구
`GET /internal/v1/assistant/tools/{company-profile|recruitments|saved-programs}`를 최대 3회 되불러 답과 카드(`cards[]`, 모집글·공고, 이유·인용·상세 경로)를 만듭니다.
도구 호출은 Core·AI Service가 공유하는 비밀(`ASSISTANT_TOOLS_TOKEN`, 32자 이상)과 요청마다 발급하는 계정 묶음 HMAC 토큰(5분) 둘 다 있어야 통과하고,
응답 카드 id·경로·인용은 Core가 도구 결과·허용 목록·청크 원문과 다시 대조합니다. 관심 공고 묶음 질문은 첫 응답이 `needsDocuments`면 Core가 관심 공고
최대 10건의 원문을 확보·청킹·색인(6초 예산, 부분 성공 허용)해 같은 의도로 한 번 더 부르고, 관심 공고를 담을 때 원문을 미리 수집·색인하는
outbox 큐(`ASSISTANT_PREFETCH_QUEUE_ENABLED`, RabbitMQ)가 첫 질문 지연을 줄입니다. 비로그인은 도구 경로가 막혀 로그인 안내로 끝납니다.

### 확인된 조건의 검색

```text
POST /api/v1/support-programs/search (조건 검색)
GET /api/v1/support-programs/search (기존 단문·최신 목록)
  → SupportProgramController
    → SupportProgramSearchPreviewService (인증별 공개 범위·결과 보관)
      → SupportProgramSearchService
        → SupportProgramRepository → MyBatis Mapper → Mapper XML → MySQL
          → 빈 검색: findPublishedPresent로 공개 세대·지문이 있는 DB 공고 선택
          → 자연어 검색: findSearchablePresent로 위 조건에 index_ready=true 추가
        → 접수 상태 계산·필터
        ├→ 빈 검색어: 최신순 최대 5개 반환
        └→ 검색어 있음:
            AiSupportProgramRetrievalFacade
              → ElasticsearchSupportProgramClient → Nori·BM25 후보 최대 20개
              → AiSupportProgramIndexClient → AI Service → 현재 색인 검증 → 질의 임베딩 캐시/OpenAI → Qdrant 후보 최대 20개
              → Core: 두 순위의 RRF 결합 → 후보 최대 20개
            AiSupportProgramRankingFacade → HttpAiSupportProgramRankingClient
              → AI Service → 정확일치 랭킹 응답 캐시, 없으면 단일 Agent → OpenAI 점수화·검증
            Core의 응답 검증 → 최종 추천 0~5개
```

공개 GET·POST 검색은 로그인 세션에 따라 비회원에게 앞의 최대 2건, 회원에게 최대 5건을 반환합니다.
응답의 `totalCount`는 전체 카탈로그 건수가 아니라 이번 추천 결과 수(0~5건)입니다. 비회원의 추가 결과가 있으면
Core의 `SupportProgramSearchPreviewService`가 `SupportProgramSearchResultRepository`를 통해 원본 결과·검색 조건을 Redis에 30분 보관하고,
브라우저에는 공개 2건과 난수 `resultToken`, `expiresAt`만 전달합니다. 잠긴 카드에는 원본 내용을 전달하지 않습니다.

```text
선택한 잠금 카드 → 회원가입/로그인 → POST /api/v1/support-programs/search/results
  → SupportProgramController → SupportProgramSearchPreviewService
    → SupportProgramSearchResultRepository → Redis: Lua로 토큰 만료·소유 계정 확인 및 최초 계정 연결
      → 보관된 전체 결과와 검색 조건 (회원 세션 인증은 기존 MySQL 경로)
```

복원은 추가 검색·임베딩·랭킹 호출 없이 같은 결과를 반환하며 첫 조회 계정에 토큰을 귀속시킵니다.
같은 계정의 재시도는 허용하지만 만료·미존재·다른 계정의 조회는 410으로 명시합니다.
`govbiz:search-result:v1:{SHA-256(token)}` 키의 JSON·소유 계정·TTL을 함께 관리하므로 Core 재시작·여러 Core 사이에서
상태를 공유합니다. TTL과 응답 `expiresAt`은 Redis 시계 기준의 고정 30분이며 복원으로 연장하지 않습니다.
기존 128건 조기 퇴거 대신 Redis `128mb/noeviction`과 개별 JSON 2MiB 제한을 사용합니다. 저장소 장애·용량 초과는
503 `SUPPORT_PROGRAM_SEARCH_RESULT_STORE_UNAVAILABLE`이고 로컬 메모리 fallback/자동 재검색은 없습니다.
Compose는 Redis 8.2.9·AOF 볼륨(`everysec`)을 사용하므로 Redis 컨테이너 재생성 후에도 볼륨이 남으면 복원되지만,
비정상 종료 시 최근 약 1초의 결과/계정 연결이 유실될 수 있습니다. 다중 Redis 복제/고가용성은 아직 구현하지 않습니다.
Lettuce 전용 DNS 캐시는 최대 5초로 제한해 Redis 컨테이너 교체로 IP가 바뀌어도 재연결할 때 새 주소를 확인합니다.
대화 기록 원본과 회원 세션은 MySQL을 유지하고, AI 랭킹·임베딩 캐시는 기존 AI Service 메모리에 둡니다.
Redis 추가는 첫 검색을 빠르게 하는 변경이 아니며 검색·복원 응답에는 `Cache-Control: no-store`를 설정합니다.
일일 리포트·평가는 기존 내부 `SupportProgramSearchService`를 계속 사용하고, 공개 카탈로그·상세 조회는 이 제한과 분리합니다.
파일별 책임·저장 구조·TTL·계정 경합·장애·설정·검증은 [Redis 적용 상세](redis-search-result-restoration.md)에 정리합니다.

등록 기업 계정의 새 채팅은 `Web → 기존 내 기업 조회 API → 회사 Service/Repository → MySQL`로
소재지·업종·설립연도를 읽어 기본 조건을 설정합니다. 이후 `Web → 대화 해석 → 확인 → 검색 → AI 랭킹`에
같은 조건을 전달합니다. 회사 조회 실패는 명시적으로 표시하며, 로그아웃·새 대화 후 늦은 응답은 무시합니다.
대화 중 수정·해제한 조건이나 과거 기록을 현재 회사 프로필로 덮어쓰지 않습니다.
설립연도 foundedYear는 날짜 establishedOn과 별도로 정밀도를 보존하며 둘 중 하나만 지정합니다.
AI는 연도 범위 전체로 확인 가능한 업력 요건과 정확한 날짜가 필요한 경계를 구분합니다.

Web의 POST 검색은 `query`와 선택적인 `companyConditions`를 따로 보냅니다. Core의 공개 DTO는
날짜·길이·문자 입력을 검증한 뒤 조건 Domain 모델로 변환합니다. 검색 Service는 요청별 서울 날짜를
한 번 정하고, 후보 검색에는 조건을 포함한 검색문을, Ranking Facade에는 원래 질의와 구조화된 조건을
전달합니다. Facade가 AI 전용 DTO로 바꿉니다. 이 검색 요청의 조건을 지원사업 원본 Repository나 계정·기업 DB에
저장하지는 않지만, 로그인 복원용 Redis 스냅샷에는 함께 보관합니다. 검색 조건 도입으로 SQL·동기화·스키마는
변경하지 않습니다. 조건이 없는 GET 및 비웹 평가 호출은 기존 단문 경로를 유지합니다.

1. Repository는 `is_source_present = TRUE`이고 제공처의 공개 세대·지문이 있는 공고를 읽습니다. 자연어 검색은
   `index_ready = TRUE`도 요구하며, 빈 검색은 공개 이후 색인 장애와 무관하게 기존 DB 목록을 유지합니다.
   저장된 신청 기간과 서울 날짜로 접수 상태를 다시 계산하고 `acceptingOnly=true`이면 `OPEN`만 남깁니다.
2. 검색어는 앞뒤 공백을 제거합니다. 검색어가 비어 있으면 `source_sort_timestamp` 내림차순·제공처 코드·원본 ID
   오름차순의 최대 5개를 AI 없이 반환합니다. 자연어 검색의 빈 후보가 전체 색인 장애 때문이면 503으로 알리고,
   최초 빈 DB나 준비된 제공처의 정상 0건이면 빈 목록을 반환합니다. 미공개 제공처 데이터는 노출하지 않습니다.
3. 비어 있지 않은 질의는 대상 공고 전체의 정확한 ID·내용 해시를 AI Service에 전달합니다.
   Core는 적격 공고 전체 값과 순서가 같은 동안 단일 불변 스냅샷의 해시·두 색인 버전 참조를 재사용합니다.
   스냅샷 크기는 제한하며 큰 입력은 저장하지 않고 정상 처리합니다. 가변 목록을 복사하고 HTTP 호출을 락으로
   직렬화하지 않습니다. DB 조회·접수 상태 계산·공개/색인 준비 검증·키워드 순위 계산은 매 요청 유지합니다.
   최신 공고 20개를 먼저 자르지 않습니다. Qdrant가 반환해야 할 개수는 `min(대상 공고 수, 20)`입니다.
4. `AiSupportProgramRetrievalFacade`는 먼저 `ElasticsearchSupportProgramClient`로 현재 적격 버전에 한정한
   Nori v2(`discard`, 사용자 사전·검색용 동의어)·BM25 상위 20개를 조회합니다. 동일 검색 시점의 전체 버전 가시성·부분 실패·ID·해시·점수를
   검증합니다. 질의·본문은 NFC로 정규화하며 동점은 정렬 시각 내림차순·제공처 포함 ID 오름차순입니다.
   이어 의미 검색 응답의 질의·ID·해시·중복·유한 점수·내림차순·개수를 검증합니다.
   의미 검색과 키워드의 1부터 시작하는 순위를 동일 가중치 RRF `1 / (60 + 순위)`로 합산하고,
   동점은 의미 검색 순위·제공처 포함 ID 오름차순으로 정렬해 중복 없는 최대 20개를 점수화에 전달합니다.
   어느 색인이든 실패하거나 잘못됐으면 오류를 반환합니다. 정상 키워드 일치가 없으면 의미 검색 순서를 유지합니다.
5. AI Service는 전체 입력이 같은 검증된 랭킹 응답을 재사용하거나 모든 후보를 다시 평가합니다.
   AI는 후보의 의미·자격·세부 점수를 판단하고 총점은 출력하지 않습니다.
   요청별 strict schema의 `rankings`는 후보 ID 자체를 필수 키로 선언한 객체이며 다른 키는 금지합니다.
   Agent가 후보별 원문 조각 선택지를 제공하고, LLM은 인용문을 재작성하지 않고 근거 번호만 선택합니다.
   출력 스키마는 자격별 분기를 나눠 MATCH·INCOMPATIBLE에 근거 번호 1개를 필수로 하며,
   UNKNOWN만 0~1개를 허용합니다. 추천 이유도 항목별 1~120자 제한을 생성 형식에 선언합니다.
   번호를 해당 후보의 원래 필드·문구로 복원한 뒤 검증된 키를 ID로 붙여 `AssessedSupportProgram` 목록으로 변환합니다.
   AI Service가 `2 × (semanticRelevance + supportTypeFit)`으로 관련도를 계산해 `ScoredSupportProgram`으로 변환한 뒤
   원문 인용과 자격·추천 기준을 검증하고 관련도 내림차순으로 정렬합니다. 자격 미확인은 별도로 표시합니다.
   Core도 최종 응답의 후보 ID·질의·계약 버전·점수·순서·추천 이유·실제 본문 인용을 재검증해
   비저장 검색 결과 `eligibilityReview`를 포함한 공개 응답으로 변환합니다.

AI의 두 캐시는 프로세스 안의 서비스 인스턴스에만 속합니다. 질의 임베딩은 정확한 입력 문자열별
최대 256개·300초, 랭킹 응답은 질의·조건·기준일·전체 후보 본문/메타데이터/순서·결과 제한·계약 버전이
같을 때 최대 128개·300초 재사용합니다. 모델·프롬프트·전처리 정책이 고정된 인스턴스끼리도 공유하지
않습니다. 전체 검색 결과 캐시는 아니며 Core의 현재 DB 조회·접수 상태 계산과 AI의 collection/전체 버전
검증·Qdrant 후보 조회는 매번 실행합니다. 준비 실패 시 캐시 조회 전에 오류를 반환합니다.
두 캐시는 검증된 정상 값만 복사 저장·반환하며 TTL은 성공 시점부터 계산합니다. 만료는 재사용 차단이며
물리적인 즉시 삭제 보장이 아닙니다. 같은 입력의 동시 요청만 합류하고 다른 입력은 병렬 처리합니다.
랭킹 대기자 하나의 취소는 공유 작업을 유지하고 마지막 대기자의 취소는 작업을 종료합니다. 임베딩 수행
요청이 취소되면 남은 요청이 다시 실행합니다. 실패는 저장하지 않으며 기존 오류·후보 수·배점·시간 상한은
유지합니다. 상세 범위는 [검색 지연 개선 기록](search-latency-20260908.md)을 참고하세요.

```text
GET /api/v1/support-programs/readiness
  → SupportProgramController → SupportProgramSearchReadinessService
  → SupportProgramRepository → MyBatis Mapper → Mapper XML → MySQL
  → 제공처별 공고 수·색인 준비·최근 동기화 시각과 전체 검색 범위를 반환
```

`support_program_sync_status`는 제공처별 공개 스냅샷의 세대·검색 문서 지문·공고 수와 색인 준비 상태를
최근 카탈로그 동기화 결과와 분리해 보관합니다. 제공처별 `indexReady=true`이면 공고 수가 0이어도 검색 가능합니다.
색인이 준비된 이전 스냅샷을 유지한 채 새 수집·사전 색인이 실패하면 `SEARCHABLE_WITH_SYNC_FAILURE`이며,
색인 준비가 확인되지 않은 공개/실패 상태는 `UNAVAILABLE`입니다.
공고 없는 초기 준비는 `PREPARING`, 상태 행 없이 공고가 남아 있는 복구 전 legacy는 `UNAVAILABLE`입니다.
시각은 서울 시계를 사용해 저장하고 API에서는 `+09:00` 오프셋이 포함된 ISO-8601 문자열로 반환합니다.

`SupportProgramSourceReadinessResult → SupportProgramSourceReadinessResponse` 변환으로 필수 `sources`와
전체 검색 범위를 제공합니다. 일부만 준비되면 `SEARCHABLE_WITH_PARTIAL_SOURCES`이며 외부 호출은 없습니다.
상태가 아직 없는 현재 공고의 제공처도 준비 미확인으로 표시합니다. 초기 빈 DB에서는 기업마당과
`KSTARTUP_SYNC_ENABLED=true`인 경우 K-Startup을 표시합니다. 하나가 준비 중이어도 준비된 제공처 검색은 유지합니다.
세부 정책과 검증은 [다중 제공처 준비](support-program-multi-source-preparation.md)에 있습니다.

점수화 계약은 `govbiz-support-program-ranking-v5`입니다. 의미 관련성 20/40점 이상을
충족해야 하며, `targetEligibility` 또는 `regionEligibility`가 `INCOMPATIBLE`이면 추천에서 제외합니다.
관련도는 `2 × (semanticRelevance 0~40 + supportTypeFit 0~10)`입니다. 자격·접수 상태를 가산점으로 쓰지 않습니다.
LLM 출력의 `targetAssessment`·`regionAssessment`는 자격 상태·설명·후보별 원문 조각 번호만 포함합니다.
미확인 자격 때문에 관련도가 낮아지거나 별도 총점 컷에서 탈락하지 않습니다.
Agent가 번호를 공식 API 본문의 `{field, quote}`로 복원하며 Core와 공개 HTTP 인용 계약은 유지합니다.
전체 `summary`·`targetDescription`도 그대로 모델에 제공해 조각 경계로 뒤쪽 조건·예외가 생략되지 않게 합니다.
후보 summary/targetDescription은 최대 6,000/2,000 code point이며 절단 여부를 별도로 전달합니다.
절단된 후보는 누락된 조건을 확인한 것처럼 판정하지 않도록 두 축 모두 `UNKNOWN`만 허용합니다.
`regions`는 후보 검색용 태그이지 자격 근거가 아닙니다. AI와 Core는 MATCH/INCOMPATIBLE의 본문 인용을 필수로
검증하며 실제 전달된 해당 필드의 정확한 부분 문자열만 인정합니다. 인용 존재 검증이 의미 판단을 보증하지는 않습니다.
지역 지침과 내부 schema는 회사·특정 사업장·개인 중 제한 주체를 먼저 구분하고 같은 주체의 주소를 비교합니다.
회사 주소로 본점·공장 주소나 개인 거주지를 확정하지 않습니다. 서울 기업·서초구 한정은 UNKNOWN이지만,
별도 허용 경로 없는 서울 기업·안산 관내 한정은 INCOMPATIBLE입니다. 본문에 없는 지점·이전 경로는 만들지 않고,
실제 허용된 대안 중 하나를 충족하면 다른 대안을 추가로 요구하지 않습니다. 충족 경로 없이 미확인 대안이 남으면
UNKNOWN이며, 확인된 회사 소재지 하나만으로 별도 사업장의 부재를 증명하지 않습니다.
이는 모델의 의미 판단 지침이며 독립적인 행정구역 필터가 아닙니다. 후속 변경은
[지역 충돌·Fast 기록](region-conflict-fast-20260908.md)에 정리합니다.
`UNKNOWN`은 확인 필요 배지로 구분하며 전체를 관련도순으로 표시합니다. 동점은 입력 후보 순서입니다.
검색당 최대 5개이며 공개 DTO의 `eligibilityReview`로 판정·설명·근거와 `OFFICIAL_API_TEXT` 범위를 노출합니다.
첨부파일을 자동 판독하거나 신청 자격을 확정하는 기능은 아닙니다. v5 점수화는 기존 DB·색인 구조와 호출 횟수를
유지합니다. C02 대화 해석은 사용자 확인 검색에 앞서는 별도 모델 호출입니다.
AI Service가 부적격 항목을 최종 응답에 넣으면 Core는 이를 응답 계약 위반으로 거부합니다.
결과가 0개인 것은 정상일 수 있으며 관련 없는 공고로 5개를 채우지 않습니다.

직접 필터 검색은 AI 추천과 분리된 공개 목록 경로입니다.

```text
필터 검색 탭 → ViewModel → BrowseSupportProgramsUseCase → Repository → GET /api/v1/support-programs/catalog
  → SupportProgramCatalogController → SupportProgramCatalogService
  → SupportProgramRepository.findPublishedPresent → MyBatis Mapper → Mapper XML → MySQL
```

공개 DB 스냅샷을 한 번 조회해 키워드·지역·분야·접수 상태·제공처로 필터링하고 정렬·페이지 처리를 합니다.
K-Startup은 업력·신청 대상·연령의 전용 분류도 정확히 비교합니다. 분류 메타데이터는 V7의 nullable JSON에
저장하고 `CatalogSupportProgram.startupDetails`로 복원하며, 공개 카드 DTO에는 AI 판단으로 노출하지 않습니다.
AI·임베딩·Qdrant·외부 제공처 API를 호출하지 않으며 색인 장애 후에도 이미 공개된 목록을 읽을 수 있습니다.
지역·분야는 제공처의 정확한 태그 일치이지 기업 자격 판정이 아닙니다. 결과에는 추천 점수나 자격 판정을 넣지 않습니다.
현재 규모에서는 기존 전체 스냅샷 조회에 전용 분류 매핑을 더해 재사용합니다. 트래픽·데이터 증가 시
실측에 따라 DB 필터/페이지 조회를 검토합니다. 입력·정렬·응답 계약은 [직접 조건 검색](support-program-catalog.md)을 참고하세요.

검색 카드의 상세 링크는 `/support-programs/detail?sourceCode={sourceCode}&sourceProgramId={id}`로
이동합니다. 상세 화면은 해당 URL의 식별자로 공개 상세 API를 다시 호출하므로 직접 진입·새로고침이 가능합니다.

```text
GET /api/v1/support-programs/detail
  → SupportProgramController → SupportProgramDetailService
  → SupportProgramRepository → MyBatis Mapper → Mapper XML → MySQL
```

상세 GET은 외부 API·AI를 호출하지 않습니다. 현재 노출된 복합 식별자 행만 반환하며 없는·미노출 행은
`SUPPORT_PROGRAM_NOT_FOUND`(404)입니다. 검색 문맥이 없으므로 추천 이유는 빈 배열, 점수는 `null`입니다.
공개 입력 제한과 JSON·오류 코드의 전체 계약은 [지원사업 API 계약](support-program-search-contract.md)에 있습니다.

### 공고별 공식 원문 근거 질문

기업마당 상세 화면의 **이 공고에 질문하기** 링크는
`/support-programs/detail/question?sourceCode={sourceCode}&sourceProgramId={id}`로 이동합니다.
질문 페이지는 URL 식별자를 검증하므로 직접 접속·새로고침이 가능하며 상세 화면으로 돌아가는 링크를
제공합니다. 페이지 진입 시 API를 호출하지 않고, 사용자가 질문을 제출할 때 아래 기존 API를 호출합니다.
질문 입력·답변·근거 인용·취소 상태는 질문 페이지의 로컬 상태이며 새로고침 시 초기화됩니다.

```text
POST /api/v1/support-programs/detail/answers
  → SupportProgramController → SupportProgramEvidenceService
  → SupportProgramDetailService → 현재 공개 공고 확인
  → SupportProgramRepository → MySQL의 공고별 원문 캐시 조회
  → 캐시가 없거나 URL이 바뀌었거나 6시간이 지남:
      BizInfoSupportProgramSourceDocumentFacade → BizInfoSourceDocumentClient
        → 기업마당 공식 HTTPS 상세 페이지의 HTML만 수집·읽기 가능한 텍스트로 정규화
      → SupportProgramRepository → MySQL 원문 UPSERT
  → 같은 공고 ID·내용 해시의 불변 청크 재사용 (Core 인스턴스별 최근 32개 공고)
    → 없으면 SupportProgramEvidenceChunker → 결정적 청크 최대 50개
  → AiSupportProgramEvidenceFacade → AI Service
      → 별도 Qdrant evidence 컬렉션에 청크 색인
      → 질문과 가까운 청크 최대 5개 검색 (동일 질문 임베딩은 최대 256개/300초 재사용)
      → 단일 typed Agent → OpenAI 근거 답변·짧은 인용 번호 선택
      → Agent가 검증한 번호를 요청의 원래 청크 ID로 복원
  → Core가 청크·인용을 검증 → 답변과 원문 발췌·URL 반환
```

이 경로는 `BIZINFO` 현재 공고에만 제공됩니다. 기업마당 공식 `https://bizinfo.go.kr` 및 그 하위 도메인의
상세 HTML만 허용하며, URL에는 요청한 원본 공고 ID와 같은 `pblancId`가 정확히 하나 있어야 합니다.
자동 리디렉션은 끄고 각 이동 URL을 같은 조건으로 검증해 최대 3회 따릅니다. 따라서 기존 상세 URL에서
`/sii/siia/selectSIIA200Detail.do?pblancId=...`로 이동할 수 있으며, 외부 호스트·비 HTTPS·다른 공고 ID·순환 이동은
거부합니다. 원문 HTML은 최대 500KB로 읽고 jsoup `1.23.2`로 파싱합니다. `.support_project_detail` 안의
`.title_area .title`이 요청 공고 제목과 일치해야 하며, `.view_cont` 본문만 추출해 메뉴·다른 공고·푸터를
제외합니다. 정규화 본문은 최대 30,000자로 제한합니다. 공식 원문을 성공적으로 읽고 검증한 뒤에만
짧은 DB transaction으로 저장하므로 원문 수집·AI 오류가 공고 동기화·목록 검색·상세 GET을 바꾸지 않습니다.
현재 공고의 제공처가 `BIZINFO`가 아니면 422 `SUPPORT_PROGRAM_EVIDENCE_NOT_SUPPORTED`, 공식 원문 수집·검증에
실패하면 503 `SUPPORT_PROGRAM_EVIDENCE_UNAVAILABLE`을 반환합니다. AI 근거 색인·검색·답변의 연결·시간 초과·계약
오류는 일반 AI 경계와 같은 502/503/504 분류를 사용합니다.

Frontend는 `KSTARTUP`을 포함한 비 `BIZINFO` 상세에서 질문 페이지 링크 대신 미지원 안내와 원문 링크를
표시합니다. 미지원 제공처의 질문 페이지에 직접 접속해도 입력을 표시하지 않고 ViewModel에서 전송을 차단합니다.
K-Startup 공식 URL 표시 허용은 원문 수집·RAG 지원과 별개입니다.

원문은 제목·공식 URL을 포함한 텍스트로 저장하며, 같은 원문은 요청마다 다시 수집하지 않고 최대 6시간
재사용합니다. 청크는 내용·원문 해시·순서에서 결정적으로 만들며 각 청크는 최대 1,500 UTF-16 코드 단위입니다. AI Service는
일반 공고 검색 컬렉션과 다른 Qdrant 컬렉션만 사용하고, 요청 공고의 청크 집합으로 검색 범위를 제한합니다.
답변이 충분한 근거를 찾지 못하면 `INSUFFICIENT_EVIDENCE`와 인용 없는 안내를 반환합니다. `ANSWERED`에는
검색된 청크의 인용이 하나 이상 있어야 하며 Core는 인용이 전달한 청크 밖을 가리키면 응답을 거부합니다.
인용 발췌문은 선택한 청크 전체를 반환해 청크 뒤쪽의 답변 근거도 화면에서 확인할 수 있습니다.

모델에는 64자리 해시를 복사시키지 않습니다. Agent가 이번 요청 배열에 `index`(0~4)를 붙여 전달하고
`SupportProgramEvidenceAnswerSelection.citationChunkIndexes`를 검증한 뒤 원래 `citationChunkIds`로 변환합니다.
`index`는 원문의 `order`와 다르며 요청마다 새로 부여합니다. 범위 초과·중복·상태 모순을 보정하거나 무시하지
않고 기존 오류로 반환합니다. Core와 공개 HTTP의 인용 계약은 변경하지 않습니다.

첨부파일·PDF·OCR·다른 제공처 원문 수집은 이 흐름에 포함하지 않습니다. 공고 목록 검색의 의미·키워드 후보 선정·AI
점수화와도 별도 사용 사례이므로, 원문 질문을 하지 않으면 기업마당 상세 HTML을 수집하거나 evidence 컬렉션을
사용하지 않습니다.

## 검색 품질 평가 fixture 내보내기와 캡처

```text
evaluation-fixture-export profile (비웹 실행)
  → findSearchablePresent로 준비된 제공처의 공개 공고 조회 → 지정한 referenceDate 기준 OPEN 공고만 선정
  → SupportProgramIndexDocumentMapper와 같은 ID·내용 해시·검색 문서 생성
  → 기준 날짜·전체 적격 카탈로그와 cases: []인 미라벨 fixture 초안을 원자적으로 JSON 기록
  → 질문을 고정하고 선택한 AI-only·혼합·사람 검토 방식으로 참조 라벨 확정

evaluation-capture profile (비웹 실행)
  → 질문 묶음 JSON 검증
  → 같은 referenceDate로 SupportProgramSearchService.searchWithTrace
      → 준비된 제공처의 현재 공고 → 기준 날짜의 적격 공고 → 의미·키워드 RRF 후보 최대 20개 → AI 최종 추천 최대 5개
  → 기준 날짜·질문별 후보 ID·최종 ID·카탈로그 지문을 원자적으로 JSON 기록
  → 별도 Python 평가 도구가 선택한 판정 출처의 fixture와 대조
```

두 경로 모두 공개 Controller나 디버그 HTTP endpoint가 아닙니다. `evaluation-fixture-export`는 자신의 웹 서버와
두 동기화 스케줄러를 끄고 공고 데이터는 MySQL에서만 조회합니다. 따라서 Qdrant·AI Service·OpenAI를 호출하지
않으며, 전체 카탈로그 검증이 끝난 뒤에만 출력 파일을 원자적으로 교체합니다. `referenceDate`는 실행 시각의
오늘이 아니라 신청 시작·종료일로 접수 상태를 다시 계산하는 평가 기준이며 생성 fixture에 함께 기록됩니다.
생성된 `cases: []`에는 고정 질문의 `id`·`query`·`split`과 선택한 판정 방식의 `relevantIds`를 채웁니다.
현재 공유 실행은 AI-only이며 사람 검토 정답으로 표시하지 않습니다. 질문 묶음의 `name`과 각
`id`·`query`·`split`은 fixture의 `cases`와 같은 순서·내용으로 맞춥니다.

`evaluation-capture` profile도 자신의 웹 서버와 두 동기화 스케줄러를 끄며, 모든 질문이 성공하고 캡처 중
카탈로그 지문이 같을 때만 출력 파일을 교체합니다. capture는 fixture와 같은 `referenceDate`를 명시해 같은
접수 상태 집합을 검색하며, Python 평가기는 두 날짜가 다르면 평가를 거부합니다. 별도 Core API 인스턴스가 카탈로그를 갱신한 경우에는 지문
변화로 결과 파일 기록을 거부합니다. 후보 ID는 `sourceCode:sourceProgramId` 형태이며, 첫 번째 `:` 앞의
`[A-Z][A-Z0-9_]{0,63}` 제공처 코드와 뒤의 원본 ID를 함께 사용합니다. 같은 Search Service가 만든
후보·최종 결과를 기록하므로 평가 코드가 운영 검색 흐름을 별도로 재현하지 않습니다. 실제 AI Service를
호출할 수 있으므로 기본 실행·CI에는 포함하지 않습니다. fixture 내보내기·라벨·캡처·평가 실행 규칙은
[검색 평가 자료](../evaluation/support-program-search/README.md)를 따릅니다.
새 fixture/capture는 같은 준비된 제공처 범위를 사용합니다. 기존 고정 평가 스냅샷·원표·캡처는 당시의
입력과 실행 결과로 보존하며, 이번 상태 필터를 소급 적용하거나 과거 지표를 다시 해석하지 않습니다.

## 기업마당 동기화와 공개 순서

```text
BizInfoSupportProgramCatalogSyncScheduler (기본: 최초 PT0S, 완료 후 PT6H)
  → Repository: 수집 시작 세대 발급 [짧은 DB transaction]
  → BizInfoSupportProgramCatalogFacade → BizInfoClient: 전체 페이지 수집·검증
  → BizInfoProgramMapper: 필수 필드 검증·공고 정규화
  → SupportProgramIndexSyncService.indexSnapshot: 모든 공고의 두 색인 준비
      → ElasticsearchSupportProgramClient → Elasticsearch: 불변 버전 추가·검색 가시성 검증
      → AiSupportProgramIndexClient → AI Service → OpenAI 임베딩 → Qdrant
  → Repository: 최신 시작 세대일 때만 MySQL에 공개 [짧은 DB transaction]
      → BIZINFO 기존 행 미노출 처리 + 수집 목록 UPSERT
      → 공개 세대·카탈로그 지문·공고 수·indexReady·성공 시각 기록
```

공공데이터포털의 전체 건수, 페이지 번호·크기, 페이지별 항목 수와 실제 수집 수가 일치해야 합니다.
기업마당 수집·응답 검증·필수 필드 정규화 중 하나라도 실패하면 카탈로그를 바꾸지 않습니다.
현재 Client는 페이지당 1,000건을 요청하며 최대 20페이지·20,000건으로 제한합니다.

Elasticsearch는 64개 단위로 버전 존재 여부를 확인하고 없는 버전을 준비합니다. 이어 Qdrant 색인은
전체 공고를 16개씩 나누어 AI Service에 요청합니다. AI Service는 동일 ID·해시의 벡터가 이미 있으면 재사용하고
없는 버전만 생성합니다. 모든 배치의 성공과 처리 건수를 확인한 후에만 DB 공개를 시도합니다.
색인 도중 실패하면 현재 세대일 때만 실패 시각을 기록하고 기존 공개 카탈로그·그 스냅샷의 색인 준비 상태를
유지합니다. 이미 준비된 벡터는 재시도 시 재사용할 수 있습니다. 더 최신 세대가 시작되면 이전 세대의
성공·실패 기록 모두 무시합니다.

MySQL의 `support_program_sync_generation`은 제공처별 최신 **시작** 세대를 관리합니다. 이전 실행이 늦게
끝나도 더 최근에 시작된 작업이 있으면 공개를 건너뜁니다. 후발 작업이 실패하더라도 이전 세대가 다시
공개 권한을 얻지는 않으며 마지막으로 공개된 카탈로그를 다음 성공까지 유지합니다.

시작 세대 발급과 공개는 각각 행 잠금을 사용하는 짧은 DB transaction입니다. 공개 transaction 안의
미노출 처리·UPSERT·상태 행 성공 기록 중 하나라도 실패하면 전체를 rollback합니다. 외부 HTTP 수집·색인은 DB
transaction 밖에서 실행하며, 수집 실패를 이유로 기존 행을 삭제하거나 다른 제공처 데이터를 변경하지 않습니다.
동기화 Service가 수집·사전 색인·공개 과정의 RuntimeException을 한 번 기록한 뒤 Scheduler가 다음 주기에 계속 실행합니다.

## 키워드·벡터 색인 정합성과 복구

Elasticsearch 버전 식별자·Nori/BM25 설정·장애 경계·`V24` 이후 재색인 절차는
[Elasticsearch 적용 상세](elasticsearch-lexical-search.md)에 설명합니다. 정기 복구와 공개 전 준비는
Elasticsearch를 먼저, 이어 Qdrant를 확인하며 모두 성공해야 `indexReady=true`입니다.
분석기 v2는 별도 인덱스로 재색인하며 v1을 수정하지 않습니다. `여행사/여행업체` 확장은 ES 검색 분석기에서만
수행하고, 공유 본문·내용 해시·Qdrant·RRF·AI 랭킹 계약은 바꾸지 않습니다. 지역·업종의 신청 자격 추론은 포함하지 않습니다.

두 Client Mapper가 공유하는 `SupportProgramIndexTextHelper`가 제목·기관·지원 대상·분야·지역·신청 기간 원문·요약으로 검색 문서를
구성합니다. 제어·형식 문자는 개행·탭을 제외하고 정리하며 Unicode 코드 포인트 기준 최대 12,000자로
제한합니다. UTF-8 문서의 SHA-256이 내용 해시이고, 내부 문서 ID는
`{sourceCode}:{sourceProgramId}`입니다.

AI Service는 문서 ID·내용 해시에서 Qdrant point ID를 결정하며, 임베딩 모델·차원·색인 규격에 따라
컬렉션을 분리합니다. 현재 DB의 정확한 문서 버전에 해당하는 point ID만 검색하도록 필터링하므로
이전 버전·미노출 공고·아직 공개하지 않은 세대의 벡터는 결과에 섞이지 않습니다.

```text
SupportProgramIndexSyncScheduler (기본: 최초 PT0S, 완료 후 PT1M)
  → SupportProgramIndexSyncService.repair
  → Repository: 현재 MySQL 공개 공고 목록·제공처별 상태 조회
  → 제공처별로 Elasticsearch 누락 버전 준비 → AI Service: 해당 버전의 누락 벡터 생성·저장
  → 해당 제공처 상태의 공개 세대·지문·공고 수가 읽은 스냅샷과 같을 때만 indexReady 갱신
  → 한 제공처 실패 이후에도 다른 제공처를 처리하고, 완료 후 실패를 오류로 전달
```

복구는 제공처 수집과 별도 단일 스레드에서 실행합니다. `SUPPORT_PROGRAM_INDEX_ENABLED=false`는
이 복구 작업만 끄며, 새 카탈로그 공개 전의 필수 색인은 끄지 않습니다.
공고가 0개인 공개 스냅샷도 제공처 상태를 기준으로 처리하고, legacy 채택도 제공처별로 수행합니다.

복구 색인이 실패하면 자신이 읽은 스냅샷과 상태 행이 여전히 같을 때만 `indexReady=false`로 바꾸며,
최근 카탈로그 동기화 성공·실패 기록은 바꾸지 않습니다. 복구가 늦게 끝난 동안 새 스냅샷이 공개되면 조건부
UPDATE가 0행이 되어 새 스냅샷 상태를 건드리지 않습니다. 이 상태는 마지막 전체 색인 준비 결과이며 실시간
Elasticsearch/Qdrant Health를 뜻하지는 않습니다.

공개 준비와 복구는 모두 `prune`을 호출하지 않습니다. 이전 스냅샷 기준의 삭제가 공개 준비 중인 새 벡터를
지우는 상황을 피하기 위해 현재 자동 삭제를 연결하지 않았습니다. 내부 `prune` API는 존재하지만,
안전한 보존·삭제 수명주기와 전체 다중 인스턴스 운영 검증은 후속 과제입니다.

검색 대상의 벡터가 하나라도 없거나 Qdrant·AI Service가 실패하면 일부 후보만으로 성공하지 않고 오류를
반환합니다. 별도 복구 작업의 성공 후 다시 검색할 수 있습니다. 빈 검색어 목록과 상세는 AI에 의존하지 않습니다.
조회 때 변하는 접수 상태는 벡터에 고정하지 않으며, DB의 `content_hash` 컬럼도 영속 색인 완료 기록으로
사용하지 않습니다. 현재 검색은 매번 전체 대상 공고와 ID·해시 목록을 읽고 전송하므로 대규모 데이터 성능은
별도 개선이 필요합니다.

## 데이터와 접수 상태

MySQL의 `support_program`은 `(source_code, source_program_id)` 고유키로 원본 공고를 식별합니다.
`categories`·`regions`는 JSON, 신청 기간은 원문과 nullable 날짜로 저장합니다. 원본에서 사라진 공고는
삭제하지 않고 `is_source_present=false`로 바꿉니다. UPSERT는 대소문자만 바뀐 원본 ID도 최신 표기로
갱신하여 MySQL과 벡터 식별자를 맞춥니다. 고유키 비교는 MySQL의 `utf8mb4_0900_ai_ci` collation을 따릅니다.

`support_program_source_document`는 원문 근거 답변에만 쓰는 공고별 공식 HTML 정규화 텍스트·원문 URL·해시·수집
시각을 같은 복합 식별자로 저장하고 공고를 FK로 참조합니다. 조회 시 공고의 공개 상태를 확인하므로 미노출 공고에는
원문 질문을 제공하지 않습니다. 이 테이블은 정기 목록 동기화에서 채우지 않고 명시적 원문 질문의 수집·검증이
성공했을 때 UPSERT합니다.

`application_form_snapshot`은 동적으로 발견한 공식 첨부의 양식 manifest JSON과 파일 hash, 파서·추출 모델·프롬프트 버전을
공고별 불변 버전으로 저장합니다. `application_preparation`은 계정별 작업 ID, 선택한 양식 버전·분야와 입력 revision을 저장하고
스냅샷 또는 기존 배포 manifest와 결합합니다. 모든 공개 응답은 `institutionReviewed=false`를 유지합니다.
현재 공고 카탈로그 행에 FK를 걸지 않아 접수 종료 후 카탈로그에서 빠진 공고의 저장 작업도 다시 읽습니다.
`application_preparation_fact`는 문항·고정 필드별 현재 사용자 확인 값과 원문, PROVIDED/UNKNOWN, 입력 revision을 저장합니다.
`application_preparation_interpretation_run`은 요청 키의 중복 실행을 막고 당시 입력과 AI 제안·모델·프롬프트 버전, 성공·실패를
JSON 스냅샷으로 보존합니다. 두 테이블은 준비 건 삭제 시 함께 삭제되며, AI 호출 자체는 이 transaction들 사이에서 수행됩니다.

`support_program_sync_status`는 제공처별 스냅샷의 공개 세대·지문·공고 수를 기록합니다.
V4 적용 전부터 있던 공고는 과거 공개 세대를 복원하지 않습니다. 대신 해당 제공처의 현재 공개 공고가 1건 이상인 경우에
한해, 전체 복구 색인이 성공한 뒤 그때 읽은 지문·공고 수를 sentinel 세대 `0`으로 조건부 채택할 수 있습니다.
빈 초기 DB는 `PREPARING`, 복구 전 legacy 공고는 `UNAVAILABLE`이며, 실제 지문이 있는 새 스냅샷은 bootstrap이 덮어쓰지 않습니다.

`account`·`account_session`(V5)은 회원 계정을 저장합니다. `account`는 소문자로 정규화한 이메일을 고유키로 두고
비밀번호 해시, 역할(`USER`·`ADMIN`), 이메일 인증·정지·삭제 시각과 약관 동의 시각을 저장합니다. 삭제된 계정은 모든
조회에서 제외하고 정지된 계정은 로그인과 세션 확인을 403으로 막습니다. `account_session`은 세션 JWT의 SHA-256
해시와 절대 만료·마지막 사용 시각만 저장하고 계정 삭제 시 함께 삭제됩니다. 이메일 중복은 DB UNIQUE 제약이 막고,
절대·유휴 만료 여부는 서울 기준 시계로 조회 시점에 판단합니다. 기업 테이블은 기업 등록 단계에서 추가합니다.

접수 상태는 `SupportProgramStatusResolver`가 읽을 때 계산합니다. 파싱된 시작일 전은 `UPCOMING`,
종료일 이후는 `CLOSED`, 시작일·종료일 범위 안은 `OPEN`입니다. 날짜 경계는 포함합니다.
날짜만으로 결정되지 않은 경우 예정 표현, 남아 있는 종료일, 명시적 종료 표현, 상시 접수 표현 등의
규칙을 순서대로 적용하고 판단 근거가 없으면 `UNKNOWN`을 유지합니다. 따라서 `접수 종료` 표현이
상시 접수보다 우선하더라도 파싱된 날짜를 무조건 덮어쓰지는 않습니다.

수집 Client·동기화는 `BIZINFO`·`KSTARTUP`·`MSIT`·`CNTRADE_NOTICE`별로 구현됩니다. production 검색·색인·AI 점수화는
`sourceCode:sourceProgramId`를 내부 식별자로 사용하고 검색은 준비된 제공처 범위에서 실행합니다.
K-Startup은 별도 구체 Client·Facade·SyncService·Scheduler를 사용하고 기존 색인 Service·Repository를 공유합니다.
제공처별 Facade는 명시적 Qualifier로 구분하며 제공처 Registry나 새 production 의존성은 추가하지 않습니다.

초기 데이터만 한 번 반영할 때는 별도 `catalog-sync-once` CLI 프로필을 사용합니다. 흐름은
`CLI → SupportProgramCatalogSyncOnceService → 제공처 Facade/Client 전체 수집 → 비용 상한 검사 →
SupportProgramIndexSyncService(Elasticsearch·AI Service/OpenAI/Qdrant) → Repository/MyBatis/MySQL 공개`입니다.
합산 비용 검사 전에는 DB 쓰기와 유료 호출을 하지 않으며, 검사한 동일 스냅샷을 사용합니다.
전용 프로필은 Bean 생성 전에 자동 수집·복구·큐/메일 작업과 Flyway를 비활성화하고 HTTP 서버 없이 종료합니다.
적용 직전 호스트에 영속화한 배타적 receipt로 중복 실행을 막습니다. 실패한 시도도 자동 재시도하지 않습니다.
일반 API 서버 설정/공개 HTTP 계약은 바뀌지 않습니다. 모델·예산 전제와 실행법은
[Core API 일회성 수집](../backend/core-service/README.md#예산을-지정한-일회성-수집)을 참고하세요.

## K-Startup 수집 범위와 추가 분류

`KStartupSupportProgramCatalogSyncScheduler → KStartupSupportProgramCatalogSyncService →
KStartupSupportProgramCatalogFacade → KStartupClient → KStartupProgramMapper`에서 수집·검증한 뒤,
기업마당과 같은 `SupportProgramIndexSyncService`에서 Elasticsearch 키워드 색인을 먼저 준비한 뒤
`AI Service → OpenAI 임베딩 → Qdrant`로 벡터를 준비합니다. 같은 버전은 재사용합니다.
전체 색인 성공 후 Repository가 `KSTARTUP` 범위만 UPSERT·누락 비활성화·공개 상태 갱신합니다.

- 공식 API: `getAnnouncementInformation01`. 안정 ID는 `pbanc_sn`이며 화면 순번 `id`를 쓰지 않습니다.
- `KSTARTUP_SYNC_ENABLED=false`가 기본입니다. `KSTARTUP_API_KEY`와 초기 색인 비용을 확인한 뒤 켭니다.
- `RECENT_YEAR`는 서울 기준 오늘에서 1년 전 날짜를 API의 `cond[pbanc_rcpt_bgng_dt::GTE]`에 전달합니다.
  `KSTARTUP_SYNC_SCOPE=RECENT_THREE_MONTHS`는 같은 조건에 3개월 전 날짜를 전달하는 선택 옵션이며 기본값은 1년입니다.
  3개월은 90일 고정이 아니라 달력 기준으로 계산합니다. `OPEN`은 API의 모집 중 공고만 수집합니다.
  `ALL` 상태 필터는 전체 과거 이력이 아니라 이렇게 수집·공개된 범위 전체를 뜻합니다.
- API 날짜 조건을 실제 응답의 접수 시작일 하한으로 단정하지 않습니다. 2026-09-09 실수집에서는
  `20250909` 조건 응답 4,143건 중 325건이 그보다 먼저 시작했고, 모두 종료일이 기준일 이후였습니다.
  현재 수집기는 검증한 API 응답을 보존하며 시작일만으로 추가 제외하지 않습니다.
  [세 제공처 실수집·벡터 검증 기록](support-program-catalog.md)에 당시 결과를 정리합니다.
- 첫 페이지의 날짜 조건을 전체 수집 동안 고정합니다. 전체 이력 `totalCount`가 아닌 조건 일치 `matchCount`로
  페이지 수를 계산하고 각 페이지의 번호·크기·건수·전체 건수·ID 중복을 검증합니다. 실패 시 기존 목록을 보존합니다.
- 페이지당 1,000건 요청, 최대 20,000건·200페이지 안전 한도를 적용합니다. 전체 제공처 검색 후보 한도도 20,000건이므로
  전체 과거 이력 확장은 별도 성능·계약 검토가 필요합니다.
- 원문 `aply_trgt_ctnt`·`aply_excl_trgt_ctnt`만 대상 설명에 보존해 후보 자격 검토에 전달합니다.
  대상·업력·연령 분류는 별도 메타데이터와 벡터 검색 문서에만 넣고, 자격 근거 필드에는 합치지 않습니다.
  분류는 자격 충족의 증거가 아니며 원문 조건을 우선합니다.
- 공식 HTTPS 상세 URL의 호스트와 `pbancSn`이 원본 ID와 일치해야 합니다. 상세 HTML 추가 질문은 여전히 미지원입니다.
- 게시일이 없어 접수 시작일로 최신 정렬합니다. 제공처 간 같은 사업을 자동 병합하지 않습니다.

## 과기정통부·충청남도 수출입공지 수집

각 `Msit`/`CnTradeNotice` Scheduler → SyncService → CatalogFacade → Client → Mapper에서 전체 수집을
검증하고, 기존 `SupportProgramIndexSyncService`에서 Elasticsearch 키워드 색인과
`AI Service → OpenAI 임베딩 → Qdrant` 벡터 색인을 순서대로 준비한 뒤
Repository가 해당 `source_code`만 UPSERT·누락 비활성화·스냅샷 공개합니다. DB migration이나 신규 의존성은 없습니다.

- MSIT의 `response` 배열(header/body)과 충남의 최상위 `09/RETURN_SUCCESS` 응답을 별도로 검증합니다.
  첫 페이지와 각 페이지의 전체 건수·번호·실제 크기·행 수·중복 ID가 일치해야 하며 HTTP 200의 게이트웨이 오류도 실패입니다.
- MSIT는 공식 `msit.go.kr` 사업공고 상세 URL의 게시판 100/`nttSeqNo`를 검증해 ID로 사용합니다.
  실응답의 10건 페이지를 끝까지 읽으며 20,000건/2,000페이지 한도를 적용합니다. 장시간 수집은 전용 단일 스레드로 격리합니다.
- 충남은 `lbbNo`를 ID로 사용하며 1,000건을 요청하되 실제 응답 페이지 크기를 기준으로 완전성을 검증합니다.
  20,000건/200페이지 한도입니다. 숫자 ID로 암호화된 웹 상세 `idx`를 추측하지 않고 검증된 공식 공지 목록에 연결합니다.
- API에 없는 접수 기간/지역/분야는 추정하지 않습니다. 게시일은 정렬용이고 상태는 `UNKNOWN`입니다.
  MSIT는 본문 없이 제목·담당 부서 기반 검색이며 충남은 원문 본문 기반입니다. 선정 결과·일반 공지도 원본대로 포함됩니다.
- 두 수집기 기본 비활성, 전용 키 생략 시 승인된 `DATA_GO_KR_SERVICE_KEY`를 재사용합니다.
  평가 fixture/capture 프로필은 개발 환경변수와 관계없이 두 수집기도 끕니다.
- 수집기 구현과 실제 서비스 정상화는 별개입니다. 2026-09-09 CNTRADE_NOTICE 실 API의 `04 HTTP_ERROR`는
  빈 정상 결과로 숨기지 않으며, 제공처 복구 전에는 실제 수집 성공을 주장하지 않습니다.

## Frontend와 내부 계약

Frontend의 업무 호출 흐름은 `View → ViewModel Hook → UseCase → Repository → data/api → Core API`이며,
채팅 검색에서는 페이지 ViewModel과 UseCase 사이에 내부 채팅 Hook을 둡니다.
Awilix의 `app/di`에서 Repository·UseCase·외부 함수를 구성하고 `appContainer`가 앱 단위 인스턴스를
제공합니다. ViewModel 또는 내부 Hook은 UseCase·외부 함수 토큰을 조회하며 Repository를 직접 생성하지 않습니다.
`data/api`의 함수가 요청 URL·Fetch·Zod 응답 검증을 담당합니다.

화면 기능은 `presentation/features/chat`의 채팅 검색, `presentation/features/support-program-detail`의
상세 조회·원문 근거 질문, `application-preparation`의 신청 준비 생성·목록·상세, 그리고 `auth`(로그인·회원가입)·`pricing`·`partner-recruitment`·`company-profile`·`admin`의
계정 관련 화면으로 나눕니다. 각 feature가 전용 View·스타일·ViewModel·테스트를 소유하고,
서로의 화면 구현을 import하지 않습니다. 검색 카드와 상세 화면은 기존 상세 URL·복합 식별자로 연결합니다.
검색과 근거 질문이 함께 쓰는 안전한 오류 문구는 `presentation/shared/support-program`에 둡니다.
`support-program-detail` 안에서도 상세 조회와 질문은 별도 페이지입니다. `SupportProgramDetailPage`는
`useSupportProgramDetailViewModel`, `SupportProgramEvidenceQuestionPage`는
`useSupportProgramEvidenceQuestionViewModel`을 각각 사용하고 URL의 복합 식별자로 이동합니다.

채팅 메시지·검색 조건은 Redux Toolkit으로 관리하고 검색 요청 흐름은 내부 채팅 Hook의 thunk에 둡니다.
기업 조건은 폼에서 직접 적용하거나 C02 변경 제안을 확인해 적용하며 현재 대화의 메모리에만 보관합니다.
검색 요청마다 그 시점의 적용 조건을 사용하고, 새 대화·브라우저 새로고침으로 초기화됩니다.
C02는 확정 조건·새 발화·미확정 제안 또는 질문·최근 완료 검색 요약을 해석하며 화면의 전체 메시지를 다시 전송하지 않습니다.
검색 결과 설명은 대화에 표시하며 자동 검색이나 조건 변경을 일으키지 않습니다. 미확정 초안·질문·검색 의도와 적용 조건을 구분합니다. 로그인 세션은 아래 계정과 세션 절에 있고 프로필 영속 저장은 후속 범위입니다.
`ChatPage`는 페이지 ViewModel인 `viewmodel/useChatPageViewModel` 하나를 사용합니다. 이 ViewModel은
`hooks/useSupportProgramChat`의 Redux 상태·검색 요청 수명과 `hooks/useSupportProgramSearchReadiness`의
준비 상태 조회·polling을 조합합니다. 페이지 ViewModel은
검색 확인·검색 재시도만 준비 상태에 따라 제한하며 메시지 제출·추천 질문·다시 해석은 이와 독립적으로 처리합니다.
페이지 ViewModel은 DOM 참조·입력 조합·
포커스·스크롤도 Hook 로컬로 관리합니다. View는 렌더링·이벤트 연결·순수 표시용 포맷을 담당합니다.
조건 제안은 ViewModel의 `chatConversationProposal` 순수 변환이 요청 당시 조건을 기준으로 변경·유지·적용 값을
계산하며, `ChatPage`는 원본 해석 결과나 미확정 질문 대신 최종 `displayProposal`을 받습니다.
`ConversationProposal`과 `ProgramResults`는 각각 제안·결과를 표시하는 View 컴포넌트입니다.
카드·결과 집계의 자격 분류는 기존 `supportProgramEligibility`에서, 상세 URL 생성은 공용 routes에서 공유합니다.
React Router는 `/` 아래 공개 화면(검색·요금제·공개 파트너 모집·지원사업 상세), 로그인·회원가입, `/app` 아래 회원 세션이 필요한
작업 화면(작업 채팅·요금제·파트너 모집·프로필·관리자)과 두 SampleItem 예제 화면을 연결합니다. SampleItem은 업무 기능이 아니라 같은 UseCase의
Hook 상태와 Redux 상태 차이를 비교하는 예제입니다.

Core의 공개 계약은 기능별 `controller/dto`, 외부 계약은 시스템별 `client/dto`, 검증된 실행 결과는
`service/dto`, 업무 모델은 `domain`에 둡니다. 관계형 DB 접근은 `Repository → Mapper → XML`이며
`DbRow`를 Repository 밖으로 노출하지 않습니다. 같은 필드가 있어도 외부 입력과 공개 응답을 하나의
타입으로 합치지 않습니다. 상세 배치 규칙은 [Core API README](../backend/core-service/README.md)에 있습니다.

AI Service는 조건 변경 해석·점수화·원문 근거 답변에서 각각 `HTTP API → Service → Agent → LangChain → OpenAI → Response` 흐름으로
실행합니다. `bootstrap.py`가 클라이언트와 서비스 수명주기를 구성하고, 역할이 다른 Agent가 각각
`ChatPromptTemplate | ChatOpenAI.bind(...)` 체인으로 strict structured output을 한 번 요청합니다. 도우미 도구 에이전트(`app/assistant_agent`)만 예외로 LangGraph 그래프
(`classify → plan ⇄ tools → answer → verify`, 관심 공고 묶음 질문은 `retrieve → map → reduce → verify` 서브그래프)를 쓰며
도구는 Core 내부 읽기 API 세 개와 기존 근거 컬렉션의 문서 id 제한 검색뿐입니다. 그 밖의 tool·handoff·multi-agent orchestration은 없습니다. 일반 공고 색인·검색은
`support_program_index`, 원문 청크 색인·검색은 `support_program_evidence`가 OpenAI 임베딩과 분리된 Qdrant
컬렉션을 직접 사용합니다.
공고 추천은 Qdrant·Elasticsearch 검색 후 Core가 병합·검증한 공식 후보를, 상세 질의응답은
Qdrant 검색 후 Core가 ID·내용 해시·문서 ID를 검증하고 복원한 원문 청크를 LangChain 프롬프트의
근거로 사용합니다. 조건 해석은 이 검색 전에 실행됩니다. 검색·생성을 연결하는 기존 Core 경계와
임베딩 원시 응답 검증을 유지하며 LangChain 적용을 위해 컬렉션을 교체하거나 재색인하지 않습니다.
세 Agent의 공유 실행 함수는 `support_program_llm.py`에 있으며 완료 상태·거부·JSON 전체를 엄격히 검증하고,
LangSmith 추적·응답 저장·자동 재시도를 사용하지 않습니다.

랭킹 모델은 `OPENAI_RANKING_MODEL`로 지정하고 미설정이면 공통 `OPENAI_MODEL`을 상속합니다.
`OPENAI_RANKING_REASONING_EFFORT`는 `none`/`low`만 허용합니다. 제공 설정 예제는 비용 절감을 위해 랭킹도
Luna/low를 사용하며 대화·원문 답변 모델은 바꾸지 않습니다. 모델 객체는 분리하되 동일한 OpenAI
클라이언트·인증·재시도 정책을 공유하며 새 provider는 없습니다. orchestration 계층은 위 도우미 도구 에이전트의 LangGraph 하나뿐입니다.
도우미 자유 질문 분류는 `OPENAI_ASSISTANT_MODEL`(기본 `gpt-5-nano`, 추론 `low`)로 가장 싼 모델을 따로 씁니다.
출력 축약은 미채택이며 기존 후보 ID·필드명·출력 계약을 유지합니다. 축약 구현은 평가 경로에만 남깁니다.
`OPENAI_RANKING_SERVICE_TIER` 미설정 시 코드·Compose 기본값은 `default`입니다. 제공 `.env.example`은
기존 Fast 상시 사용 프로필인 `priority`를 유지합니다. 일반 처리보다 추가 요금이 있으며 일반 처리는 `default`로 지정합니다.
랭킹 요청에만 적용하고 대화 해석·RAG 답변·임베딩 설정은 바꾸지 않습니다. 후보·점수·출력/시간 상한은 유지합니다.
모델 교체는 토큰 단가 절감이며 토큰 수나 품질·속도의 개선을 보장하지 않습니다.
이전 Sol의 배포·실측은 [지역 충돌·Fast 기록](region-conflict-fast-20260908.md)에 보존하며 Luna 평가 결과로 재해석하지 않습니다.

두 색인 Service가 실제로 공유하는 입력 토큰 상한 처리는 `support_program_embedding.py`의 함수 하나로
유지합니다. 토크나이저 준비·인코딩·잘라내기를 작업 스레드에서 실행해 HTTP 이벤트 루프를 막지 않으며,
OpenAI 호출·응답 검증·오류 처리는 각 Service에 남겨 둡니다.

추천 점수화는 전용 설정으로 모델 `45s` → Agent 실행 `50s` → Core 읽기 `55s`를 사용합니다.
조건 해석·근거 답변은 기존 모델 `25s` → Agent 실행 `30s` → Core 읽기 `35s`를 유지합니다.
중복 지원 검토는 모델 `60s` → Agent 실행 `70s` → 전용 Core 읽기 `75s`를 사용하고 timeout을 AI 내부 504와 안전한 진단 로그로 구분합니다.
AI Health도 Core의 기존 공유 읽기 설정을 사용합니다. 공고 의미 검색 전체는 AI에서 `25s`, Core 읽기는
`30s`이며, 검색 화면은 의미 검색과 점수화의 순차 호출을 고려해 `90s` 후 요청을 취소합니다.
C02 해석은 별도 `40s` 제한이며 사용자 확인을 사이에 두므로 검색 요청에 해석을 합치지 않습니다.
이 값은 시간 예산이며 성능 목표가 아닙니다. 랭킹의 전용 RestClient 외에는 기존 의존 방향을 유지합니다.

## 계정과 세션

계정 흐름은 `AccountAuthController → AccountSignupService · AccountLoginService · AccountSessionService → AccountRepository → MySQL`입니다.
회원가입은 이메일·비밀번호만 받아 BCrypt 해시와 약관 동의 시각을 저장하고 같은 요청에서 세션을 발급합니다. 이메일 중복은 DB unique
제약의 `DuplicateKeyException`을 Service가 409로 바꿉니다.
사업자등록번호 확인은 `BusinessLookupController → BusinessLookupService → BiznoClient`로 외부 HTTP를 한 번 부르고,
`BiznoClient`가 응답 검증과 오류를 `BiznoClientException`으로 바꿔 API 키가 담긴 URL이 로그·응답에 남지 않게 합니다.
기업 등록은 `CompanyController → CompanyService → BiznoClient(사업자등록번호 조회) · CompanyRepository → MySQL`입니다. 서버가 등록 시점에
사업자등록번호를 다시 조회해 계속사업자만 저장하고, 계정 조회는 `company`를 LEFT JOIN해 요약과 `tier=COMPANY`를 계산합니다.
파트너 모집글은 `partner` 기능의 `PartnerRecruitmentController → PartnerRecruitmentService → PartnerRecruitmentRepository → MySQL`입니다.
Service가 세션 계정의 기업, `support_program`에 현재 있는 공고, 접수 상태(`SupportProgramStatusResolver`), 마감일 규칙을 확인한 뒤 저장하고,
공고당 한 건은 DB UNIQUE 제약이 보장합니다. 목록·상세는 기업·계정·공고를 JOIN해 읽고 모집 상태는 저장하지 않고 조회 시점에 계산합니다.
파트너 제안은 `PartnerProposalController · PartnerProposalBoxController → PartnerProposalService → PartnerProposalRepository → MySQL`입니다.
Service가 제안자의 기업, 모집글의 모집 상태, 당사자 여부를 확인하고, 수락·거절·철회는 `decision IS NULL AND withdrawn_at IS NULL`
조건의 UPDATE 영향 행 수로 동시 처리를 막습니다. 제안 상태와 담당자 연락처 공개 여부는 `PartnerProposal` 도메인이 응답·철회·경과 시간·모집 상태로
계산하며, 모집글 응답의 제안 수·내 제안은 `PartnerRecruitmentService`가 두 Repository를 묶어 붙입니다.
로그인 성공 시 `SessionTokenHelper`가 계정 ID를 `sub`로 하는 HS256 JWT를 발급하고, DB에는 토큰의 SHA-256 해시와
만료 시각만 저장합니다. 로그인이 필요한 Controller는 `Account` 파라미터를 선언하며
`AuthenticatedAccountArgumentResolver`가 HttpOnly 세션 쿠키(`govbiz_session`)의 서명·만료를 검사한 뒤 세션 행으로 계정을
채웁니다. 토큰은 응답 본문에 싣지 않고 쿠키로만 전달하며, 쿠키가 붙은 상태 변경 요청은 `SameSite=Lax`와
`SessionOriginInterceptor`의 Origin 검사로 CSRF를 막습니다. 로그인 시도는 `AccountLoginAttemptGuard`가 계정·접속 주소
기준으로 제한합니다. 세션 행이 없으면(로그아웃) JWT가 유효해도 401이고, "로그인 상태 유지" 여부에 따라 30일 또는 12시간의
절대 만료와 7일 유휴 만료를 함께 검사합니다. 화면 권한 단계(`tier`)는 `Account`가 역할·인증 상태로 계산해 `/me`에
내려 주고, 프런트의 `RequireAuth`는 이 값으로만 `/app` 아래 라우트를 나누며 서버가 모든 쓰기 API에서 다시 검사합니다.
Spring Security filter chain은 쓰지 않고 `spring-security-crypto`의 BCrypt만 사용합니다. 개발용 시드 로그인은
설정이 켜졌을 때만 별도 Controller가 등록되며 관리자·회원 시드 계정을 만듭니다.

Frontend에서 로그인 상태는 헤더와 여러 화면이 함께 읽으므로 `presentation/shared/auth`의 Redux slice와
`useAuthSession`·`useRestoreAuthSession` Hook이 소유하고, 로그인 화면은 `presentation/features/auth`가 소유합니다.
받은 제안함도 사이드바 배지·제안함 화면·모집글 상세가 함께 읽고 제안함 화면이 수락·거절로 바꾸므로 `presentation/shared/partner-proposal`의
Redux `receivedProposals` slice와 `useReceivedProposals` Hook이 계정당 한 번 조회해 소유합니다. 한 화면만 쓰는 서버 데이터(모집글 목록·상세, 보낸 제안함)는
Hook 로컬 상태로 두는 것이 규칙입니다.
세션 토큰은 브라우저의 HttpOnly 쿠키가 관리하므로 앱은 다루지 않고, `data/storage`에는 앱 시작 시 `/me`를 부를지
정하는 힌트만 둡니다. Repository가 로그인·로그아웃과 함께 힌트를 저장·삭제합니다.
화면은 로그인 전 `/` 아래 공개 경로(공용 헤더)와 로그인 뒤 `/app` 아래 내부 경로(사이드바)로 나뉩니다. `PublicOnly`는
로그인한 사용자를 공개 URL에서 같은 내용의 `/app` 화면으로, `GuestOnly`는 로그인·회원가입에서 복귀 경로로, `RequireAuth`는
비로그인 사용자를 `/login?next=`로 보냅니다. 경로 상수와 공개↔내부 대응은 `presentation/shared/routes/appPaths.ts`가 소유합니다.

## 오류 경계

AI Service의 랭킹·조건 해석 모델·HTTP·Agent 시간 초과는 내부 504로 반환되고 Core는 공개 `504 AI_SERVICE_TIMEOUT`으로
전달합니다. 의미 검색의 전체 실행·임베딩·Qdrant 전송 시간초과도 내부 `INDEX_TIMEOUT` 504로 전달합니다.
화면은 해당 endpoint의 검증된 오류 계약에 한해 AI 처리 시간 초과와 수동 재시도를 안내합니다.
조건 해석 실패는 일반 오류로 합치지 않고 시간 초과·일시 이용 불가를 구분하며, AI 로그에는 실패 종류·오류 클래스명·
경과 시간만 남깁니다. 요청 문장·기업 조건·모델 응답과 원문 예외는 기록하지 않습니다.
의미 검색의 준비·임베딩·Qdrant 시간과 랭킹의 준비·모델·검증 시간, 캐시 상태·후보 수·총시간은
`app` INFO로 기록합니다. 의미 검색 실패·취소는 실패 단계와 고정 코드·경과 시간을 기록합니다.
랭킹 출력 검증 경계는 JSON 문법 오류와 스키마·서버 검증 오류를 분리하고 허용 목록의 검증 유형·필드명만
기록합니다. 모델 응답·검증 입력값·후보 ID·임의 필드명은 기록하지 않습니다. Core도 DB·후보 준비·
의미/키워드 검색·랭킹·전체 성공/실패 시간을 기록합니다.
상세 근거 질문에는 색인·검색·답변 단계 시간, 질문/청크 임베딩 캐시 지표를 기록하며, 대화·랭킹·근거 답변에는
SDK가 반환한 입력·출력·캐시 입력·추론 토큰 수를 기록합니다. 입력·원문·응답 본문·캐시 키는 남기지 않습니다.
근거 질문 임베딩은 인스턴스별 256개/300초, 내용이 같은 청크 벡터는 128개/300초 재사용합니다.
공고·청크 ID나 인용 계약을 바꾸지 않으며 매회 Qdrant 검증과 실패 전파를 유지합니다. lifespan은 기존 app/root handler를 재사용하거나
stderr handler 하나를 추가합니다. 전역·OpenAI·HTTP 로그 수준은 바꾸지 않습니다.
시간 초과 외 LLM 실행 실패·색인 미준비·Qdrant 실패는 내부 503으로 반환되고 Core는 공개
`503 AI_SERVICE_UNAVAILABLE`로 변환합니다. Core가 관측한 연결·읽기 timeout 및 점수화·색인 API의
내부 408·504는 504, 예상하지 않은 HTTP 상태나 잘못된 응답 계약은 502로 분류합니다.
공개 응답은 `application/problem+json`이며 내부 URL·원본 라이브러리 예외를 노출하지 않습니다.

Core의 Health는 프로세스 상태, AI Health는 AI Service의 정해진 Health 응답을 확인하는 기능입니다.
이들이 성공했다고 MySQL·Qdrant·OpenAI를 포함한 실제 검색 전체가 준비됐음을 보장하지 않습니다.
전체 연결 동작은 [Compose 검증 절차](../infrastructure/README.md)로 확인합니다.

현재 제품은 공고 요약의 의미·키워드 결합 검색·구조화된 추천과, 기업마당 공식 HTML 한 종류의 공고별 근거 답변을 제공합니다.
실제 검색 후보·최종 추천의 캡처, AI-only 참조 판정과 변경 전후 보고서는
[공유 평가 자료](../evaluation/support-program-search/runs/support-program-catalog-20260906-v1/README.md)에 있습니다.
평가 가능한 질문은 6개, 그중 양성 질문은 2개뿐이며 독립적인 사람 검토 품질 증거는 아닙니다.
근거 답변은 [5단계 후속 검증](../evaluation/support-program-evidence/runs/official-flow-20260907-v1/README.md)에서
공식 HTML 2건·질문 6개의 실제 MySQL·Qdrant·모델 연결과 인용을 확인했습니다. 고정 HTML을 재생한
소규모 AI-only 검토이며 공고당 청크 1개여서 일반적인 검색 품질 근거는 아닙니다.
PDF·첨부·다른 제공처 확장은 후속 범위입니다.


## 중복 지원·수혜 검토 사용자 화면 (5-1)

`/app/combination-reviews`는 본인 목록·커서 조회·확인 후 삭제, `/new`와 `/:reviewId`는
`제목·공고 2개 선택 → 공고별 참여 상태 → 공고 분석`의 3단계 흐름을 제공한다. 단계 이동 시 스크롤을 상단으로 초기화하고, 분석 단계에서 실행과 이력 목록을 제공한다.
실행 이력 항목은 `/:reviewId/runs/:runId` 결과 전용 화면으로 이동해 결과를 자동 조회한다. 결과 화면은 같은 검토의 다른 실행 선택·이전 이력 추가 조회·분석 결과·원본 다운로드를 제공한다. RequireAuth와 WorkspaceLayout을 사용한다.
호출은 `View → ViewModel → CombinationReviewUseCase → Domain Repository 계약 → Data 구현 → HTTP/Zod → Core API`다.
공고 선택은 BrowseSavedSupportProgramsUseCase의 관심 공고함과 기존 BrowseSupportProgramsUseCase의 무료 카탈로그 API를 재사용하며 접수 종료·미지원 자동 분석을 구분한다. 관심 공고는 기본 화면에서 호출하지 않고 사용자가 선택 팝업을 열 때 조회하며, 선택 요약은 고정 높이 한 줄로 유지한다.
저장된 원본 식별자는 상세 API로 공고명과 기관명을 보완해 참여 상태 화면에서 `사업 1`이 어떤 공고인지 함께 표시한다.
신청·선정·확약·협약·수행·교부 입력은 항목별 도움말을 hover·keyboard focus로 제공하며 각 사실을 독립적으로 선택한다.
정책 변경 전에 저장된 3개 공고 검토와 실행 결과는 계속 조회하되, 새 입력과 새 분석은 정확히 2개 공고만 허용한다.

두 번째 단계 완료 버튼은 입력을 저장한 뒤 같은 사용자 동작으로 분석을 시작하고 분석 단계에서 진행 상태를 표시한다. 입력 충돌 시 편집 내용을 유지한다.
단계 이동 성공 시 이전 단계의 검증 오류를 제거한다. 내부 제공처·원본 ID는 화면에 노출하지 않고, 실행별 추가 설명 입력은 참여 상태 단계 한 곳에서만 제공한다.
비동기 접수 POST 응답을 최대 15초 기다리며 서버 작업 취소를 보장하지 않는다. 미확인 요청의 키·버전·추가 설명만
계정별 탭 sessionStorage에 보관하고, 같은 요청 확인으로 재전송한다. 조회·마운트·로그인으로 POST하지 않는다.
저장소를 쓸 수 없으면 분석을 시작하지 않으며 일반 입력 초안·결과는 브라우저에 영속 저장하지 않는다.
계정 변경·로그아웃 시 기록을 지우고 이전 요청을 취소하며 세션 참조 검사로 늦은 응답을 차단한다.
QUEUED/RUNNING은 3초 간격 GET으로 상태를 확인하고 새로고침 후에도 DB 이력으로 조회를 재개한다.
조회 실패·완료·로그아웃에는 자동 조회를 중지한다. RUNNING이 20분을 넘으면 서버는 UNKNOWN으로 표시하지만
새 유료 요청으로 자동 교체하지 않는다. UNKNOWN은 같은 검토의 새 실행도 차단하며 운영 확인이 필요하다.
FAILED/INTERRUPTED 역시 정상 근거 부족과 구분한다.

결과의 사업 순서·참여 상태·인용은 해당 Run의 스냅샷으로 표시한다. 여섯 단계의 판단 범위·질문·기관 확인·수집 한계와
자동 수집/사람 미검수 상태를 표시한다. 모델이 사용자 표시 문장에 반환한 참여 상태 코드는 한국어로 표시하고, 분석 한계가
참여 상태·추가 사실·공식 원문 수집 범위에서 확정할 수 없는 내용임을 안내한다. 여섯 단계는 반응형 2·3열 선택 보드에서 판단 상태를
먼저 비교하고 선택한 한 단계의 상세만 아래에서 확인한다. 공식 공고 상세는 외부 페이지로 열고, 보관 원본은 세션을 포함한 GET으로 내려받는다. 5-2의 비로그인 선택 유지·작업 이어보기,
신청서 작성 도우미, 실제 OpenAI 품질 평가는 포함하지 않는다.

HWP 체크박스의 FORM_OBJECT Caption은 주변 문항과 함께 별도 근거 블록으로 보존한다. 공식 신청 문항의 단일 선택지는 AI Service가 원문 인용에 포함된 `options`로 추출하고, Core API가 다시 검증한 뒤 양식 스냅샷과 공개 응답에 보존한다. Frontend는 선택지를 라디오 버튼으로 표시한다. 기존 스냅샷에서 `options`가 없으면 빈 목록으로 읽으며, 선택형 문항의 선택지를 확인하지 못한 경우 공식 원문 확인을 안내한다.

## 공고별 신청 양식 사전분석

신규·변경 공고의 상태와 시스템 분석 Outbox는 `application_form_availability`에 저장합니다. 공식 제공처 전체 동기화 성공 transaction에서 등록하고, 별도 Worker가 첨부 수집·파싱·AI 분석을 수행합니다. 성공 snapshot 저장과 AVAILABLE 활성화는 하나의 짧은 transaction입니다.

현재 사용자 작성 화면은 계정별 Discovery Job을 실행하지 않고 공고별 availability API에서 활성 snapshot을 읽습니다. 기존 계정별 discovery job API는 별도 책임으로 남아 있습니다. 새 작성은 활성 formVersionId만 허용하고, 기존 작성의 과거 버전과 최종 생성의 공식 원본 해시 대조는 유지합니다.

Discovery 전용 timeout은 model 210초 < AI run 240초 < Core read 270초 < Worker lease 1,800초입니다. 다른 신청 준비 기능의 전역 timeout은 변경하지 않습니다. [상태·재시도·백필 실행 방법](application-form-availability.md)을 참고하세요.

## 신청 문서 MCP 파이프라인

HWPX 질문 추출은 Core가 hash와 함께 보낸 원본을 AI 내부에서 먼저 구조 분석한 뒤 OpenAI에 셀 정보를 전달한다. PDF의 평면 입력칸은 로컬 FFDetr 탐지 결과와 원문 글자·표 경계를 대조하고, 기존 PDFBox가 값을 기입한다. FFDetr 가중치는 이미지 빌드 시 고정 revision과 SHA-256으로 검증하며 실행 중 다운로드나 외부 PDF 서비스 호출을 하지 않는다. AI worker당 PDF 검사는 한 번에 하나씩 실행한다.

생성 경로는 Core의 공식 첨부·소유권·revision 관리와 AI Service의 형식별 MCP 실행을 연결한다. HWP는 Core hwplib의 구조 검사·범위 편집·재열기, HWPX는 Hangeul 파일 모드, PDF는 MCP 정리 후 PDFBox AcroForm 처리이다. AI는 HWP의 hwpTargets를 받아 지도와 계획만 반환하며 Core가 원본·plan hash·revision·bindings/scope를 독립 검증한다. HWP에 Windows·한컴 한글·브리지 설정이 필요하지 않다. 과거 직접 HWPX 편집 경로는 현재 생성에서 사용하지 않는다. 새 fingerprint로 과거 생성 결과와 구분하고 다운로드 이력을 보존한다. 구현 범위와 미지원 구조·검증 상태는 [MCP 구조](application-document-mcp-architecture.md), [설치](application-document-mcp-setup.md), [검증 기록](application-document-mcp-validation.md)를 확인한다.
