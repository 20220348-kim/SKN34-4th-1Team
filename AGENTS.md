# Codex 구현 지침

## 적용 범위

`AI Service 구현 규칙`은 `backend/ai-service/**`에, `Core API 구조 및 명명 규칙`은
`backend/core-service/**`에 적용한다. `변경 범위별 검증`은 저장소 전체에 적용한다.
구조 규칙은 책임과 경계를 지키기 위한 것이며, 모든 기능에 같은 수의 계층·클래스를 만들라는
뜻이 아니다. 요청과 무관한 기존 코드를 이 지침에 맞추기 위해 일괄 재배치하지 않는다.

## AI Service 구현 규칙

### 단순성 우선

- 사용자가 요청한 현재 기능만 구현한다. "나중에 필요할 수 있다"는 이유로 구조를 추가하지 않는다.
- 가장 단순하게 현재 요구와 테스트를 만족하는 구현을 우선한다.
- 기본적으로 구체 클래스와 직접적인 함수 호출을 사용한다.
- 하나의 기능을 불필요하게 여러 계층, 클래스 또는 파일로 분리하지 않는다.
- 새 클래스나 파일은 현재 책임을 한 문장으로 설명할 수 있을 때만 추가한다.

### 추상화 제한

- 새로운 `Protocol`, ABC, port, provider abstraction, registry, base class, 범용 factory 및
  공통 코드 추출은 다음 조건 중 하나 이상을 충족하고, 구체 구현보다 책임·중복·장애 경계를
  명확하게 만들 때만 허용한다. 조건을 충족해도 추상화를 반드시 추가할 필요는 없다.

  1. 현재 production 구현체가 2개 이상이다.
  2. 현재 production 코드에서 같은 로직이 실제로 반복된다.
  3. 외부 시스템 경계를 격리해야 하는 명확한 장애 또는 보안 이유가 있다.
  4. 사용자가 해당 추상화 또는 공통화를 명시적으로 요청했다.

- 테스트 편의를 이유로 production 추상화를 추가하지 않는다. 테스트에서는 `monkeypatch`,
  `AsyncMock` 또는 구체 클래스의 테스트 대역을 우선한다.

### 현재 제품 정책

- OpenAI 사용은 필수다. 다른 LLM provider 선택 기능이나 규칙 기반 fallback을 추가하지 않는다.
- 장애를 정상 응답으로 숨기는 fallback을 만들지 않는다. 장애는 명시적인 오류로 반환한다.
- 여러 Agent를 추가하더라도 Agent별 역할이 실제로 나뉘기 전에는 오케스트레이터, handoff,
  graph 또는 범용 Agent 프레임워크 계층을 추가하지 않는다.

### 변경 범위와 검증

- 요청 범위 밖의 패턴 통일, 파일 재배치 또는 미래 대비 리팩터링을 하지 않는다.
- 새로운 production 의존성, 외부 서비스 또는 실행 계층을 추가하기 전에 사용자에게 알린다.
- 호출 흐름을 추가하거나 변경했다면 실제로 거치는 구성 요소를 간단히 설명한다. 예를 들어 답변
  생성은 `HTTP API → Service → Agent → OpenAI → Response`로 설명하되, 색인·임베딩 등 다른
  경로를 이 형식에 억지로 맞추거나 설명을 위해 계층을 추가하지 않는다.
- 테스트는 아래 `변경 범위별 검증`을 따른다.

## Core API 구조 및 명명 규칙

### 기능 중심 배치

- Kotlin 기본 패키지는 `ai.govbiz.core`이며 실제 디렉터리와 `package` 선언을 항상 일치시킨다.
- 업무 코드는 기능 디렉터리에 둔다. 외부 HTTP 호출은 `Controller → Service → [Facade] → Client`,
  관계형 DB 접근은 아래 영속성 규칙을 따른다. 대괄호는 필요한 경우에만 사용하는 계층이다.
- 프레임워크와 무관한 업무 모델과 순수한 업무 규칙은 `domain`에 둔다.
  `data class`인지 `object`인지보다 책임과 의존성으로 위치를 판단한다.
- `supportprogram`은 실제 지원사업 기능, `_health`와 `_health_ai_service`는 상태 확인 기능,
  `_sampleitem`은 계층 학습 예제, `_common`은 둘 이상의 기능이 실제로 공유하는 코드다.
- 공개 HTTP 계약은 해당 기능의 `controller/dto`, 외부 시스템 계약은 `client/dto`, 검증된 내부
  실행 결과는 `service/dto`, 프레임워크와 무관한 업무 모델은 `domain`에 둔다.
