# 기술 스택과 데이터 구성

[메인 README](../README.md) · [기술 README](technical-readme.md) · [문서 목록](README.md) · [아키텍처 README](architecture/README.md)

이 문서는 저장소의 코드와 설정을 기준으로 각 기술의 역할과 주요 구현 방식을 설명합니다.
기능의 완성 범위와 후속 과제는 [구현 현황](implementation-status.md)에서 관리합니다.

## 기술 스택과 역할

버전은 저장소 설정 기준입니다. 범위로 선언한 패키지의 정확한 설치 버전은 각 lock 파일을 따릅니다.

| 영역 | 기술·설정 | 역할 | 기준 파일 |
|---|---|---|---|
| 웹 런타임 | Node.js 24.x, pnpm 11.22.x | 개발·빌드 환경 | [package.json](../frontend/web/package.json) |
| 화면 | React 19, TypeScript 6, React Router 8 | 채팅·상세·계정 화면과 로그인 여부에 따른 URL 라우팅 | [package.json](../frontend/web/package.json) |
| 웹 도구 | Vite 8, Tailwind CSS 4 | 개발 서버, 번들링, 스타일 | [package.json](../frontend/web/package.json) |
| 상태·연결 | Redux Toolkit 2, Awilix 13 | 대화 상태, UseCase·Repository 생성과 연결 | [app 구성](../frontend/web/src/app) |
| 웹 검증 | Zod 4, React Hook Form 7 | HTTP 응답과 예제 폼 검증 | [Frontend 안내](../frontend/web/README.md) |
| 공개 API | JDK 21, Kotlin 2.4.10, Spring Boot 4.1.0 | HTTP 계약, 업무 흐름, 외부 통신 | [build.gradle](../backend/core-service/build.gradle) |
| DB 접근 | MyBatis Spring Boot Starter 4.0.0, Flyway | XML SQL 실행과 스키마 버전 관리 | [build.gradle](../backend/core-service/build.gradle) |
| 원문 파싱 | jsoup 1.23.2 | 기업마당 상세 HTML의 제목 확인과 공고 본문 추출 | [build.gradle](../backend/core-service/build.gradle) |
| 비밀번호 해시 | spring-security-crypto(BCrypt) | 회원 비밀번호 해시·비교. Security filter chain은 사용하지 않음 | [build.gradle](../backend/core-service/build.gradle) |
| 사업자 확인 | Bizno(bizno.net) 사업자등록번호 조회 API | 기업 등록 시 등록 여부·상호·사업자 상태 확인. 키는 `BIZNO_API_KEY` | [계정·인증 계약](account-auth-contract.md) |
| AI API | Python 3.12(Docker)·3.11(CI), FastAPI 0.139.x, Pydantic 2 | 내부 API와 구조화된 요청·응답 검증 | [pyproject.toml](../backend/ai-service/pyproject.toml) |
| AI 호출 | LangChain 1.x, LangGraph 1.x, OpenAI SDK 3.x, Agents SDK 0.22.x, tiktoken | LangChain 조건 해석·추천·근거 답변, LangGraph 도우미, 임베딩·입력 토큰 제한 | [pyproject.toml](../backend/ai-service/pyproject.toml) |
| 공고 저장 | MySQL 8.4 | 현재 공고와 원본 식별자, 신청 기간 저장 | [Compose 설정](../infrastructure/compose.yaml) |
| 의미 검색 | Qdrant 1.17.1, qdrant-client 1.17.x | 임베딩 벡터 저장과 유사도 검색 | [Compose 설정](../infrastructure/compose.yaml) |
| 한국어 키워드 검색 | Elasticsearch 9.5.3, analysis-nori 9.5.3, BM25 | 현재 공고 버전의 키워드 후보 최대 20개, 의미 후보와 RRF 결합 | [적용 상세](elasticsearch-lexical-search.md) |
| 임시 검색 결과 보관 | Redis 8.2.9, Spring Data Redis·Lettuce | 비회원 검색 후 로그인 복원용 전체 결과·조건·소유 계정, 고정 30분 TTL | [Redis 적용 상세](redis-search-result-restoration.md) |
| 백그라운드 작업 전달 | RabbitMQ 4.3.5, Spring AMQP | 리포트 생성·메일 발송·중복 검토·공식 문서 분석별 quorum queue. 실행 상태·Outbox는 MySQL | [생성](rabbitmq-daily-report-generation.md) · [발송](rabbitmq-daily-report-delivery.md) · [중복 검토](rabbitmq-combination-review.md) · [공식 문서·운영 조회](rabbitmq-application-form-discovery.md) |
| 검증·실행 | Vitest, Testing Library, JUnit, Testcontainers, pytest, Docker Compose | 서비스별 테스트와 컨테이너 통합 검증 | [CI 정의](../.github/workflows/ci.yml) |

