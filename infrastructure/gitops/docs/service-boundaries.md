# 서비스·데이터 경계와 Kubernetes 전환 기준

> 서비스 경계 설계 기록입니다. 아래 두 저장소 이름은 통합 전 관리 구조를 뜻합니다.
> 현재 소스는 통합 저장소 `backend/`, 배포 설정은 `infrastructure/gitops/`에서 함께 관리하며
> [현재 구현 범위](../README.md)를 기준으로 합니다. 저장소 통합이 서비스나 DB를 합친다는 뜻은 아닙니다.

> 과거 검토·검증 기록입니다. 현재 운영 환경은 없으며 현재 컨테이너·DNS는 `core-service`·`ops-service`(Ops DB: `ops-mysql`)로 통일했습니다. 아래 당시 커밋 링크·이미지 ID·출력은 증거 보존을 위해 변경하지 않습니다. 현재 실행 절차는 [로컬 Kubernetes 안내](kubernetes-local.md)를 따릅니다.

> 이 문서의 Core API/Core, Catalog, AI Service/AI, Ops는 당시 표기입니다. 현재 서비스명은 각각
> `core-service`, `catalog-service`, `ai-service`, `ops-service`입니다. 본문의 검증 수치·이미지 태그·
> 커밋 고정 경로는 당시 기록을 보존하며, 최신 구성은 [메인 README](../README.md)를 따릅니다.