- 외부 DTO를 내부 모델로 변환하는 Mapper는 해당 외부 시스템의 `client/mapper`에 둔다.
- 외부 시스템에서만 사용하는 예외는 해당 시스템의 `client/exception`에 둔다.
- DTO, 예외, 설정을 프로젝트 전체의 중앙 폴더에 모으지 않고 그 계약을 소유하는 기능 가까이에 둔다.

### 역할별 이름

- 공개 HTTP 진입점은 `Controller`, 업무 흐름은 `Service`, 외부 HTTP 통신은 `Client`로 끝낸다.
- 하위 Client 호출·응답 검증·도메인 변환을 하나의 진입점으로 감추는 객체는 `Facade`로 끝낸다.
- 외부 DTO 변환은 `Mapper`, Spring 구성은 `Config`, 환경설정 값은 `Properties`로 끝낸다.
- 전송 객체는 경계에 맞춰 `Request`, `Response`, `Payload`, `Result`를 사용한다. 필드가 같다는
  이유만으로 서로 다른 경계의 타입을 합치지 않는다.
- 이름은 수행 역할을 드러내야 하며 `Support`, `Util`, `Common`처럼 의미가 모호한 접미사를
  새로 만들지 않는다.

### Helper 규칙

- 다른 코드의 반복 작업을 보조하는 파일과 `object`·클래스 이름은 `Helper`로 끝낸다.
- 둘 이상의 기능이 실제로 함께 사용하는 Helper는 `_common/helper`에 둔다.
- 특정 기능이나 외부 시스템만 사용하는 Helper는 해당 기능의 `helper` 디렉터리에 둔다.
  예: `supportprogram/client/bizinfo/helper`.
- Helper 함수 이름은 `executeHttpCall`, `buildRestClient`, `decode`처럼 동작을 나타내며
  함수 이름에 `Helper`를 반복하지 않는다.
- `Controller`, `Service`, `Facade`, `Client`, `Mapper`처럼 더 정확한 역할명이 있으면 Helper로
  분류하지 않는다.
- 실제 사용처가 하나뿐이고 호출부 안에 두는 편이 더 명확한 작은 함수는 불필요하게 별도
  Helper 파일로 추출하지 않는다.

### MySQL 및 MyBatis 영속성 규칙

- 관계형 데이터베이스 접근의 기본 흐름은
  `Controller → Service → Repository → MyBatis Mapper → Mapper XML → MySQL`이다.
  Controller, Facade, Client, Domain은 MyBatis Mapper를 직접 호출하지 않는다.
- 관계형 DB 접근 코드는 해당 기능의 `repository`에 둔다. 단순히 DB를 사용한다는 이유만으로 별도
  DAO 계층, Repository interface, 범용 BaseRepository를 추가하지 않는다.
- MyBatis SQL 실행 계약과 DB 행 타입은 해당 기능의 `repository/mapper`에 둔다. SQL 실행
  interface는 `Mapper`, DB 행 클래스는 `DbRow`로 끝낸다.
- `DbRow`는 MyBatis가 DB 한 행을 읽고 쓰기 위한 경계 타입이다. MyBatis 객체 생성에 필요한
  기본값과 `var`를 사용할 수 있지만 Domain의 Value Object, JPA Entity, 공개 DTO로 취급하지 않고
  Repository 밖으로 노출하지 않는다.
- Repository는 Domain과 `DbRow` 사이의 변환 및 JSON 같은 DB 표현의 직렬화·역직렬화를 담당한다.
  Domain에는 MyBatis annotation이나 DB 컬럼 매핑 세부사항을 넣지 않는다.
- MyBatis Mapper는 `DbRow`, 원시 값, 영향받은 행 수처럼 SQL 실행에 필요한 값만 입출력한다.
  접수 상태 계산이나 외부 응답 정규화 같은 업무 로직을 Mapper 또는 Mapper XML에 넣지 않는다.
- 실제 SQL은 `src/main/resources/mybatis/{기능}/repository` 아래 Mapper와 같은 이름의 XML에 둔다.
  production 영속성 코드에서 같은 기능에 JPA, `JdbcClient`, annotation SQL을 함께 사용하지 않는다.
  다른 방식이 꼭 필요하면 역할과 트랜잭션 경계를 먼저 설명하고 사용자에게 알린다.
- Mapper XML의 `namespace`는 Mapper interface의 전체 이름과, statement `id`는 interface 메서드명과
  일치시킨다. 조회 컬럼과 `resultMap`은 명시하고 `SELECT *`를 사용하지 않는다.
- SQL 값은 `#{...}`로 바인딩한다. 검증된 식별자를 동적으로 조립해야 하는 명확한 이유가 없다면
  문자열을 그대로 치환하는 `${...}`를 사용하지 않는다.