AI 패키지는 Python `>=3.11,<3.15`를 선언하며, Frontend와 AI Service의 의존성은 각각
`pnpm-lock.yaml`, `uv.lock`으로 관리합니다. 전체 환경변수는 서비스별 README에서 설명합니다.

## 아키텍처 설명

**Elasticsearch + Nori·BM25**를 자연어 검색의 키워드 후보와 공개 전 색인·정기 복구에 연결했습니다.
MySQL 원본·Qdrant 의미 검색·Redis 역할은 그대로입니다. 독립적인 고정 스냅샷
[비교 실험과 한계](../evaluation/support-program-search/elasticsearch/README.md)도 보존합니다.

코드 계층·DI·MVVM·Flux·Facade·Agent 구조는 [아키텍처 README](architecture/README.md)로 모았습니다.
아래는 기술별 데이터 역할이며, 요청·동기화의 상세 순서는 [서비스 호출·데이터 흐름](architecture.md)을 참고하세요.

## MySQL·Elasticsearch·Qdrant·Redis의 역할

Elasticsearch에는 MySQL 공고로 만든 검색 본문·ID·내용 해시·정렬 값의 불변 버전을 저장합니다.
한국어 형태소 기반 키워드 순위를 담당하며 최종 원본 데이터베이스나 신청 자격 판정기는 아닙니다.
[버전 필터·복구·이전 버전 보존의 한계](elasticsearch-lexical-search.md)를 참고하세요.

MySQL과 Qdrant의 공고 저장·검색 역할은 다음과 같습니다. Redis는 이 둘을 대체하지 않고,
별도로 비회원의 최종 검색 결과·조건을 로그인 후 복원하기 위해 30분 보관합니다.
회원 세션·대화 기록은 MySQL에 유지하며 AI 랭킹·질의 임베딩 캐시는 Redis로 옮기지 않았습니다.
저장 구조·적용 분기·장애 경계는 [Redis 적용 상세](redis-search-result-restoration.md)를 참고하세요.

| 구분 | MySQL | Qdrant |
|---|---|---|
| 저장 대상 | 공고 제목·요약·신청 기간·출처·노출 상태, 공고별 공식 원문 텍스트 | 공고 검색 텍스트 임베딩, 원문 청크 임베딩과 각 ID·내용 해시 |
| 주요 용도 | 현재 검색 대상 결정·상세 조회, 원문 질문의 캐시 | 검색 문장 후보 선정, 특정 원문 질문의 근거 청크 선정 |
| 갱신 방식 | 제공처별 공고 UPSERT·누락 비활성화, 명시적 질문 성공 후 원문 UPSERT | 공고 ID·내용 해시별 벡터 생성·재사용, 원문 청크 전용 별도 컬렉션 색인 |
| 데이터 기준 | 현재 공개 카탈로그·공개 공고에 연결된 공식 원문 | MySQL 원문·공고 모델에서 재구성할 수 있는 파생 색인 |

