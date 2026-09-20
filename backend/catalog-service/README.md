# Catalog Service

기업마당·K-Startup·과학기술정보통신부·충남 온라인수출지원시스템의 공고를 수집하고,
Elasticsearch 키워드 색인과 AI Service 벡터 색인을 준비한 뒤 자체 MySQL에 공개하는 독립 서비스입니다.
Kotlin 2.4.10, Spring Boot 4.1.0, JDK 21, MyBatis 4.0.0을 사용합니다.
Core의 계정·세션·신청서·원문 캐시 코드 또는 Gradle 프로젝트에 의존하지 않습니다.

현재는 단계적 분리입니다. 루트 Compose는 Catalog 분리형이며 기존 AWS/embedded 실행 호환성을 위해 Core에도 기존 수집 구현이
일시적으로 남아 있으며, Core의 카탈로그 projection 모드에서만 기존 쓰기 실행을 끕니다.
일반 사용자 목록·상세·검색 API는 Core가 로컬 읽기 projection으로 계속 제공합니다.
이 서비스의 DB를 Core DB로 지정하거나 기존 운영 DB의 Flyway 이력에 연결하지 않습니다.

## 호출 흐름과 데이터 소유권

- 수집: Scheduler → 제공처별 SyncService → Facade → 제공처 HTTP Client.
- 공개 준비: SyncService → Elasticsearch Client + AI Service index Client.
- 공개: SyncService → Repository → MyBatis Mapper → 자체 MySQL.
  전체 수집·두 색인이 성공한 뒤 최신 실행 세대만 제공처 단위 transaction으로 공개합니다.
- 전달: 내부 HTTP API → SnapshotService → Repository의 REPEATABLE READ transaction.
  Core가 인증된 스냅샷을 읽고 자기 DB에 projection을 갱신합니다.
- 신청서 분석 등록과 원문/첨부 문서 캐시는 Core의 책임으로 유지합니다.

독립 Flyway `V1__create_catalog.sql`은 `support_program`, `support_program_sync_generation`,
`support_program_sync_status`, `catalog_instance`, `catalog_source_revision`만 생성합니다.
기존 Core migration은 수정하거나 실행하지 않습니다. 제공처 원본 ID의 복합 고유키,
MySQL 8.4 `utf8mb4_0900_ai_ci` 정렬과 JSON 표현을 유지합니다.

DB 초기화 때 한 번 생성한 UUID `catalogId`는 프로세스 재시작에도 유지됩니다.
모든 Repository 공고·동기화 상태 쓰기는 같은 transaction에서 제공처별 `revision`을 증가시킵니다.
수집 실패나 색인 준비 상태만 바뀌어도 revision이 증가합니다. 오래된 실행의 조건부 쓰기가
거절되거나 transaction이 rollback되면 revision도 바뀌지 않습니다.

## 내부 API

`GET /internal/v1/catalog/snapshots/{sourceCode}`

`sourceCode`는 대소문자까지 정확히 `BIZINFO`, `KSTARTUP`, `MSIT`, `CNTRADE_NOTICE` 중 하나입니다.
헤더 `Authorization: Bearer <CATALOG_INTERNAL_TOKEN>`이 필요합니다. 모든 경로에 인증을 적용하고
`GET /health`, `GET /readiness` 두 경로만 제외합니다. 토큰은 고정 길이 SHA-256 해시끼리 상수 시간
비교하며 로그·응답에 포함하지 않습니다.

```json
{
  "schemaVersion": 1,
  "catalogId": "00000000-0000-0000-0000-000000000000",
  "revision": 2,
  "status": {
    "sourceCode": "BIZINFO",
    "publishedGeneration": 1,
    "publishedCatalogFingerprint": "sha256",
    "publishedProgramCount": 0,
    "indexReady": true,
    "lastSuccessfulSyncAt": "2026-09-19T12:00:00",
    "lastFailedSyncAt": null,
    "lastSyncOutcome": "SUCCESS"
  },
  "programs": []
}
```

`programs`는 `program`, `sortTimestamp`, `startupDetails` 구조의 명시적인 HTTP DTO입니다.
`program`에는 원본 식별자·제목·기관·요약·분류·지역·지원대상·신청기간/날짜·접수상태·출처를 담고,
`sourceQualifiedId`, 추천 이유/점수, 자격 판정처럼 Core 내부에서 계산하는 속성은 전달하지 않습니다.
revision을 먼저 읽어 고정한 같은 DB 시점에서 상태와 공고를 읽습니다. 최대 20,000개이며
공개 건수·지문이 실제 공고와 맞아야 응답합니다. 아직 공개한 적이 없는 제공처, 불완전한
스냅샷은 HTTP 503입니다. 성공적으로 공개한 빈 목록만 HTTP 200과 빈 배열로 반환합니다.
다음 동기화 실패 시에는 직전 공개 공고와 새 실패 상태를 함께 제공합니다.
잘못된 제공처는 400, 인증 실패는 401입니다. 인증된 응답은 `Cache-Control: no-store`입니다.

`GET /health`는 프로세스 생존, `GET /readiness`는 자체 DB의 카탈로그 식별자 조회만 확인합니다.
readiness는 공공 API·AI Service·Elasticsearch에 요청하지 않으며 DB 장애 시 503입니다.