- 지원사업 원본 식별자는 `(source_code, source_program_id)` 조합으로 다룬다. 서로 다른 제공처의
  원본 ID가 전역에서 유일하다고 가정하지 않는다.
- 날짜가 지나면서 바뀌는 접수 상태는 DB에 고정해 저장하지 않고, 저장된 신청 기간과 서울 기준
  현재 날짜를 사용해 Domain 규칙으로 다시 계산한다.

### 스키마와 데이터 동기화 규칙

- MySQL 스키마 변경은 `src/main/resources/db/migration`의 Flyway migration으로만 관리한다.
  이미 적용될 수 있는 migration은 수정하거나 삭제하지 않고 다음 버전의
  `V{번호}__{설명}.sql`을 추가한다.
- migration과 SQL은 production과 같은 MySQL 8.4 문법을 기준으로 작성하고, 한글 데이터는
  `utf8mb4` 문자 집합을 유지한다.
- 고유성이나 참조 무결성처럼 반드시 지켜야 하는 조건은 애플리케이션 검사에만 의존하지 않고
  DB constraint로도 보장한다.
- 운영 데이터를 삭제하거나 되돌리기 어려운 migration은 정확한 대상과 복구 방법을 확인하고
  사용자의 명시적인 승인 없이 추가하거나 적용하지 않는다.
- DB 비밀번호와 운영 연결 정보는 코드나 migration에 넣지 않고 환경변수 또는 secret으로 주입한다.
- 외부 API 호출을 DB transaction 안에서 수행하지 않는다. 전체 데이터를 먼저 수집하고 검증한 뒤,
  DB 반영만 하나의 짧은 transaction으로 처리한다.
- 하나의 Repository 안에서 여러 SQL을 묶는 transaction은 Repository의 공개 메서드가 소유할 수 있다.
  여러 Repository의 쓰기를 묶는 업무 transaction은 Service가 소유하며 Mapper는 경계를 만들지 않는다.
- 외부 데이터 동기화는 같은 입력을 반복해도 결과가 같도록 UPSERT 기반으로 구현한다. 신규·변경
  데이터 저장과 사라진 데이터의 비활성화는 제공처별로 하나의 transaction에서 처리한다.
- 저장·갱신·비활성화 범위는 항상 `source_code`로 제한한다. 한 제공처의 동기화 실패나 누락이
  다른 제공처의 데이터에 영향을 주면 안 된다.
- 외부 API 오류, 일부 페이지 실패, 응답 검증 실패처럼 전체 수집 성공을 확인할 수 없는 경우에는
  기존 데이터를 비활성화하거나 삭제하지 않는다.
- 제공처가 알린 전체 건수와 실제 수집 건수가 다르거나 페이지 완전성을 확인할 수 없는 경우도
  전체 수집 실패로 취급하고 기존 데이터를 유지한다.

### 데이터베이스 검증

- Flyway migration, MyBatis Mapper XML 또는 Repository 변경 시(실행에 영향 없는 문서·주석 제외)
  실제 MySQL 8.4 Testcontainers 통합 테스트를 실행한다. MySQL 전용 JSON, UPSERT, 날짜,
  문자 정렬 동작을 H2로 대체하지 않는다. 이미 적용될 수 있는 migration의 수정 금지는 그대로 적용한다.
- Repository 통합 테스트는 변경 범위에 맞춰 한글·특수문자, JSON 배열, nullable 날짜, 복합 식별자,
  UPSERT와 transaction rollback을 검증한다.
- 동기화 기능을 변경하면 동일 데이터 재수집, 누락 공고 비활성화, 중간 실패 시 기존 데이터 보존을
  실제 MySQL 통합 테스트로 확인한다.
- Testcontainers 공통 설정은 테스트 전용 `_common/test`에 두고 production 코드나 설정에 포함하지 않는다.

### 의존 방향과 변경 원칙

- Controller는 Facade나 Client를 직접 호출하지 않고 사용자 유스케이스를 담당하는 Service만 호출한다.
- Service는 필요한 Repository를 직접 사용하며, 외부 하위 시스템의 호출·검증·변환이
  복잡할 때만 Facade를 사용한다. 단순 외부 호출은 Service에서 Client를 직접 사용하고,
  한 줄 전달만 하는 Facade는 만들지 않는다.
- Facade는 상위 Service를 다시 호출하지 않는다. `Service ↔ Facade` 순환 의존성은 금지한다.
- 외부 시스템의 원본 JSON과 예외를 공개 API에 그대로 노출하지 않는다. Client 경계에서 DTO와
  안정적인 내부 예외로 변환한다.