MySQL의 `support_program`은 `(source_code, source_program_id)`를 고유키로 사용합니다.
분야·지역은 JSON 배열로, 신청 기간은 원문과 nullable 날짜로 저장합니다. `support_program_sync_generation`은
가장 최근에 시작된 동기화 세대를 기록합니다. `support_program_source_document`는 같은 복합 식별자에
공식 HTML에서 정규화한 원문·URL·해시·수집 시각을 저장하며, 공고를 FK로 참조하고 조회 시 공개 상태를 확인합니다.
이 원문 테이블은 명시적 기업마당 원문 질문에서 원문 수집·검증이 성공했을 때 채워집니다.
`support_program_sync_status`는 공개 스냅샷·색인 준비·최근 동기화 결과를 분리해 기록합니다.
`account`는 이메일(고유)·BCrypt 비밀번호 해시·역할·이메일 인증·정지·삭제 시각을, `account_session`은 세션 JWT의
SHA-256 해시·만료·마지막 사용 시각을 계정 FK와 함께 저장합니다. `partner_recruitment`는 계정·기업·공고 FK와 계정+공고 UNIQUE로 모집글을 저장하고 역량은 JSON 배열입니다. `partner_proposal`은 모집글·제안 계정·기업 FK와 모집글+제안 계정 UNIQUE로 제안을 저장하고 결정·응답·철회 시각만 두어 상태는 조회 시점에 계산합니다. `company`는 계정당 하나(계정·사업자번호 UNIQUE)로 사업자등록번호
조회 값(상호·사업자 상태)과 담당자 입력(소재지·업종·설립연도·홈페이지)을 저장합니다.
스키마는 [Flyway migration](../backend/core-service/src/main/resources/db/migration)으로 관리합니다.

접수 상태는 DB에 고정 저장하지 않고 조회 시 `Asia/Seoul`의 오늘 날짜로 계산합니다. 파싱된 날짜를
우선하고, 날짜만으로 결정하지 못한 경우 예정·종료·상시 등의 알려진 표현을 해석합니다. 종료 표현은
상시 표현보다 우선하며, 판정할 수 없으면 `UNKNOWN`입니다. 원문에 적힌 모든 예외 조건을 이해하는 판정기는 아닙니다.

검색 문서는 제목·기관·지원대상·분야·지역·신청기간·요약을 결합합니다. Core가 최대 12,000 코드 포인트로
제한한 텍스트의 SHA-256을 계산하고, AI Service는 임베딩 입력을 최대 8,191 토큰으로 제한합니다.
벡터 식별에는 `sourceCode:sourceProgramId`와 내용 해시를 함께 사용합니다. MySQL에 `content_hash` 컬럼은 있지만
현재 Repository는 이를 읽고 쓰지 않으며, 해시는 [검색 문서 Mapper](../backend/core-service/src/main/kotlin/ai/govbiz/core/supportprogram/client/ai/mapper/SupportProgramIndexDocumentMapper.kt)에서 계산합니다.

원문 질문은 기업마당 공식 HTTPS 상세 HTML만 최대 500KB로 읽습니다. 자동 리디렉션을 끄고 매 이동마다
공식 HTTPS 호스트와 동일한 `pblancId`를 확인해 최대 3회 따릅니다. jsoup `1.23.2`로 HTML을 파싱한 뒤
`.support_project_detail`의 `.title_area .title`이 요청 공고 제목과 일치하는지 확인하고 `.view_cont` 본문만
최대 30,000자로 정규화합니다. Core의 `SupportProgramEvidenceChunker`가 텍스트·원문 해시·순서에서 결정적으로
최대 50개, 각 최대 1,500 UTF-16 코드 단위의 청크를 만듭니다. AI Service는 일반 공고 벡터와 다른 Qdrant evidence
컬렉션에 이 청크만 색인하고, 해당 공고의 청크를 최대 5개 검색해 근거 답변 Agent에 전달합니다.
Core는 선택한 인용 청크 전체를 반환해 답변의 근거가 청크 뒤쪽에 있어도 확인할 수 있게 합니다.

## 동기화와 색인 공개

```text
동기화 세대 발급 → 기업마당 전체 페이지 수집·검증 → Elasticsearch 키워드 색인 → Qdrant 벡터 준비
    → 최신 시작 세대인지 확인 → MySQL 카탈로그를 하나의 트랜잭션으로 공개
```

기본 스케줄은 앱 시작 시 초기 지연 `PT0S`로 한 번, 이후 이전 실행이 끝난 시점부터 6시간 뒤입니다. 외부 수집과
색인은 DB 트랜잭션 밖에서 수행합니다. 두 색인이 모두 준비된 뒤 현재 세대만 DB에 반영하므로,
색인 실패로 신규 공고의 검색 준비가 끝나지 않으면 기존 공개 카탈로그를 유지합니다.

DB 반영은 기존 `BIZINFO` 공고를 미노출 처리한 뒤 이번 목록을 UPSERT해 다시 노출하는 방식입니다.
이 두 작업은 한 트랜잭션이며 실패하면 함께 롤백됩니다. 늦게 끝난 이전 동기화는 세대 확인에서 공개를
건너뜁니다. 세대 관리는 중복 수집·색인 실행 자체를 막는 분산 잠금은 아닙니다.

