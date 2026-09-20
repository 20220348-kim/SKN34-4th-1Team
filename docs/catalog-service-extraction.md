# 공고 카탈로그 서비스 분리

## 범위와 전환 상태

첫 업무 분리 대상은 공고 수집·정규화·게시·검색 색인 관리다. 독립 실행 코드는
`backend/catalog-service/`에 있으며 별도 Spring Boot 이미지와 MySQL DB를 사용한다.
계정·기업·관심 공고·파트너·신청 준비·중복 검토·리포트는 Core에 남긴다.

루트 `compose.yaml`은 **Catalog 분리 경로를 기본으로 실행**한다. 현재 AWS 서버·RDS·ECR·Vercel·SSM 배포는
변경하지 않는다. `infrastructure/compose.yaml` 단독 실행과 운영 배포의 embedded 경로는 데이터 이전 전까지 유지한다.
Core에 남은 기존 수집 구현은 전환 호환 코드이며, 중복 구현을 영구 구조로 삼지 않는다.
운영 전환·데이터 대조·복구 검증을 마친 뒤 별도 변경에서 제거한다.

모든 Core 업무를 분리하거나 Catalog의 운영 Kubernetes 배포를 완료했다는 뜻은 아니다.
기존 Ops kind 검증과 이 문서의 Catalog 분리 검증은 다른 범위다.

## 코드·데이터 소유권

| 구성 요소 | 책임 |
| --- | --- |
| Catalog 서비스 | 네 제공처 수집·완전성 검증, 카탈로그 원본, 수집 세대·색인 상태, Elasticsearch·AI 벡터 색인 요청 |
| Catalog DB | 공고 원본·동기화 상태, DB instance UUID와 제공처별 단조 증가 revision. Core 계정·신청 테이블 없음 |
| Core 서비스 | 공개 API·인증·사용자 업무와 AI 검색 조합. Catalog API로 받은 완전한 snapshot을 검증 |
| Core DB | 사용자 데이터 및 Core 소유 공고 읽기 projection. 기존 숫자 ID·외래 키를 유지 |
| AI 서비스 | 임베딩·추론·Qdrant 실행. Catalog가 원본을 게시하기 전 색인 성공 여부를 확인 |

Core는 Catalog DB 계정·접속 주소를 받지 않으며 Catalog도 Core DB에 접속하지 않는다.
물리적으로도 검증 시 두 MySQL 컨테이너와 서로 다른 DB·계정·비밀번호를 사용한다.
현재 Core의 공식 HTML·첨부·문서 분석 캐시는 사용자 유스케이스의 일부로 Core에 남긴다.
Catalog의 DB 숫자 ID는 다른 서비스에 전달하지 않고 `(source_code, source_program_id)`를 사용한다.

## 호출 흐름

1. 제공처 API → Catalog Client·Facade → 완전한 source snapshot 검증.
2. Catalog → Elasticsearch 및 AI 색인 → Catalog DB에 검증된 snapshot 게시.
3. Core의 `CatalogProjectionScheduler → Service → CatalogSnapshotClient`가 내부 HTTP로 snapshot 수신.
4. 모든 네트워크 수신을 마친 뒤 Core의 `CatalogProjectionService`가 짧은 transaction을 시작하고,
   `CatalogProjectionRepository → MyBatis → Core DB`로 source 단위 projection·신청서 분석 등록·checkpoint를 함께 반영.
   여러 Repository 쓰기를 묶는 업무 transaction의 시작·완료는 Service가 소유한다.
5. 기존 공개 목록·상세·관심 공고·파트너 기능은 같은 Core projection을 읽음.

공개 API를 Catalog 최신값으로 바로 돌리지 않는 이유는 새 공고가 화면에 보이지만 아직 Core에 없어
관심 저장·모집글 등록이 실패하는 시간차를 피하기 위해서다. public URL·DTO·페이지 계약은 유지한다.
복제 지연은 존재한다. Catalog 장애 시 이미 반영한 목록은 유지하며 갱신 성공으로 표시하지 않고
`catalog_projection ... outcome=retained_previous` 로그에 실패 종류를 남긴다.

## 내부 HTTP 계약

`GET /internal/v1/catalog/snapshots/{sourceCode}`는 `Authorization: Bearer <CATALOG_INTERNAL_TOKEN>`을
요구한다. 토큰은 서버에만 주입하며 사용자 JWT·Vercel 공개 환경변수로 재사용하지 않는다.
32–1024자의 공백 없는 ASCII 비밀을 사용하고 로그·응답·Git에 실제 값을 남기지 않는다.

응답 필드:

