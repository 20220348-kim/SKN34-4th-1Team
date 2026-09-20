# Redis 적용 범위와 검색 결과 복원

[문서 목록](README.md) · [호출·데이터 흐름](architecture.md) · [Compose 실행](../infrastructure/README.md)

## 1. 어디에 적용했는가

Redis는 **비회원이 검색한 뒤 로그인했을 때, 방금 검색한 전체 결과와 검색 조건을 복원하는 기능**에 적용했습니다.
Core API 내부 메모리에 두던 임시 결과를 Redis로 옮긴 것입니다. 모든 검색을 Redis에서 처리하는 구조는 아닙니다.

예를 들어 비회원이 “서울 AI 창업지원 사업 찾아줘”로 검색해 최종 추천 5건을 얻었다면 다음과 같이 동작합니다.

1. 서버는 기존 MySQL·AI Service·Qdrant 검색 경로로 추천 결과를 만듭니다.
2. 전체 5건과 당시 검색 조건을 Redis에 30분 동안 보관합니다.
3. 비회원 브라우저에는 앞의 2건만 공개하고, 나머지 결과를 찾을 임시 번호인 `resultToken`을 전달합니다.
4. 사용자가 잠금 카드를 선택하고 로그인하면, 같은 토큰으로 Redis의 전체 5건과 검색 조건을 복원합니다.
5. 이 복원에서는 검색·임베딩·AI 점수화를 다시 실행하지 않습니다.

`resultToken`은 로그인 토큰이 아닙니다. 보관된 검색 결과를 지정하는 소문자 UUID이며,
복원 API는 이 토큰과 별도로 유효한 회원 세션을 요구합니다.

| 요청 상황 | Redis 사용 | 응답 |
|---|---|---|
| 비회원 검색, 최종 추천 3~5건 | 전체 결과·조건 저장 | 공개 2건, 전체 추천 수, `resultToken`, `expiresAt` |
| 비회원 검색, 최종 추천 0~2건 | 사용하지 않음 | 해당 결과 전체, 토큰·만료 시각은 `null` |
| 로그인 상태에서 새 검색 | 사용하지 않음 | 최종 추천 최대 5건, 토큰·만료 시각은 `null` |
| 로그인 후 이전 검색 결과 복원 | 토큰 소유권 확인·결과 조회 | 보관된 전체 결과와 `context`, 토큰·만료 시각은 `null` |

`totalCount`는 전체 DB 공고 수나 Qdrant 후보 수가 아니라 **이번 최종 추천 수인 0~5**입니다.
Redis에 보관하는 것도 후보 최대 20건이 아니라 최종 추천 최대 5건입니다.

## 2. 적용 이유와 성능상 의미

기존 Core 프로세스 내부 메모리에는 다음 한계가 있었습니다.

- Core를 재시작하면 아직 만료되지 않은 검색 결과도 사라집니다.
- Core가 여러 개라면 결과를 저장한 서버와 복원 요청을 받은 서버가 달라 복원에 실패할 수 있습니다.
- 기존 128건 제한에서는 30분이 지나지 않은 결과도 새 결과에 밀려 제거될 수 있었습니다.

같은 Redis를 사용하는 Core들은 임시 결과·소유 계정·만료 시각을 공유합니다. 다만 이것만으로
전체 애플리케이션의 다중 인스턴스 운영 준비가 끝나는 것은 아닙니다. 요청 제한 등 다른 메모리 상태는 별개입니다.

**이번 변경은 첫 AI 검색의 응답 시간을 줄이는 최적화가 아닙니다.** 첫 검색은 여전히 기존 검색 경로를
거친 뒤 Redis에 추가로 저장합니다. 로그인 후 모델 재호출 없이 복원하는 동작은 이전에도 있었으며,
이번에는 그 임시 저장소를 서버 재시작과 여러 Core에서도 사용할 수 있게 바꿨습니다.
속도 향상률·API 비용 절감률·최대 동시 사용자 수를 측정한 변경으로 해석하면 안 됩니다.

## 3. 실제 호출 흐름

### 검색 결과 저장