별도 복구 스케줄러도 앱 시작 시 초기 지연 `PT0S`로 실행하고, 이후 완료 시점부터 1분마다 현재 MySQL 공고를 확인합니다.
Elasticsearch·Qdrant에서 동일한 버전은 재사용하고 누락된 버전만 생성합니다. `SUPPORT_PROGRAM_INDEX_ENABLED=false`는
이 복구 스케줄러를 끄며, 기업마당 동기화 안의 공개 전 색인까지 끄지는 않습니다.

두 자동 경로는 `prune`을 호출하지 않습니다. 이전 내용·미노출 공고의 벡터는 현재 ID·해시 허용 목록에서
빠져 검색에 쓰이지 않지만 저장 공간은 남습니다. Elasticsearch도 이전 문서 버전을 자동 삭제하지 않으며,
이전 버전은 BM25 통계에 영향을 줄 수 있습니다. 안전한 삭제 수명주기는 후속 구현 범위입니다.

## 검색과 AI 점수화

1. MySQL에서 공개 세대·지문과 색인 준비가 확인된 제공처의 현재 공고를 읽고 접수 상태 조건을 적용합니다.
2. 현재 공고의 버전 허용 목록으로 Elasticsearch Nori·BM25 후보 최대 20개를 구합니다. AI Service에도 ID·해시 허용 목록을 전달합니다.
3. OpenAI로 검색 문장을 임베딩하고 Qdrant에서 의미 검색 후보를 최대 20개 가져옵니다.
4. Core가 검증된 Elasticsearch 키워드 순위와 Qdrant 의미 검색 순위를 동일 가중치 RRF로 결합해 후보 최대 20개를 정합니다.
5. OpenAI Agents SDK의 단일 Agent가 후보 전체의 세부 점수·자격을 판단합니다.
6. AI Service가 총점을 합산하고 최소 점수·자격 조건을 적용한 뒤, Core가 계약을 다시 검증해 최대 5개를 반환합니다.

정상 검색 범위에 대상 공고가 없으면 빈 목록을 반환합니다. 단, 기존 공고가 있는데 모든 제공처의 색인이
불가하면 빈 결과로 숨기지 않고 503을 반환합니다. 검색어가 비어 있으면 공개된 DB 스냅샷에서 AI 없이
최신순 최대 5개를 반환하므로 이후 색인 장애에도 목록을 유지합니다. 미공개 데이터는 제외합니다.
채팅 UI에서는 빈 검색어를 제출할 수 없습니다.

점수화의 실제 호출 방향은 `HTTP API → Service → Agent → OpenAI → Response`입니다.
벡터 검색은 별도 내부 API와 Qdrant를 사용하는 경로이며, 다중 Agent나 도구 탐색을 수행하지 않습니다.

C02의 조건 변경 해석은 공고 검색에 앞서는 별도 구체 Agent입니다. 전체 대화 대신 현재 조건·검색 의도·새 메시지와
필요한 경우 마지막 질문/미확정 초안 하나를 사용합니다. 변경 목록을 코드로 병합하고 사용자 확인 후 기존 검색을 실행합니다.
기존 OpenAI 클라이언트·모델을 사용하며 해석 1회가 추가됩니다. 서버 대화 저장·새 provider·graph는 없습니다.
[C02 계약과 검증](conversation-condition-update.md)을 참고하세요.

| 점수 항목 | 최대 점수 |
|---|---:|
| 의미 관련성 | 40 |
| 지원 유형 적합성 | 10 |

`govbiz-support-program-ranking-v5`는 두 점수의 합을 2배 해 100점 관련도로 환산하며 의미 관련성 20점 이상을 요구합니다.
`targetEligibility` 또는 `regionEligibility`가 `INCOMPATIBLE`이면 제외하고, 정보가 부족한
`UNKNOWN`은 확인 필요 배지로 표시하지만 감점하지 않습니다. 공식 API 본문의 인용을 판정 근거로 사용하며 태그만으로
적합 판정하지 않습니다. 자격 판정과 별개로 관련도 내림차순이며 동점은 입력 후보 순서입니다.
공개 `eligibilityReview`에는 대상·지역 판정과 설명·본문 인용을 포함하며 첨부파일은 자동 판독하지 않습니다.
이 값과 추천 점수는 신청 자격이나 선정 확률을 확정하지 않습니다.
상세한 필드와 오류 응답은 [검색 계약](support-program-search-contract.md)에 정리되어 있습니다.