- `schemaVersion=1`
- `catalogId`: Catalog DB 인스턴스의 영속 UUID
- `revision`: 해당 source의 공고 또는 동기화 상태 변경 때 증가하는 버전
- `status`: source, 공개 generation·건수·지문·색인 준비 상태·성공/실패 시각
- `programs`: 해당 source의 완전한 현재 공고 목록. 최대 20,000개

양쪽 HTTP DTO는 Domain과 별도로 정의한다. `programs[].program`에는 식별자·제목·기관·본문·
분류·지역·대상·신청 기간·날짜·접수 상태·출처 이름·URL을 명시적으로 담고,
`sortTimestamp`와 `startupDetails`를 함께 전송한다. 검색 추천 이유·점수·자격 검토와
계산 getter는 이 계약에 포함하지 않는다. Core의 Client Mapper에서 업무 모델로 변환한다.

아직 게시하지 않은 새 DB를 정상 0건 snapshot으로 보내지 않는다. 정상 게시가 없는 source는
503이며 Core 데이터를 비활성화하지 않는다. 검증된 **게시된 0건 snapshot**은 해당 source만
비활성화할 수 있다. 다른 source나 사용자 데이터는 변경하지 않는다.

Core는 프로토콜 버전·source·건수·중복·지문·UUID·revision을 검사한다. HTTP 실패·잘린 JSON·
64MiB 초과 응답은 반영하지 않는다. 이전 revision은 무시하고, 같은 revision의 내용 변경과
공개 generation 역전, 다른 Catalog UUID는 거절한다. 날짜가 지나며 계산되는 접수 상태는
고정하지 않으며 기존처럼 서울 날짜와 신청 기간으로 다시 계산한다.
nullable 필드도 응답의 키는 필수다. 명시적인 `null`과 키 누락을 구분하고, 숫자·boolean 필드의
누락이나 `null`을 기본값으로 바꾸어 수용하지 않는다.

revision은 generation과 다르다. 같은 공개 공고에서 `indexReady` 또는 최근 실패 상태만
바뀌어도 반영해야 하므로 수집 generation만으로 중복 수신을 판단하지 않는다.

## 실행 모드와 데이터 보존

- `CATALOG_PROJECTION_ENABLED=false`(기본): 기존 배포와의 전환 호환 경로.
- `true`: Core의 네 source 수집 Service·Scheduler, 색인 writer·Scheduler, 일회성 수집 경로를
  Spring 조립 단계에서 제외한다. 기존 수집 플래그를 true로 줘도 원본 writer가 함께 뜨지 않는다.
- 원격 snapshot을 한 번 반영한 Core DB는 플래그만 false로 되돌릴 수 없다.
  `CatalogOwnershipGuard`가 예약 작업 시작 전에 기동을 거절한다. 데이터 소유권 복구는 별도 이전 작업이다.

Core의 과거 Flyway V1–V40과 기존 테이블·외래 키는 수정하거나 삭제하지 않는다.
V41은 projection checkpoint만 추가한다. Catalog는 별도 DB에서 자기 Flyway 이력을 시작한다.
원격 main에 먼저 반영된 모바일 OAuth의 V40을 유지하고, 아직 배포하지 않은 Catalog migration만
V41로 배정하여 번호 충돌을 피했다.
Flyway를 끄는 기존 Core 일회성 수집·평가 실행도 새 바이너리를 쓰기 전 V41 적용이 필요하다.
소유권 검사에서 DB 오류를 무시하거나 checkpoint 테이블이 없다는 이유로 수집을 허용하지 않는다.
Core V1의 숫자 PK를 Catalog 숫자 PK로 대체하거나 기존 `support_program`을 DROP/TRUNCATE하지 않는다.
원격 Catalog DB를 초기화하거나 바꾼 경우 UUID가 달라지므로 자동 덮어쓰지 않고 수동 대조·승인을 요구한다.

## 무료 격리 검증

저장소 루트에서 Docker Engine과 Python 3.11 이상을 사용할 수 있어야 한다. 소수초 자릿수가
달라지는 ISO 날짜 비교를 사용하므로 macOS 기본 Python 3.9가 아닌 버전을 선택한다.
아래 도구는 실제 `.env`를
읽지 않고 임시 fixture 설정·새 Compose 프로젝트·전용 볼륨을 만든다. 공공 API와 OpenAI는
로컬 스텁만 호출하며, 기존 컨테이너·AWS·운영 DB를 변경하지 않는다.

```bash
python3 -B infrastructure/scripts/verify-catalog-separation.py --config-only
python3 -B infrastructure/scripts/verify-catalog-separation.py
```