```text
GET 또는 POST /api/v1/support-programs/search
  → SupportProgramController
    → SupportProgramRequestAdmissionService: 기존 요청량·동시 실행 제한
      → SupportProgramSearchPreviewService.search
        → SupportProgramSearchService.search: 기존 검색 수행
          → MySQL 공고 조회
          → 자연어 검색이면 AI Service·Qdrant 후보 검색 및 AI 랭킹
        → 비회원이고 최종 결과가 3건 이상인가?
          ├─ 아니오: 결과 전체 반환, Redis 호출 없음
          └─ 예: UUID 생성, 전체 결과·조건 스냅샷 구성
              → SupportProgramSearchResultRepository.save
                → JSON 직렬화·크기 검사
                → StringRedisTemplate → save-search-result.lua → Redis
              → 공개 2건 + totalCount + resultToken + expiresAt 반환
```

빈 검색어 GET은 AI 없이 MySQL 공개 공고를 최신순 최대 5건으로 선택합니다.
이 경우에도 비회원 결과가 3건 이상이면 동일하게 Redis에 저장합니다. 채팅 화면은 빈 검색어를 제출하지 않습니다.

### 로그인 후 복원

```text
잠금 카드 선택 → 로그인/회원가입 → 선택한 결과의 복원 요청
  → POST /api/v1/support-programs/search/results
    → 기존 회원 세션 확인: MySQL 경로 유지
    → SupportProgramController.restoreSearchResults
      → SupportProgramSearchPreviewService.restore
        → SupportProgramSearchResultRepository.claim
          → StringRedisTemplate → claim-search-result.lua → Redis
          → 토큰 존재·TTL·소유 계정 확인, 미귀속이면 최초 계정 연결
        → JSON을 Domain 스냅샷으로 복원
      → 보관된 전체 결과와 검색 조건 반환
```

요청 본문은 `{ "resultToken": "발급받은 소문자 UUID" }`입니다. 회원 세션 쿠키와 기존 POST 요청의
Origin/Referer 검증도 그대로 적용합니다. 복원은 검색의 AI 요청 제한을 소비하지 않습니다.

복원 중 공고 카탈로그를 MySQL에서 다시 조회하지는 않지만, **회원 인증까지 MySQL 없이 처리하는 것은 아닙니다.**
또한 복원 시점의 최신 공고·접수 상태·점수를 재계산하지 않고 검색 당시 결과를 반환합니다.
그 사이 공고가 변경되거나 날짜가 바뀌어도 스냅샷을 자동 갱신하지 않으므로 최신 조건은 상세·원문에서 확인해야 합니다.

프론트엔드의 [복원 Hook](../frontend/web/src/presentation/features/chat/hooks/useRestoreSupportProgramSearch.ts)은
로그인 후 URL의 `searchResult`를 읽고 주소에서 제거한 뒤 복원합니다. 그동안 계정·대화·화면이 바뀌면
진행 중인 복원 응답을 현재 대화에 적용하지 않습니다. 이 화면 처리도 Redis가 대화 전체를 저장한다는 의미는 아닙니다.

## 4. 저장 데이터와 코드 위치

### Redis 자료 구조

검색 한 번당 Redis Hash 키 하나를 사용합니다.

```text
키: govbiz:search-result:v1:{SHA-256(resultToken)}
자료형: Hash
  payload   → SupportProgramSearchSnapshot의 JSON 문자열
  accountId → 최초 복원 계정의 ID 문자열; 아직 복원하지 않았으면 필드 없음
키의 TTL   → 저장 시각부터 고정 30분
```

`accountId`는 JSON 내부가 아니라 같은 Hash의 별도 필드입니다. 로그인 전에는 소유 계정을 모르므로
저장하지 않고, 최초 인증된 복원 요청 때 연결합니다. 만료는 JSON 필드가 아니라 Redis 키의 만료 기능으로 관리합니다.

| `payload` 항목 | 저장 내용 |
|---|---|
| `query` | 정규화된 검색어 |
| `programs` | 최종 추천 전체. 공고 ID·제공처 코드, 제목·기관·요약, 분야·지역·대상, 신청 기간·접수 상태, 출처 URL, 추천 이유·점수·자격 검토 |
| `context.query` | 대화 복원용 검색 의도. 빈 GET 검색이면 `null`이고 상위 `query`는 `""` |
| `context.acceptingOnly` | 접수 중인 공고만 검색했는지 여부 |
| `context.companyConditions` | 이번 검색의 지역·업종·설립일·지원 목적. 미입력 필드는 `null` |