공통 모델 기본값은 `OPENAI_MODEL=gpt-5.6-luna`이며 대화·원문 답변에 사용합니다.
랭킹은 `OPENAI_RANKING_MODEL`을 별도로 지정할 수 있고 미지정이면 공통 모델을 상속합니다.
`.env.example`의 정확도 우선 설정은 랭킹만 `gpt-5.6-sol`과
`OPENAI_RANKING_REASONING_EFFORT=low`를 사용합니다. 비용·지연이 늘어나는 설정이며
[고정 후보 비교 기록](../evaluation/support-program-search/runs/search-precision-v5-20260907-v1/README.md)을 근거로 선택했습니다.
임베딩은 기존 `text-embedding-3-small`·1,536차원입니다.
설정은 [AI Service config](../backend/ai-service/app/config.py)와 [.env.example](../.env.example)을 기준으로 합니다.
키 누락은 AI Service 시작 오류이며, 검색 중 모델·벡터 장애는 오류 응답으로 반환합니다.

## 원문 근거 RAG 답변

원문 근거 답변은 목록 검색의 후보 선정·점수화와 독립된 **상세 공고별 명시적 질문**입니다.
`POST /api/v1/support-programs/detail/answers`가 먼저 현재 공개 공고를 확인합니다. `BIZINFO`가 아니면
422를 반환하고, 기업마당 공고라면 URL이 같고 수집 후 6시간이 지나지 않은 MySQL 원문을 재사용합니다.
캐시가 없거나 오래됐을 때만 Core가 공식 상세 HTML을 수집·검증·저장합니다.

그 뒤 `AiSupportProgramEvidenceFacade`는 전체 청크 색인을 확인하고, 질문과 가까운 청크 최대 5개만
근거 답변 Agent에 전달합니다. Agent는 전달받은 텍스트 밖의 정보를 쓰지 않도록 지시되며, `ANSWERED`에는
최소 한 개의 청크 ID를 인용해야 합니다. Core는 인용 ID가 실제 검색한 청크 집합의 부분집합인지 재검증해
원문 URL·발췌·청크 순서를 공개합니다. 근거가 부족하면 `INSUFFICIENT_EVIDENCE`와 인용 없는 안내를 반환합니다.

이 범위에는 기업마당 첨부파일, PDF·OCR, 다른 제공처 원문, 질문 이력의 재사용이 포함되지 않습니다.
공식 원문 수집·저장·AI 오류는 목록 검색·동기화·상세 GET에 fallback이나 부작용을 만들지 않습니다.
필드와 오류 계약은 [검색·상세 API 계약](support-program-search-contract.md)을 참고하세요.

## 개발 환경과 검증

Docker Compose는 Vite 개발 서버, Core API, AI Service, MySQL, Elasticsearch, Qdrant, Redis, RabbitMQ를 함께 실행합니다.
AI Service·Elasticsearch·Redis·RabbitMQ는 기본 Compose에서 호스트 포트를 공개하지 않고 서비스 네트워크로 연결합니다.
RabbitMQ 소비자는 Core 내부에 있으며 별도 Worker 서버나 운영 고가용성 구성은 아닙니다.
이 구성에 운영 인증·배포 자동화가 포함되어 있다고 가정하면 안 됩니다.

[GitHub Actions](../.github/workflows/ci.yml)는 Frontend 테스트·lint·build, Core 빌드·MySQL·Redis·RabbitMQ 통합 테스트,
AI 테스트·패키지 빌드·평가 도구 테스트, 컨테이너 통합 검증을 정의합니다. Compose 검증은 실제
MySQL·Elasticsearch·Qdrant·Redis·RabbitMQ와 로컬 공고 제공처·OpenAI 스텁을 사용해 연결과 장애 복구를 확인합니다.
실제 공고 검색의 정확도와 원문 인용 답변의 정확도는 각각 별도의 실데이터 평가 대상입니다.