## 설정과 실행

기본 포트는 `8081`이며 `SERVER_PORT`로 변경할 수 있습니다.

| 환경변수 | 의미 / 기본값 |
|---|---|
| `SPRING_DATASOURCE_URL` | 독립 DB URL, `jdbc:mysql://127.0.0.1:3306/govbiz_catalog` |
| `SPRING_DATASOURCE_USERNAME`, `SPRING_DATASOURCE_PASSWORD` | 독립 DB 사용자/비밀번호 |
| `CATALOG_INTERNAL_TOKEN` | 필수, 공백 없는 ASCII 32~1024자; Core의 값과 일치 |
| `AI_SERVICE_BASE_URL` | 색인 API, `http://127.0.0.1:8000` |
| `AI_SERVICE_CONNECT_TIMEOUT`, `AI_SEMANTIC_SEARCH_READ_TIMEOUT` | AI 연결/색인 응답 제한, `2s` / `30s` |
| `ELASTICSEARCH_BASE_URL`, `ELASTICSEARCH_INDEX_NAME`, `ELASTICSEARCH_API_KEY` | ES 연결/색인/인증; 색인 기본 `govbiz-support-program-lexical-v2` |
| `ELASTICSEARCH_CONNECT_TIMEOUT`, `ELASTICSEARCH_READ_TIMEOUT` | `2s` / `10s` |
| `BIZINFO_API_BASE_URL`, `DATA_GO_KR_SERVICE_KEY` | 기업마당 API 주소/키 |
| `KSTARTUP_API_BASE_URL`, `KSTARTUP_API_KEY`, `KSTARTUP_SYNC_SCOPE` | K-Startup API/키/범위 (`RECENT_YEAR`) |
| `MSIT_API_BASE_URL`, `MSIT_API_KEY` | MSIT API/키, 키 미지정 시 공공데이터 키 사용 |
| `CNTRADE_NOTICE_API_BASE_URL`, `CNTRADE_NOTICE_API_KEY` | 충남 공고 API/키, 키 미지정 시 공공데이터 키 사용 |
| `{BIZINFO,KSTARTUP,MSIT,CNTRADE_NOTICE}_API_CONNECT_TIMEOUT` | 제공처 연결 제한 `2s` |
| `{BIZINFO,KSTARTUP,MSIT,CNTRADE_NOTICE}_API_READ_TIMEOUT` | 제공처 응답 제한 `10s`, `10s`, `20s`, `20s` |
| `{BIZINFO,KSTARTUP,MSIT,CNTRADE_NOTICE}_SYNC_ENABLED` | 각 수집 scheduler, 모두 기본 `false` |
| `{BIZINFO,KSTARTUP,MSIT,CNTRADE_NOTICE}_SYNC_INITIAL_DELAY` | 각 수집 최초 지연, 기본 `PT0S` |
| `{BIZINFO,KSTARTUP,MSIT,CNTRADE_NOTICE}_SYNC_FIXED_DELAY` | 각 수집 간격, 기본 `PT6H` |
| `SUPPORT_PROGRAM_INDEX_ENABLED` | 색인 복구 scheduler, 기본 `false` |
| `SUPPORT_PROGRAM_INDEX_INITIAL_DELAY`, `SUPPORT_PROGRAM_INDEX_FIXED_DELAY` | 색인 복구 최초 지연/간격 `PT0S` / `PT1M` |

DB와 토큰을 준비한 뒤 이 디렉터리에서 `./gradlew bootRun`을 실행합니다. Docker build context도
이 디렉터리 하나입니다. scheduler 활성화 시 공공 API·AI Service를 실제 호출하므로 승인된
실행 환경과 비용 범위에서만 켭니다. 기본 실행은 외부 수집·색인을 시작하지 않습니다.

기존 `catalog-sync-once` 프로필은 비용 상한 사전 검사·재실행 방지 receipt를 유지합니다.
독립 DB migration은 미리 완료해야 하며 이 프로필 자체는 Flyway와 scheduler를 끕니다.
`--spring.profiles.active=catalog-sync-once`에 `app.catalog-sync-once.sources`, `max-usd`,
절대 `receipt-path`를 명시합니다. 기본 `apply=false`는 외부 수집 후 비용을 계산하며,
`apply=true`는 승인한 유료 색인과 DB 공개를 수행합니다. 이 구현 작업에서는 실행하지 않습니다.

## 검증

JDK 21과 Docker가 실행 중인 환경에서 `./gradlew clean build --no-daemon`을 실행합니다.
수집/AI HTTP는 테스트 대역이며 유료 API를 호출하지 않습니다. 실제 MySQL 8.4와
`../../infrastructure/elasticsearch/Dockerfile`의 Elasticsearch+Nori는 격리된 Testcontainers로 실행합니다.
Repository 테스트는 반복 수집, 누락 비활성화, 제공처 독립성, 한글/JSON/nullable 날짜,
다중 batch rollback, revision/UUID, 상태만 바뀌는 갱신, REPEATABLE READ, 인증/미공개 오류를 검증합니다.