공고 식별자는 `sourceCode`와 `id`를 모두 보관합니다. 계산 프로퍼티 `sourceQualifiedId`는 저장 JSON에서만
제외하며 공개 HTTP 직렬화 설정은 바꾸지 않습니다. JSON을 새 객체로 읽고 결과의 내부 목록도 복사하므로
한 호출의 목록 수정이 다른 복원 결과에 섞이지 않게 합니다.

검색어를 Redis 키로 쓰거나 서로 다른 사용자의 동일 질문을 하나의 스냅샷으로 합치지 않습니다.
API 키·DB 비밀번호·회원 비밀번호·세션 JWT·전체 대화 내역도 이 스냅샷에 넣지 않습니다.
다만 검색문 자체에 민감한 정보를 입력하면 그 텍스트는 `payload`에 포함될 수 있습니다.

### 책임별 구현 파일

| 파일 | 책임 |
|---|---|
| [SupportProgramController](../backend/core-service/src/main/kotlin/ai/govbiz/core/supportprogram/controller/SupportProgramController.kt) | 검색·복원 HTTP 진입점, 회원 정보를 Service에 전달 |
| [SupportProgramSearchPreviewService](../backend/core-service/src/main/kotlin/ai/govbiz/core/supportprogram/service/search/SupportProgramSearchPreviewService.kt) | 공개 건수 정책, 스냅샷 생성·복원 유스케이스 |
| [SupportProgramSearchSnapshot](../backend/core-service/src/main/kotlin/ai/govbiz/core/supportprogram/domain/SupportProgramSearchSnapshot.kt) | 검색어·전체 결과·대화 조건을 담는 내부 모델 |
| [SupportProgramSearchResultRepository](../backend/core-service/src/main/kotlin/ai/govbiz/core/supportprogram/repository/SupportProgramSearchResultRepository.kt) | JSON 변환, 키 해시, 용량 검사, Redis 스크립트 실행·오류 변환 |
| [save-search-result.lua](../backend/core-service/src/main/resources/redis/supportprogram/save-search-result.lua) | 키 충돌 검사, 저장, Redis 시계 기준 만료 지정 |
| [claim-search-result.lua](../backend/core-service/src/main/resources/redis/supportprogram/claim-search-result.lua) | TTL·소유 계정 확인과 최초 계정 연결을 원자적으로 실행 |
| [SupportProgramSearchResultRedisConfig](../backend/core-service/src/main/kotlin/ai/govbiz/core/supportprogram/repository/config/SupportProgramSearchResultRedisConfig.kt) | Redis 연결용 DNS 캐시와 리소스 수명 관리 |
| [ApiExceptionHandler](../backend/core-service/src/main/kotlin/ai/govbiz/core/_common/exception/ApiExceptionHandler.kt) | 만료 410과 저장소 장애 503을 구분한 공개 오류 응답 |

`spring-boot-starter-data-redis`의 `StringRedisTemplate`과 Lettuce를 사용합니다.
Redis 접근은 해당 기능의 구체 Repository에 두었고, 별도 DAO·Repository 인터페이스·Facade·범용 캐시 계층은
추가하지 않았습니다. MyBatis Mapper/XML은 관계형 DB 전용이므로 Redis 호출에는 사용하지 않습니다.

## 5. 만료와 계정 소유권

### 저장 규칙

1. Service에서 UUID를 만들고 Repository에서 JSON을 직렬화합니다.
2. UTF-8 JSON이 2MiB를 넘으면 Redis에 저장하지 않고 오류로 처리합니다.
3. Lua에서 키가 이미 있으면 기존 결과와 소유 계정을 덮어쓰지 않고 저장 실패로 처리합니다.
4. Redis `TIME`에 30분을 더한 뒤 `HSET`과 `PEXPIREAT`으로 저장·만료를 지정합니다.
5. 같은 만료 시각을 HTTP 응답의 UTC ISO-8601 `expiresAt`으로 전달합니다.

### 복원 규칙

- 키가 없거나 만료됐으면 복원할 수 없습니다.
- 소유 계정이 없으면 현재 인증된 계정 ID를 기록하고 결과를 반환합니다.
- 같은 계정이면 다시 복원할 수 있습니다. 한 번 읽었다고 즉시 삭제하지 않습니다.
- 다른 계정이면 복원할 수 없습니다.
- 조회·로그인·계정 연결로 TTL을 연장하지 않습니다.

