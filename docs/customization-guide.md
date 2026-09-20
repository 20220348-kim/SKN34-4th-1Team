# GovBiz 확장·적용 안내

GovBiz는 기업마당 공고를 MySQL 카탈로그로 동기화해 검색하는 기능을 시작점으로, 추가 데이터 소스와
기업 맞춤 추천을 단계적으로 연결하도록 구성했습니다. 다른 지원사업 데이터 소스나 유사한 공공 정보
서비스에 적용할 때도 계층의 책임은 유지하고 도메인 계약과 adapter를 기능 단위로 교체합니다.
이 문서는 확장 시 지킬 기준이며, 아래의 추가 데이터 소스·큐·worker가 이미 구현되었다는 뜻은 아닙니다.
현재 범위는 [구현 현황](implementation-status.md), 기술 구성은 [프로젝트 기술 문서](technology.md)를
참고하세요.

## 1. GovBiz 브랜드와 서비스 계약 확정

서비스명, 표시 문구, 공개 URL, API 오류 URN과 Health service 값은 배포 전에 하나의 규칙으로
확정합니다. 사용자에게 노출되는 이름과 서비스 간 계약에 쓰이는 식별자를 혼용하지 않습니다.

다음 위치는 같은 변경에서 함께 검토합니다.

- 루트·서비스별 README와 브라우저 metadata
- Frontend 화면의 브랜드·공고 출처·조회 상태 표시
- Core API와 AI Service의 Health 응답·예상 값
- `application/problem+json` type URN과 서비스 간 DTO
- Docker Compose project·service·container 이름과 smoke 검증 스크립트

## 2. 실제 공고 데이터 소스 확장

현재 채팅 화면은 `SupportProgramRepository`를 통해 Core API를 호출하고, Core API는 MySQL의 현재 공개
공고 카탈로그를 검색합니다. 현재 수집 Client·동기화는 기업마당 전용이며, 기업마당 API 호출·검증·정규화는
백그라운드 동기화가 담당합니다. 다른 공식 소스를 추가할 때도 화면과 UseCase의 공개 계약은 유지하고 Core API
뒤의 adapter와 병합 정책을 확장합니다.

권장 순서:

1. 새 소스가 해결할 검색 누락 사례와 품질 기준을 먼저 기록합니다.
2. 외부 응답·오류·timeout을 소스별 client 경계에서 처리합니다.
3. 원문 ID, 출처와 날짜 근거를 잃지 않고 GovBiz 공고 모델로 변환합니다. 원본 식별자는
   `(source_code, source_program_id)` 조합으로 유지합니다.
4. 수집 완전성, 소스별 UPSERT·비활성화, 벡터 준비 후 MySQL 공개와 동기화 실행 순서 보호를
   새 소스에도 적용합니다. 검색·색인 내부 식별자는 제공처를 포함하지만, 현재 수집 구현은 기업마당 전용이므로
   설정값 추가만으로 새 소스가 동작하지 않습니다.
5. 여러 소스에 같은 공고가 있을 때의 중복 판정, 소스 우선순위와 정렬 규칙을 명시합니다.
6. 동일한 검색 시나리오를 고정 fixture·HTTP 계약 테스트, 실제 MySQL 통합 테스트와 Compose smoke로 검증합니다.

현재 Frontend의 공고 URL 검증은 기업마당 도메인만 허용합니다. 소스를 늘릴 때는 Core API의
소스별 조회·변환뿐 아니라 Frontend의 출처 URL 검증과 화면 표시도 함께 확장해야 합니다.

## 3. SampleItem 계층 패턴 재사용

SampleItem은 실제 GovBiz 도메인이 아니라 Frontend와 Core API 계층을 연결하는 최소 패턴 예제입니다.
새 기능에서는 파일을 이름만 바꿔 복사하지 말고, 필요한 상태와 계약을 먼저 정의합니다.

```text
Frontend
  앱 조립: Awilix → 전역 appContainer Service Locator
  채팅: View → 페이지 ViewModel → 내부 채팅 Hook이 UseCase resolve → Thunk → UseCase → Repository
  단순 요청 A: View → ViewModel local state → UseCase → Repository
  단순 요청 B: View → Redux ViewModel Thunk → 같은 UseCase → Repository
                                  └→ 요청·성공·실패 action → slice

Core API
  Controller → Service → Domain
```