두 번째 명령은 이미지를 빌드하고 실제 MySQL·Elasticsearch·Qdrant·Core·Catalog·AI를 실행한다.
공식 이미지·패키지 다운로드와 로컬 CPU·메모리가 필요하다. 자신의 임시 프로젝트만 정리한다.
`--config-only`는 실제 HTTP·DB 검증을 대신하지 않는다.
Compose BuildKit이 두 JVM 빌드의 Gradle 캐시를 동시에 잠그지 않도록 필요한 서비스의 이미지를
개별 `build` 호출로 직렬 빌드하고, 모두 완료된 뒤 `up --no-build`로 실행한다.

각 JVM 서비스의 전체 검증은 JDK 21에서 해당 디렉터리의 `./gradlew clean build --no-daemon`이다.
Catalog CI는 새 서비스 테스트와 위 격리 통합 검증을 수행한다. Core 전체 테스트는 기존 CI를 유지한다.
아래 결과는 실제 실행한 범위만 기록하며, 스텁 통과를 실제 AI 품질로 표현하지 않는다.

### 2026-09-19 검증 기록

- 최신 main의 모바일 변경을 통합한 Core: `clean build` 성공. 166개 suite, 1,512개 테스트,
  실패·오류·건너뜀 0. 신규 Catalog 경계 테스트 29개, 모바일 인증 회귀 검증,
  실제 MySQL 8.4에서 V1–V41 적용을 포함한다. 통합 후 전체 재검증은 21분 23초에 완료했다.
- Catalog: `clean build` 성공. 34개 suite, 286개 테스트, 실패·오류·건너뜀 0.
  실제 MySQL 8.4와 독립 V1, Elasticsearch 9.5.3 + Nori 통합 테스트를 포함한다.
- 실제 Docker 통합 검증 성공: 서버 토큰 누락·불일치 거부, 네 제공처 공고 42건
  (기업마당 27·K-Startup 2·MSIT 11·충남 2), Catalog 전용 테이블 5개와 Flyway 이력,
  Core의 checkpoint 4개·동일 공고 건수 및 공개 검색을 확인했다.
  제공처 중단 후 원본·지문 보존과 새 실패 revision·상태의 Core 반영을 확인했고,
  Catalog 중단 후에도 Core가 네 제공처 polling 실패를 기록하며 목록·검색을 유지했다.
  검색은 실제 Elasticsearch·Qdrant와 로컬 OpenAI 대역을 사용했다.
  최신 main의 모바일 변경 및 Core V41을 통합한 이미지로도 같은 전체 시나리오를 재실행해 통과했다.
  임시 컨테이너 13개·볼륨 6개·네트워크 1개를 정리했으며 기존 개발 컨테이너 7개는 그대로 유지했다.
- Compose 정적 검사, 분리 overlay의 `--config-only`, 기존 CodeBuild 스크립트 21개 테스트 통과.
  infrastructure 스크립트 83개 테스트 중 16개는 기존 데모 시드 MySQL 검증의 명시적 opt-in이
  없어 건너뛰었다. 변경한 Catalog/Core의 MySQL 통합 테스트는 건너뛰지 않았다.

16GB 개발 장비에서는 두 JVM 전체 검증을 동시에 실행했을 때 컴파일러 메모리 부족과
Elasticsearch 기동 시간 초과가 발생했다. 제한 시간을 늘려 숨기지 않고, 서비스별 직렬 실행과
독립 컴파일러 heap으로 위 최종 전체 검증을 완료했다. 각 서비스 디렉터리에서 사용한 명령은 다음과 같다.

```bash
JAVA_TOOL_OPTIONS='-Dspring.test.context.cache.maxSize=2' \
  ./gradlew clean build --no-daemon --max-workers=2 \
  -Pkotlin.compiler.execution.strategy=in-process \
  -Dorg.gradle.jvmargs='-Xmx2g -XX:MaxMetaspaceSize=512m'
```

`JAVA_HOME`은 JDK 21을 가리켜야 한다. 이 검증은 실제 공공 API 수집·유료 AI 품질 평가나
AWS 배포 검증을 의미하지 않는다.
Docker 통합 검증도 첫 병렬 빌드에서는 공유 Gradle 캐시 잠금 충돌이 발생했다.
이미지별 별도 빌드 호출로 수정한 뒤 이미지 빌드·통합 검증·정리까지 약 21분에 성공했다.
첫 시도에서 받은 일부 base·Gradle 캐시를 재사용한 로컬 측정값이며, 완전 무캐시 CI runner의
실행 시간이나 현재 CI 제한 30분 이내 완료를 보장하지 않는다.