예를 들어 14:00에 저장하고 14:10에 로그인해 복원해도 만료는 14:30입니다.
14:29에 같은 계정으로 다시 복원해도 14:59로 늘어나지 않습니다.

계정 확인과 연결을 애플리케이션에서 별도 명령으로 나누면 두 Core가 동시에 “주인 없음”을 볼 수 있습니다.
이를 하나의 Lua 스크립트로 실행해, 동시에 서로 다른 계정이 요청해도 하나의 계정만 최초 소유자가 되게 합니다.
계정 ID는 문자열로 비교해 큰 정수의 정밀도가 손실되지 않게 합니다.

## 6. 장애·용량·보안 경계

| 상황 | 처리 |
|---|---|
| 복원 요청의 UUID 형식 등 공개 입력이 잘못됨 | 공개 DTO 검증에서 400 |
| 복원 요청이 미인증이거나 세션이 유효하지 않음 | 기존 인증 오류 401 |
| 토큰 미존재·만료·다른 계정의 복원 | 410 `SUPPORT_PROGRAM_SEARCH_RESULT_EXPIRED` |
| Redis 연결 실패·시간 초과·용량 초과·JSON 읽기 실패 등 | 503 `SUPPORT_PROGRAM_SEARCH_RESULT_STORE_UNAVAILABLE` |

TTL이 없거나 `payload`가 없는 비정상 저장 데이터도 정상 만료로 숨기지 않고 저장소 오류로 처리합니다.
저장소 내부 예외·접속 정보는 공개 응답에 그대로 노출하지 않습니다. 검색·복원 응답은 `Cache-Control: no-store`입니다.

Redis 장애 중 비회원 검색의 결과가 3건 이상이면 **검색 계산이 끝났더라도 저장 단계에서 503이 될 수 있습니다.**
토큰 없이 성공한 것처럼 반환하거나, 실패 후 메모리에 대신 저장하는 fallback은 없습니다.
이미 실행한 검색의 모델 호출 비용까지 되돌리는 것은 아니며, 복원 실패 시 서버가 자동 재검색하지도 않습니다.
회원의 새 검색·비회원 0~2건 결과·일반 카탈로그는 이 Redis Repository를 호출하지 않습니다.

Compose의 정책은 `maxmemory=128mb`, `maxmemory-policy=noeviction`입니다.
오래된 유효 결과를 새 결과 때문에 임의 퇴거하지 않는 대신, 메모리가 부족하면 쓰기 요청이 실패할 수 있습니다.
이는 128건 제한도 아니고 컨테이너 전체 RSS가 정확히 128MiB 이하라는 뜻도 아닙니다.
JSON 크기와 Redis 메타데이터 등에 따라 수용 가능한 결과 수가 달라집니다.

Redis는 단일 인스턴스이고 `redis-data` 볼륨에 AOF(`appendfsync everysec`)를 기록합니다.
볼륨을 유지한 정상 재생성에서는 만료 전 결과와 소유 계정을 복원할 수 있지만, 비정상 종료 시 최근 약 1초의
쓰기·소유 계정 연결이 유실될 수 있습니다. 복제·Sentinel·Cluster·장애 조치는 이번 구현에 포함하지 않았습니다.

보안·운영 시 다음 제한을 지켜야 합니다.

- 로컬 Compose Redis는 무인증 개발망 내부 전용이며 호스트 포트를 공개하지 않습니다. 운영에는 네트워크 격리·ACL/TLS가 필요합니다.
- 토큰 해시는 **키에 원본 토큰을 그대로 넣지 않는 처리**이지 JSON 암호화가 아닙니다. 검색 조건과 계정 ID를 일반 공개 데이터로 취급하지 않습니다.
- 아직 계정에 연결되지 않은 토큰이 유출되면 이를 가진 다른 로그인 계정이 먼저 복원할 수 있습니다. 토큰·복원 URL·`payload`를 로그나 이슈에 올리지 않습니다.
- 30분 TTL은 조회 만료 정책입니다. AOF·백업·로그에서 30분 뒤 물리적으로 즉시 지워진다고 보장하지 않습니다.
- Redis가 모든 검색 데이터의 원본 저장소는 아니지만, 해당 임시 토큰의 원본은 Redis에만 있습니다. 볼륨을 삭제하면 기존 토큰은 복구되지 않습니다.
- 도입 전 Core 메모리에 있던 토큰은 자동 이관하지 않습니다. 배포 시 해당 사용자는 다시 검색해야 합니다.