폼 입력과 한 번의 요청으로 끝나는 기능은 SampleItem의 Hook 버전처럼 React Hook Form과 ViewModel의
로컬 요청 상태로 구성할 수 있습니다. 화면을 이동해도 입력·결과를 유지하거나 여러 컴포넌트가
공유해야 하면 Redux 버전처럼 ViewModel Thunk가 이미 resolve한 UseCase를 호출하고 Slice가 상태를
보관합니다. 두 경우 모두 실제
Repository는 ViewModel이나 내부 Hook이 생성하거나 resolve하지 않고 UseCase 뒤에 둡니다. 테스트는
전역 컨테이너를 바꾸지 않고 UseCase를 조회하는 ViewModel 또는 내부 Hook의 선택적 인자에 plain Fake UseCase를 넣습니다.

두 SampleItem 화면은 같은 mapper·UseCase·Repository·HTTP 계약을 공유합니다. Redux Store에는
AbortController, Promise, Error나 UseCase 인스턴스를 넣지 않고 직렬화 가능한 폼 값, status, request ID,
안전한 오류 문자열과 성공 결과만 저장합니다.

Awilix 등록과 조립은 `app/di`에 두고, `app/appContainer.ts`가 GetIt 같은 단일 Service Locator를
공개합니다. ViewModel 또는 내부 Hook은 UseCase·외부 함수만 조회하고 Domain은 컨테이너를 알지 못합니다. 새 구현체는
최초 resolve 전에 역할에 맞는 등록 모듈에 추가합니다. 테스트에서 운영 컨테이너를 변경하지 말고 각
테스트용 새 컨테이너나 plain Fake UseCase를 사용합니다.

## 4. 저장과 비동기 처리 확장 기준

공고 카탈로그는 이미 MySQL·MyBatis·Flyway로 저장하며, 벡터는 Qdrant에 저장합니다. 기업마당 동기화와
누락 벡터 복구도 현재 Core API의 스케줄러가 실행합니다. SampleItem은 의도적으로 비영속이며,
채팅 메시지는 브라우저 Redux 메모리에만 있습니다.

전체 대화 이력이나 사용자별 기업 정보를 추가한다면 해당 기능의 Repository와 새 Flyway migration을
추가합니다. 적용될 수 있는 기존 migration은 수정하지 않습니다. 현재 스케줄러만으로 처리하기
어려운 작업량·재시도·상태 조회 요구가 확인되면 큐와 worker를 검토합니다. PDF 분석, 큐, 별도
worker는 현재 구현되어 있지 않습니다.

## 5. 검증 순서

기능을 확장한 뒤에는 변경한 계약에서 시작해 전체 서비스 흐름으로 넓혀 갑니다.
아래 명령은 저장소 루트에서 시작합니다. Node.js 24·pnpm 11.22, JDK 21, Python 3.11·uv와
실행 중인 Docker가 필요합니다. Core API 통합 테스트는 실제 MySQL 8.4 Testcontainers를 사용합니다.

```bash
cd frontend/web && pnpm test && pnpm lint && pnpm build
cd ../backend/core-service && ./gradlew clean test --no-daemon
cd ../ai-service && uv lock --check && uv run --locked --extra dev python -m pytest
cd ../.. && ./infrastructure/scripts/verify-compose.sh
```

Docker Compose smoke는 Web 프록시 → Core API → MySQL → AI Service → Qdrant의 HTTP 흐름과
Qdrant·AI Service 장애·복구를 검증합니다. 브라우저 클릭을 수행하는 E2E 테스트는 아닙니다.
공공데이터포털·OpenAI 호출은 검증 profile의 로컬 스텁으로 대체하므로 실제 API 키나 모델 호출
비용은 필요하지 않습니다. 다만 최초 이미지·의존성 다운로드에는 네트워크가 필요합니다.
외부 데이터 소스를 추가할 때도 고정 fixture나 mock server로 재현 가능한 시나리오를 먼저 추가합니다.