- 새로운 공통 추상화는 production 사용처가 둘 이상이거나 외부 시스템 장애·보안 경계를
  격리해야 할 때만 추가한다.
- 구조·이름·공개 계약·실행 방법이 바뀌면 `backend/core-service/README.md`와 `docs/architecture.md`에서
  영향을 받는 설명을 확인하고 갱신한다. 문서에 영향을 주지 않는 내부 변경만으로 두 문서를
  형식적으로 수정하거나 동일한 작업 기록을 반복 추가하지 않는다.

### 검증

- 테스트 패키지는 production 패키지 구조를 따라 배치한다.
- 파일 이동 후에는 이전 package·import·문서 경로가 남지 않았는지 `rg`로 확인한다.
- 테스트 실행 범위와 명령은 아래를 따른다.

## 변경 범위별 검증

- 개발 중에는 관련 테스트로 빠르게 확인하고, 마무리 전에 변경된 최신 코드에 대해 아래 필수 검증을
  완료한다. 통과 이후 관련 코드·설정·테스트가 다시 바뀌거나 실패·미해결 우려가 생기지 않았다면
  같은 전체 테스트를 반복하지 않는다. 커밋 메시지나 작업 요약 작성만으로 다시 실행하지 않는다.
- 문서·주석만 바뀌고 실행 동작에 영향이 없다면 경로·링크·설명과 `git diff --check`를 확인한다.
  전체 애플리케이션 테스트는 필요 없다. 실행 설정·의존성·프롬프트 변경은 문서 변경으로 취급하지 않는다.
- Core API 코드·실행 설정·의존성·테스트 변경: JDK 21 환경에서 `backend/core-service`를 작업 디렉터리로
  `./gradlew test --no-daemon`을 실행한다. 파일 이동·삭제, 빌드·리소스 처리 변경 또는 오래된 산출물
  의심이 있으면 `./gradlew clean test --no-daemon`을 사용한다. 위 MySQL 통합 테스트 요구는 유지한다.
- AI Service 코드·실행 설정·의존성·프롬프트·테스트 변경: `backend/ai-service`에서
  `uv run --locked --extra dev python -m pytest`로 AI Service 전체 테스트를 실행한다.
- Frontend 코드·설정·의존성·테스트 변경: `frontend/web/package.json`의 Node.js·pnpm 버전에 맞춰
  `frontend/web`에서 `pnpm test`, `pnpm lint`, `pnpm build`를 실행한다.
- Node 의존성은 저장소 루트에서 `pnpm install --frozen-lockfile`로 설치하며 루트 잠금 파일만 관리한다.
- Mobile 코드·설정·의존성·테스트 변경: `frontend/mobile`에서 `pnpm test`, `pnpm typecheck`, `pnpm lint`,
  `pnpm export`를 실행한다. export는 iOS·Android JS 번들 검증이며 실제 기기 실행이나 스토어 빌드로 보고하지 않는다.
- 공통 `frontend/packages/shared` 변경: 해당 패키지의 `pnpm typecheck`, `pnpm test`, `pnpm lint`와 웹·앱 검증을
  함께 실행한다. 공통 업무 계약·DTO 구현은 shared에서 수정하고 frontend의 재수출 파일에 복제하지 않는다.
- 평가 도구 변경: 해당 평가 디렉터리의 README와 `.github/workflows/ci.yml`에 있는 관련 검증을
  실행한다. 검색 평가와 근거 답변 평가는 각각의 실행 환경에서 별도 프로세스로 실행한다.
- 서비스 사이의 공개 계약을 바꾸면 응답 생산자와 소비자 양쪽을 검증한다. 의존성·Docker·Compose·CI
  변경은 위 테스트에 더해 `.github/workflows/ci.yml`의 해당 잠금 파일·빌드·통합 검증을 확인해 실행한다.
  CI의 clean build 요구를 로컬의 증분 테스트로 대체하지 않는다.
- 최종 변경에 `git diff --check`를 실행한다. 테스트를 실행하지 못했거나 통합 테스트가 건너뛰어진
  경우에는 이유와 미검증 범위를 명시한다. 실패를 숨기거나 관련 없는 기존 변경을 되돌리지 않는다.
- 자동 테스트·스텁 검증 통과를 실제 검색·RAG 품질 측정 완료로 표현하지 않는다. 유료 API 평가는
  사용자가 승인한 전송 데이터와 호출 예산 안에서만 실행하고, 추가 승인이 필요하면 무료 검증을 먼저
  마친다. AI 판정 결과를 사람이 검토한 정답으로 표시하지 않는다.