## 7. 연결 설정과 확인 방법

설정은 [application.properties](../backend/core-service/src/main/resources/application.properties)와
[compose.yaml](../infrastructure/compose.yaml)에 있습니다. Spring Data Redis 의존성 버전은 기존 Spring Boot가 관리합니다.

| 설정 | 기본값·적용 범위 |
|---|---|
| Redis 이미지 | Compose `redis:8.2.9-alpine` |
| `REDIS_HOST` / `REDIS_PORT` | Core 직접 실행: `127.0.0.1:6379`. Compose: `redis:6379` 고정 |
| `REDIS_USERNAME` / `REDIS_PASSWORD` | 직접 실행 시 외부 Redis 인증 설정. 기본 빈 값 |
| `REDIS_SSL_ENABLED` | 직접 실행 시 외부 Redis TLS 설정. 기본 `false` |
| `REDIS_CONNECT_TIMEOUT` | 연결 제한, 기본 `1s` |
| `REDIS_TIMEOUT` | 명령 제한, 기본 `1s`. HTTP 요청 전체가 반드시 1초 안에 끝난다는 의미는 아님 |
| `spring.data.redis.repositories.enabled` | `false`. 자동 Redis Repository 검색 대신 구체 Repository와 템플릿 사용 |
| TTL / JSON 크기 | Repository 코드의 30분 / 2MiB 상수. 현재 환경변수 설정 아님 |
| 메모리·디스크 정책 | Compose의 128mb·noeviction·AOF everysec·`redis-data` |

외부 인증/TLS 변수는 현재 로컬 Compose에 전달하지 않습니다. 운영 Redis를 연결하려면 그에 맞는 배포 설정이 필요합니다.
Core만 직접 실행할 경우 Compose Redis는 호스트 포트를 열지 않으므로 별도로 접근 가능한 Redis를 준비해야 합니다.

Redis 컨테이너 재생성 시 IP가 바뀔 수 있어 Lettuce 전용 DNS 캐시를 최대 5초, 실패 캐시는 0초로 설정했습니다.
기존 IP를 오래 기억해 재연결하지 못하는 문제를 방지하며 JVM 전역이나 외부 HTTP 클라이언트 DNS는 바꾸지 않습니다.
5초는 DNS 캐시 상한이지 서비스 복구 시간 보장은 아닙니다.

실행 중인 개발 스택에서 다음 명령은 데이터 내용을 출력하지 않고 상태만 확인합니다. 저장소 루트 기준입니다.

```bash
docker compose --env-file .env --file infrastructure/compose.yaml exec -T redis redis-cli PING
docker compose --env-file .env --file infrastructure/compose.yaml exec -T redis redis-cli DBSIZE
docker compose --env-file .env --file infrastructure/compose.yaml exec -T redis redis-cli INFO memory
docker compose --env-file .env --file infrastructure/compose.yaml exec -T redis redis-cli INFO persistence
```

`PING`은 `PONG`을 반환해야 합니다. `DBSIZE`는 해당 Redis DB의 모든 키 수이며 회원 수·대화 수가 아닙니다.
`PONG`이나 Core `/api/v1/health`의 성공만으로 실제 저장·계정 복원까지 검증됐다고 판단하지 않습니다.
장애 조사는 용량·AOF 상태·연결 오류도 함께 확인해야 합니다.
기존 스택에 Redis를 추가하고 Core를 갱신하는 순서는 [Compose 갱신 안내](../infrastructure/README.md)를 따릅니다.

## 8. Redis로 옮기지 않은 기능

| 기능·데이터 | 현재 위치·구조 | 이번 변경 |
|---|---|---|
| 공고 원본·공개 상태·상세·공식 원문 | MySQL | 유지 |
| 계정·로그인 세션·계정별 대화 기록 | MySQL | 유지. Redis TTL 때문에 저장된 대화가 지워지지 않음 |
| 공고·원문 청크 벡터 | Qdrant | 유지 |
| AI 랭킹 정확일치 응답 캐시·동시 요청 재사용 | AI Service 프로세스 메모리 | Redis 전환하지 않음 |
| 질의 임베딩 캐시 | AI Service 프로세스 메모리 | Redis 전환하지 않음 |
| 요청량·동시 실행 제한 | Core 프로세스 내부 상태 | Redis 분산 제한으로 바꾸지 않음 |
| 동기화 잠금·작업 큐·Pub/Sub | 이번 Redis 적용 대상 아님 | 새로 구현하지 않음 |