현재 저장소는 `GovBiz/develop`이며 소스 폴더는 `backend/{core-service,catalog-service,ai-service,ops-service}`다.
아래 본문과 커밋 고정 링크는 초기 경계 검토 기록이다. 이후 Catalog의 로컬 분리·DB·Core HTTP 연동 검증을
완료했으므로 현재 구현 범위는 [Catalog 분리 안내](https://github.com/GovBiz-Team/GovBiz/blob/develop/docs/catalog-service-extraction.md)를 우선한다.
과거 커밋의 `backend/core-api`·`backend/ops` 링크는 당시 경로를 보존한다. Kubernetes 운영 전환은 아직 별도 단계다.

이 문서는 **현재 구현을 확인한 뒤 정한 후속 개발 계약**이다. 인증 위임 API, 서비스 추출,
DB 분리, 운영 Kubernetes 전환을 구현했다는 뜻이 아니다.
사용자 요구에 따라 Kubernetes는 포트폴리오의 필수 목표로 두되, 컨테이너를 Pod로 옮긴
것과 MSA 업무 경계 완성을 구분한다.

소스 감사 기준은 GovBiz-web `238510748e93ff6d32575ff7e7bb2315c4f251cb`이다.
아래 고정 링크는 이 커밋의 증거이며, 현재 실행 중인 AWS 서버나 이후 변경 상태의 증거가 아니다.
현재 작업에서 후속으로 바뀌는 Ops 실행 설정은 해당 앱 변경과 검증 결과를 함께 확인한다.

## 1. 첫 단계의 배포 단위

| 단위 | 현재 구현 | 유지할 책임 | 이번 경계 결정으로 구현되지 않는 것 |
| --- | --- | --- | --- |
| Core API | Spring의 계정·기업·공고·파트너·신청·리포트·관리자 기능 | 사용자 인증·권한과 기존 업무 데이터의 기준 | 기능별 독립 서비스나 분산 transaction으로 자동 전환되지 않음 |
| AI Service | 별도 FastAPI 프로세스, OpenAI·Qdrant 연결 | LLM·임베딩·RAG·문서 처리 실행, 벡터 색인 | 계정·권한·업무 데이터 원장을 소유하지 않음 |
| Ops | Django health/readiness와 전용 DB 연결 | 향후 운영 작업·평가·프롬프트 승인·감사 기록 | 관리자 로그인·업무 API·LLMOps 모델은 아직 없음 |

처음에는 이 세 실행 단위를 Kubernetes에서 검증한다. Core 내부 업무를 한 번에 여러
서비스로 복사하지 않는다. 동일 모노레포에서 서비스별 이미지·계약·릴리스를 관리한다.
Ops와 AI는 서로 다른 역할이며, 운영 UI를 만든다는 이유로 AI 실행 코드를 Ops로 옮기지 않는다.

## 2. 데이터 소유권

### 현재 Core 소유 데이터

아래는 현재 Flyway migration에 존재하는 테이블을 기능별로 묶은 것이다.
별도 DB로 이미 분리돼 있다는 뜻이 아니다. 스키마 변경 주체는 현재 Core의 Flyway다.

| 기능 | 현재 소유 테이블 |
| --- | --- |
| 계정·인증 | `account`, `account_session`, `account_oauth_identity`, `account_password_reset`, `signup_email_verification`, `account_oauth_unlink_job` |
| 기업·회원 관리 | `company`, `company_partner_profile`, `account_admin_action` |
| 공고 원장·수집 | `support_program`, `support_program_source_document`, `support_program_sync_generation`, `support_program_sync_status` |
| 개인 관심·대화 | `saved_support_program`, `chat_conversation` |
| 파트너 | `partner_recruitment`, `partner_proposal` |
| 신청 준비·공식 양식·문서 | `application_preparation`, `application_preparation_fact`, `application_preparation_interpretation_run`, `application_form_snapshot`, `application_form_discovery_job`, `application_form_availability`, `application_preparation_draft_run`, `application_preparation_content`, `application_document_file` |
| 중복 검토 | `combination_review`, `combination_review_program`, `combination_review_run`, `combination_review_run_source` |
| 리포트 | `daily_report_subscription`, `daily_report`, `daily_report_generation_budget`, `daily_report_generation_job` |

근거: [Flyway migration 디렉터리](https://github.com/GovBiz-Team/GovBiz/tree/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/resources/db/migration).
Redis의 검색 결과·소유권·TTL도 현재 Core가 관리하며, 대화 원본은 MySQL에 있다.
Elasticsearch 키워드 색인은 Core가 공고 원장에서 구성하는 조회용 데이터다.
이들은 원장을 대체하지 않는다.

### AI와 Ops의 소유권

- AI는 Qdrant의 임베딩·검색 색인과 프로세스 내 캐시를 관리한다. 현재 앱 의존성·설정·조립
  경로에서 MySQL 클라이언트나 Core DB 직접 연결은 확인되지 않았다. 업무 입력은 내부 HTTP
  요청으로 받고, 필요한 개인 자료는 인증된 Core 읽기 API를 호출한다.
- Core가 공고 스냅샷과 문서 버전을 결정하고 AI에 색인을 요청한다. AI가 임의로 공고를
  수집해 원장을 갱신하는 구조로 바꾸지 않는다. 색인은 버전·해시를 기준으로 재생성할 수 있어야 한다.
- Ops에는 아직 업무 테이블이 없다. 향후 평가 실행·결과·검토, 프롬프트 버전·승인, 운영
  작업 기록은 Ops 전용 스키마·DB 계정과 Django migration으로 관리한다. 이는 **설계 범위**이며
  해당 테이블을 이번 문서에서 생성하지 않는다.
- Ops에 Core의 `account`, `account_session`, `company`를 복제하거나 Django 모델로 연결하지
  않는다. 필요한 사용자 표시는 식별자와 허용된 조회 계약으로 얻는다. 물리 RDS를 공유하더라도
  DB 계정·스키마·쓰기 권한은 분리한다.

근거: [AI 조립 코드](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/ai-service/app/bootstrap.py),
[AI 색인 서비스](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/ai-service/app/support_program_index/service.py),
[Core 색인 흐름](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/kotlin/ai/govbiz/core/supportprogram/service/sync/SupportProgramIndexSyncService.kt),
[검색 결과 저장소](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/kotlin/ai/govbiz/core/supportprogram/repository/SupportProgramSearchResultRepository.kt),
[Ops 설정](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/ops/config/settings.py).

## 3. 관리자 인증 계약

### 현재 구현

Core는 JWT 서명·만료 확인에 더해 DB의 세션 존재·유휴 만료·계정 정지 여부를 요청마다 확인한다.
관리자 API는 이 결과의 현재 `ADMIN` 권한을 검사한다. 따라서 JWT 서명만 다른 서비스에서
검증하는 방식은 현재의 강제 로그아웃·정지·권한 변경을 온전히 보존하지 못한다.
회원 정지와 세션 삭제, 조치 기록은 현재 Core transaction 안에서 처리된다.

Ops에는 인증 구현이 없다. 기본 업무 API 권한은 `IsAuthenticated`지만 인증 클래스는 비어 있고,
현재 공개된 health/readiness만 명시적으로 익명 접근을 허용한다. 이를 관리자 인증 연동 완료로
설명하거나 임의의 사용자 ID·역할 헤더를 신뢰해서는 안 된다.

근거: [Core 세션 검증](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/kotlin/ai/govbiz/core/account/service/AccountSessionService.kt),
[관리자 판정](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/kotlin/ai/govbiz/core/admin/web/AdminPrincipal.kt),
[회원 관리 transaction](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/kotlin/ai/govbiz/core/admin/service/AdminAccountService.kt).

### 후속 구현 정책 — 아직 API 없음

1. 계정·세션·ADMIN의 최종 판정은 Core에 유지한다. Ops는 인증된 서버 간 조회로 현재 사용자의
   관리자 권한을 확인한다. 경로·요청·응답 계약과 자격 증명 전달 방식은 구현 PR에서 확정한다.
2. 사용자 자격 증명과 Ops 서버 자격을 구분한다. Core의 HS256 서명키를 Ops에 복사해
   사용자 토큰 발급 권한까지 주지 않는다. 내부 공유 토큰 하나만으로 모든 관리 작업을 허용하지 않는다.
3. 호스트 한정 세션 쿠키는 다른 호스트로 자동 전달되지 않는다. 동일 origin의 게이트웨이/BFF
   경로를 사용할지 별도 인증 교환을 사용할지 먼저 정하고, CSRF·Origin 검사와 로그아웃을 함께 검증한다.
4. Core 인증 조회 실패·시간 초과 시 Ops는 권한을 허용하지 않는다. 역할·정지 결과를 장기간
   캐시하지 않으며, 로그아웃/정지 직후 차단되는 계약을 테스트한다.
5. 계정 정지·세션 회수는 계속 Core의 명령 API가 수행한다. Ops는 Core DB를 직접 UPDATE하지 않는다.
   Ops 자체 운영 기록에는 실행 주체·요청 ID·대상·결과를 남기되 토큰·비밀번호를 기록하지 않는다.

## 4. 내부 호출과 유료 작업 경계

| 흐름 | 현재 계약 | Kubernetes/후속 개발 정책 |
| --- | --- | --- |
| Core → AI | 분석·검색·문서 내부 HTTP API | AI는 내부 Service로만 노출하고 Core에서 오는 통신만 허용하도록 네트워크 정책 검증 |
| Core → AI 문서 map/generate | `DOCUMENT_INTERNAL_TOKEN` Bearer 검증 | 양 서비스에 동일 비밀을 별도 주입; 일반 UI 설정에 노출하지 않음 |
| AI → Core 도우미 도구 | 읽기 전용 GET, 공유 비밀 + 계정 묶음 만료 토큰 | Core가 소유권을 확인; AI에 DB 계정이나 관리자 권한을 제공하지 않음 |
| Ops → Core/AI | 업무 호출 아직 없음 | 관리자 판정·작업 권한·전송 데이터·예산을 확인한 뒤 작업 ID 기반 요청 계약 구현 |

주의: 현재 모든 AI 내부 API에 공통 인증이 걸린 것은 아니다. 문서 map/generate의 토큰
검증을 전체 AI 인증으로 일반화하지 않는다. `ClusterIP`만으로 다른 Pod의 접근을 차단할 수
있다고 가정하지 않으며, NetworkPolicy를 실제 집행하는 CNI와 거절 테스트가 필요하다.
Ops에는 평가 실행 등 필요한 경로만 허용하고, AI에서 Core로 역호출할 때도 사용자 범위의
읽기 권한만 사용한다.

유료 추론·임베딩은 AI가 실행한다. Core 또는 향후 Ops 작업은 호출 전에 권한·중복 요청·예산을
관리하며, 시간 초과가 유료 작업 취소/미실행의 증거는 아니다. Kubernetes 재시작·큐 재배달이
동일 작업을 무조건 재실행하지 않도록 멱등 키·상태·결과 불명 처리와 수동 재실행 정책을 검증한다.
CI와 첫 클러스터 검증은 외부 API 스텁을 사용하며, 실제 호출은 승인된 데이터·횟수 범위에서만 한다.

근거: [AI 라우터 조립](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/ai-service/app/main.py),
[문서 인증](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/ai-service/app/application_preparation/router.py),
[AI 도구 HTTP 클라이언트](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/ai-service/app/assistant_agent/tools.py),
[Core 도구 인증](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/kotlin/ai/govbiz/core/assistant/web/AssistantToolAuthInterceptor.kt).

## 5. 첫 Core 추출 후보: 공고 카탈로그

첫 업무 서비스 후보는 **공고 수집·정규화·원장·검색**이다. 계정/인증부터 분리하는 것보다
외부 제공처 장애·주기 수집·검색 부하의 경계를 설명하기 쉽다. 다만 지금 바로 폴더를 복사해
새 서버를 만들지는 않는다.

- 대상: `support_program`, 원문 문서, 수집 generation/status와 키워드·벡터 색인 조정.
- Core에 남길 것: 개인 관심 공고, 사용자 세션·기업, 파트너 활동, 신청·중복 검토 상태.
  `supportprogram` 폴더 전체가 카탈로그 서비스인 것은 아니다.
- 공개 조회 계약: `(source_code, source_program_id)`와 버전/해시를 기준으로 공고 조회·검색 결과를
  제공한다. 내부 숫자 PK가 다른 서비스의 공개 식별자라고 가정하지 않는다.
- 차단요인: `partner_recruitment`와 `saved_support_program`이 공고 테이블에 FK를 갖고,
  신청·리포트·중복 검토 코드가 공고 서비스/Repository를 직접 사용한다. FK 제거만으로
  데이터 독립성이 생기지 않는다.
- 선행 작업: 소비자 계약 테스트 → 호환 조회 API/스냅샷 → 백필·대조 → 단일 쓰기 주체 전환 →
  이전 경로 폐기 순서로 진행한다. 데이터 migration·복구 계획 없이 운영 테이블을 나누지 않는다.
- 수집 전용 worker는 먼저 실행 역할을 나눌 수 있지만, 같은 스키마·코드를 공유한다면
  독립 MSA가 아닌 **Core의 worker 역할**이라고 표시한다.

근거: [파트너의 현재 FK](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/resources/db/migration/V8__create_partner_recruitment.sql),
[관심 공고의 현재 FK](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/resources/db/migration/V22__create_saved_support_program.sql).

## 6. Kubernetes replica·실행 역할 제한

| 대상 | 초기 정책 | 확장 전 확인할 실제 제약 |
| --- | --- | --- |
| Core | replica 1, HPA 미적용 | 로그인 rate guard와 검색/AI admission이 프로세스 메모리; Pod 수만큼 정책이 느슨해질 수 있음 |
| Core 수집·색인 | 단일 실행 주체, 격리 검증에서는 주기 수집 비활성 | `@Scheduled`가 각 Pod에서 실행; generation 보호는 게시 순서 보호이지 외부 수집·임베딩 중복 호출 차단이 아님 |
| AI | replica 1부터 검증 | Qdrant 쓰기 lock·collection 생성·임베딩 cache가 프로세스 단위; 동시 초기화·색인/prune·중복 비용 검증 전 HPA 금지 |
| Ops | 업무 없는 단계는 replica 1 | 운영 WSGI/ASGI, readiness·종료 처리 검증 후 확대; 인증 없는 건강 상태 API 시연을 관리자 시스템 완성으로 설명하지 않음 |
| DB·브로커·색인 | 별도 상태 저장소 정책 | 복제 수만 늘리지 않으며 백업·복구·스토리지·버전 호환·운영 주체부터 결정 |

replica 1이어도 RollingUpdate의 surge나 기존 Compose와 병행 실행하면 같은 작업자가 둘이 될
수 있다. 단일 실행을 의존하는 초기 Core/AI 배포는 중복 인스턴스가 생기지 않는 갱신 정책을
명시하고 일시 중단 가능성을 기록한다. 전용 scheduler 역할·분산 제한을 구현하기 전에는
무중단/수평확장 완료를 주장하지 않는다.

기존 안전장치도 보존한다. 문서 생성은 로컬 실행 집합뿐 아니라 Redis SETNX 락을 사용하고,
일부 큐 작업은 DB claim·lease 및 transaction을 사용한다. 이를 모두 메모리 기반이라고
표현하지 않는다. 다만 이 장치의 존재만으로 모든 큐의 중복 소비·Pod 종료·유료 호출 안전성을
검증했다고 볼 수는 없다.

근거: [로그인 제한](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/kotlin/ai/govbiz/core/account/service/AccountLoginAttemptGuard.kt),
[요청 admission](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/kotlin/ai/govbiz/core/supportprogram/service/admission/SupportProgramRequestAdmissionService.kt),
[수집 scheduler](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/kotlin/ai/govbiz/core/supportprogram/service/sync/BizInfoSupportProgramCatalogSyncScheduler.kt),
[generation 게시 보호](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/kotlin/ai/govbiz/core/supportprogram/service/sync/BizInfoSupportProgramCatalogSyncService.kt),
[문서 생성 Redis 락](https://github.com/GovBiz-Team/GovBiz/blob/238510748e93ff6d32575ff7e7bb2315c4f251cb/backend/core-api/src/main/kotlin/ai/govbiz/core/applicationpreparation/service/ApplicationDocumentService.kt).

Core/AI의 현재 단순 health는 프로세스 응답 확인이지 모든 DB·색인·외부 AI 의존성 준비 완료가
아니다. readiness와 liveness의 목적을 나누고, 외부 OpenAI 장애를 이유로 무한 재시작하지 않는다.

## 7. 포트폴리오 완료 증거

아래 항목은 **체크리스트**이며 이 문서 작성으로 통과한 항목은 없다. 완료 시 날짜·명령·대상
컨텍스트·이미지 digest·Git SHA·비밀값을 제거한 결과를 별도 실행 기록에 남긴다.

- [ ] 격리된 Kubernetes 컨텍스트/namespace에서 서비스별 Deployment·Service가 실행된다.
- [ ] 실제 앱 이미지의 startup/readiness/liveness와 Pod 교체 후 복구를 확인한다.
- [ ] Core → AI, AI → Core의 허용 통신 및 비허용 Pod의 접근 거절을 확인한다.
- [ ] Core/AI/Ops가 서로의 DB 계정·테이블을 직접 사용하지 않는지 확인한다.
- [ ] Ops의 미로그인·일반 회원·관리자·정지/로그아웃·Core 인증 장애 테스트를 통과한다.
- [ ] 수집/큐 작업 도중 Pod 종료와 재배달 시 중복 기록·유료 호출을 방지하는지 확인한다.
- [ ] Git 이미지 변경 → Argo CD 동기화 → 한 서비스만 교체 → 이전 이미지 복귀를 기록한다.
- [ ] 이미지 롤백과 DB 복구를 구분하고 상태 저장소 백업·복원 연습을 수행한다.
- [ ] 정해진 부하에서 자원·오류율·지연·큐 적체를 측정한 뒤 replica/HPA 확대 여부를 결정한다.
- [ ] 실제 업무 서비스 추출은 다른 서비스 DB 직접 접근 없이 독립 계약·릴리스가 가능함을 증명한다.

Kubernetes 실행 증거, GitOps 배포 증거, MSA 경계 증거, 실제 AI 품질 평가는 각각 구분한다.
로컬 Kubernetes 검증을 AWS 운영 이전 완료로 표시하지 않는다.