## 실제 개발용 선택 실행

새 로컬 통합 환경은 루트 `compose.yaml`에서 Catalog overlay를 자동 병합한다.
`GOVBIZ_APP_ENV_FILE`(기본 `.env`)에 서버 전용 `CATALOG_INTERNAL_TOKEN`을 32자 이상 설정한다.
토큰 누락 시 Compose 렌더링부터 실패하며 공개/기본 토큰으로 대체하지 않는다.
기존 Core DB가 있다면 볼륨을 지우거나 바로 재기동하지 않고 아래 전환 조건을 먼저 확인한다.
Core의 원본 writer는 비활성화되지만, Catalog 수집 활성화는 source별 명시적 설정이 필요하다.
기존 볼륨 overlay `compose.existing-data.yaml`은 전환 검토 없이 실행되지 않는다.
백업·데이터 대조·단일 쓰기 주체 전환 계획을 확인한 뒤에만 `.env.compose`에
`GOVBIZ_CATALOG_TRANSITION_REVIEWED=1`을 설정한다. 이 확인값은 실제 데이터 이전을 수행하지 않는다.

`infrastructure/compose.yaml` 뒤에 `infrastructure/compose.catalog.yaml`을 겹쳐 사용한다.
이 overlay는 기존 `infrastructure/compose.prod.yaml`용이 아니다. 루트 Ops 통합 Compose에
경로 확인 없이 섞지 않는다. 기존 개발 볼륨과 다른 명시적 프로젝트를 사용해 먼저 검증한다.

필요한 값은 별도 로컬 환경 파일에 준비한다. 기존 `.env`를 덮어쓰지 않는다.

| 설정 | 용도 |
| --- | --- |
| `CATALOG_INTERNAL_TOKEN` | Catalog와 Core의 서버 간 비밀값 |
| `CATALOG_MYSQL_DATABASE/USER/PASSWORD/ROOT_PASSWORD` | Catalog 전용 DB; Core 값 재사용 금지 |
| `CATALOG_SERVICE_URL` | Core가 사용하는 Catalog origin; overlay는 내부 DNS 주소로 고정 |
| `CATALOG_SOURCES` | Core가 동기화할 source 목록; 직접 실행 기본 네 source |
| `CATALOG_PROJECTION_INITIAL_DELAY/FIXED_DELAY` | Core 수신 주기; source 수집·임베딩 주기와 별개 |
| 기존 source·색인 환경변수 | 원격 모드에서는 Catalog에 전달. Core의 source API 키는 overlay에서 제거 |

실제 source 동기화·색인은 임베딩 비용을 발생시킬 수 있다. 무료 검증이 끝났다고 실제 키를
자동 투입하거나 수집을 시작하지 않는다. 위 격리 도구 외 실제 개발 실행은 기존 데이터와
호출 비용을 확인한 뒤 수행한다.
새 overlay의 source 수집과 색인 플래그도 미설정 시 `false`다. 별도 환경 파일에 명시적으로
켜 놓은 값은 적용되므로, 기존 개발 `.env`의 `true` 값을 그대로 넘기지 말고 확인한다.

## 운영 전환 전에 남은 일

1. 새 Catalog DB·최소권한 계정·TLS·서버 간 비밀 저장소 및 이미지 발행 경로를 승인받는다.
2. 기존 공고를 백업하고 별도 Catalog에 가져온 뒤 source별 건수·내용·식별자를 대조한다.
   이 저장소 변경이 운영 데이터를 자동 백필하지 않는다.
3. 수집 단일 주체를 전환하고 Core projection·FK·사용자 업무와 실패·재시작을 검증한다.
   소유권 검사가 없는 옛 Core 이미지로 자동 롤백하면 기존 수집기가 다시 켜질 수 있으므로,
   허용할 롤백 이미지와 writer 비활성 상태를 전환 전에 고정하고 검증한다.
4. Catalog 이미지·배포 단위를 기존 CodeBuild/SSM 또는 향후 GitOps에 명시적으로 추가한다.
   현재 운영 파이프라인은 여전히 Core·AI 두 이미지를 대상으로 한다.
5. Kubernetes NetworkPolicy·TLS·상태 저장소 백업·부하·관측을 확인하고 그 후 Core의 호환 수집 코드를 제거한다.

현재 snapshot API는 source 전체 목록을 수신하는 1단계 계약이다. 운영 데이터 증가 전에는
동일 revision의 조건부 조회·페이지 일관성·대조 주기·지연 감시를 검증해야 한다.
DB 서버 분리만으로 네트워크 접근 제어·HA·백업·수평 확장을 완료했다고 주장하지 않는다.