기존 AI 캐시는 [랭킹 Service](../backend/ai-service/app/support_program_ranking/service.py)와
[검색 색인 Service](../backend/ai-service/app/support_program_index/service.py),
요청 제한은 [요청 제한 문서](support-program-request-limits.md)를 참고하세요.
향후 AI 캐시까지 옮기려면 실제 캐시 적중률·병목·일관성·무효화 조건을 따로 검토해야 합니다.

## 9. 검증 범위와 재현

Redis 도입 검증 기록(2026-09-12): Core clean build의 테스트 1,206개, Frontend 테스트 1,028개,
인프라 스크립트 테스트 22개가 통과했고 Frontend lint·build와 Docker 통합 검사도 통과했습니다.
이는 해당 시점의 결과이며 이후 변경에도 자동으로 유효한 성능·품질 보증은 아닙니다.

| 검증 파일 | 확인한 내용 |
|---|---|
| [Repository 테스트](../backend/core-service/src/test/kotlin/ai/govbiz/core/supportprogram/repository/SupportProgramSearchResultRepositoryTest.kt) | 실제 Redis에서 JSON·한글·날짜·복합 식별자, 별도 클라이언트 복원, TTL·계정 경합, 충돌·손상 데이터·용량 초과 |
| [Preview Service 테스트](../backend/core-service/src/test/kotlin/ai/govbiz/core/supportprogram/service/search/SupportProgramSearchPreviewServiceTest.kt) | 공개 건수 분기, 전체 결과·조건 복원, 만료·소유권, 기존 128건 조기 퇴거 제거 |
| [Controller 테스트](../backend/core-service/src/test/kotlin/ai/govbiz/core/supportprogram/controller/SupportProgramSearchPreviewControllerTest.kt) | 인증·응답 계약·명시적 503·no-store·복원 시 추가 검색 없음 |
| [DNS 설정 테스트](../backend/core-service/src/test/kotlin/ai/govbiz/core/supportprogram/repository/config/SupportProgramSearchResultRedisConfigTest.kt) | Spring의 Lettuce가 수명 관리되는 DNS 설정을 실제로 사용 |
| [Frontend API 테스트](../frontend/web/src/data/api/__tests__/supportProgramSearchResults.test.ts) | 복원 503을 정상 결과나 만료가 아닌 사용 불가 오류로 변환 |
| [Compose 검증 스크립트](../infrastructure/scripts/verify-compose.sh) | Core 재시작, 다른 계정 차단, Redis 중지 시 503, 새 IP·동일 AOF 볼륨으로 재생성한 뒤 동일 결과 복구 |

Core 전체 검증은 JDK 21과 Docker가 준비된 상태에서 실행합니다. 실제 MySQL·Redis Testcontainers를 사용합니다.

```bash
cd backend/core-service
./gradlew clean build --no-daemon
```

전체 연결 검증은 저장소 루트에서 실행합니다. 기존 개발 포트와 충돌하지 않게 검증용 MySQL 포트를 지정한 예입니다.

```bash
VERIFY_COMPOSE_MYSQL_HOST_PORT=23306 ./infrastructure/scripts/verify-compose.sh
```

이 스크립트는 별도 검증 프로젝트의 실제 MySQL·Qdrant·Redis와 외부 API 스텁을 사용합니다.
검증 중에는 **검증용** Core·Redis 등을 중지·재생성하고, 종료 시 기본적으로 검증용 컨테이너·볼륨을 정리합니다.
기존 개발 프로젝트를 대상으로 장애 검사를 수동 재현하거나 사용자 데이터 볼륨을 삭제하지 마세요.
다른 포트·프로젝트 설정과 정리 정책은 [Compose 검증 안내](../infrastructure/README.md)를 먼저 확인합니다.

유료 OpenAI 호출이나 실제 검색 품질 평가를 수행한 검증은 아닙니다. 개발 Docker에서도 빈 검색으로
공개 2건·전체 추천 5건·토큰 발급과 Redis 저장을 확인했으며, 로그인·장애·복구의 전체 경로는 별도 검증 스택에서 확인했습니다.
