# SKN-33 공식 신청 경로 평가 (2026-09-28)

로컬 판정: **PHASE6_APPLICATION_ROUTE_READY 후보**. 선택 테스트, MySQL 8.4 repository 검증,
격리 Compose의 실제 Catalog → Core HTTP projection·상세 응답 검증이 통과했다.
최종 판정은 이 변경을 push한 SHA의 필수 원격 CI 확인 후 확정한다.
Issue: [#63](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team/issues/63).

## Git

- canonical main: `114803041eb5840e87946bb088757f4b28c0e40d` (2026-09-28 커밋 직전 기준).
  `9873475` 이후 추가된 LLMOps/운영 화면 변경은 Phase 6-4 파일과 겹치지 않아 기준만
  fast-forward 반영했다.
- branch: `skn-33`; 검증 중에는 최신 upstream/main과 동일한 HEAD 위에 미커밋 Phase 6-4 변경만 존재
- 보고서 작성 시점의 SHA: 미커밋, ahead/behind: 0/0, push·원격 CI: 아직 NOT_RUN

## Provider evidence

| Provider | Official field evidence | Application method | Application URL | Supported | Reason |
| --- | --- | --- | --- | --- | --- |
| BIZINFO | [기업마당 공식 API 명세](https://www.bizinfo.go.kr/apiDetail.do?id=bizinfoApi), [공공데이터포털](https://www.data.go.kr/data/15157820/openapi.do) | `reqstMthPapersCn` | `rceptEngnHmpgUrl` | 계약 구현 | 공식 명세에 사업신청방법과 사업신청URL로 명시. 명세 예시 값은 비어 있다. |
| KSTARTUP | [창업진흥원 API 설명](https://www.data.go.kr/data/15125364/openapi.do) | 소개에 신청방법 언급, 공고 응답 필드명 미확인 | 필드명 미확인 | UNKNOWN | `detl_pg_url`은 공고 상세이며 신청 URL로 대체하지 않는다. |
| MSIT | [공식 사업공고 API](https://www.data.go.kr/data/15074634/openapi.do) | 현재 목록 응답에서 미확인 | 현재 목록 응답에서 미확인 | UNKNOWN | 확인된 필드는 상세 URL과 첨부파일 등이다. |
| CNTRADE_NOTICE | 저장소의 공식 공고 API decoder/payload | 미확인 | 미확인 | UNKNOWN | 공고 본문·목록 URL에서 신청 경로를 추측하지 않는다. |

인증된 실제 Provider API 호출은 하지 않았다. 실제 공고 5~10건, 다중 신청 URL, Google Form URL 사례는
확보하지 못했다. 미확인은 제공처 전체에 필드가 없다는 단정이 아니다.

## Classification

| Case | method | url type | expected route | actual route | result |
| --- | --- | --- | --- | --- | --- |
| 공개 viewform | 온라인 접수 | docs.google.com/forms/.../viewform | GOOGLE_FORMS | GOOGLE_FORMS | PASS, synthetic unit |
| 단축 URL | 온라인 접수 | forms.gle/... | GOOGLE_FORMS | GOOGLE_FORMS | PASS, synthetic unit |
| edit/formResponse | 온라인 접수 | Google 비응답자 경로 | UNKNOWN 및 URL 제거 | UNKNOWN 및 URL 제거 | PASS, synthetic unit |
| 다른 공식 신청 URL | 홈페이지 신청 | HTTPS 신청 URL | OTHER_ONLINE_FORM | OTHER_ONLINE_FORM | PASS, synthetic unit |
| 명시적 이메일 제출 | 신청서 작성 후 이메일 제출 | 없음 | FILE | FILE | PASS, synthetic unit |
| 누락·모호·잘못된 URL | 없음/모호 | 없음/잘못됨 | UNKNOWN | UNKNOWN | PASS, synthetic unit |

신청 URL은 HTTPS·host·userinfo 없음·fragment 없음·기본 포트·제어 문자 없음·2048자 이하를 검사한다.
방법은 plain text로 변환하며 UTF-8 8192바이트 초과 시 invalid response 처리한다.
URL fetch, redirect 확인, HTML scraping, OpenAI 호출은 없다.

## Data flow

| 단계 | 코드 상태 | 실행 검증 |
| --- | --- | --- |
| Provider payload → Decoder → Mapper → Catalog domain | BizInfo 공식 필드와 결정적 분류 | PASS, mock API JSON·mapper unit |
| Catalog DB | V2 migration, UPSERT·조회·기존 행 UNKNOWN·URL 갱신/제거 | PASS, MySQL 8.4 Testcontainers |
| Catalog snapshot → Core 수신 DTO/mapper | 명시적 내부 HTTP 계약 | PASS, 실제 격리 서비스 간 HTTP |
| Core projection → DB | V44 migration, 기존 행, URL 갱신/제거 | PASS, MySQL 8.4 Testcontainers |
| Core Detail API | sourceUrl/applicationRoute 분리 | PASS, MockMvc 및 실제 격리 서버 HTTP 200 |

Catalog 검색 지문은 검색 문서 내용 기준이므로 신청 경로를 포함하지 않는다. 제공처 동기화의
revision과 Core projection payload hash에는 신청 경로 변경이 반영된다.

## DB 및 아키텍처

| 검증 | Catalog | Core |
| --- | --- | --- |
| Flyway migration | V2, PASS | V44, PASS |
| MySQL version | 8.4 Testcontainers | 8.4 Testcontainers |
| 기존 열만 입력한 행 | UNKNOWN/null 조회 PASS | UNKNOWN/null 조회 PASS |
| 신청 경로 행 | 저장/조회 PASS | 저장/조회 PASS |
| URL 변경·삭제 | 최신 snapshot 반영 PASS | 최신 generation projection 반영 PASS |
| MyBatis XML | 문법·실제 SQL 실행 PASS | 문법·실제 SQL 실행 PASS |

계층은 BizInfo 외부 DTO/decoder → BizInfo mapper → Catalog domain → Repository/MyBatis →
Catalog 내부 HTTP DTO → Core client DTO/mapper → Core domain → projection Repository/MyBatis →
상세 Service → controller DTO 순서다. 공개 상세 응답은 domain 타입을 직접 노출하지 않고
`SupportProgramApplicationRouteResponse`로 변환한다. 패키지·디렉터리와 의존 방향을
변경 파일 기준으로 대조했다.

## Google Forms handoff

GOOGLE_FORMS URL 형식은 Phase 6-3 `ApplicationOnlineFormSourceReference`와 capability 판정에
맞춘 synthetic 사례이며 Core Phase 6-3 회귀 및 AI Service 공개 Form reader 26개 테스트가 통과했다.
실제 URL inspection은 이번 Phase 범위가 아니며 MCP 호출은 **NOT_RUN_BY_DESIGN**이다.

## 검증 및 한계

- Linux `eclipse-temurin:21-jdk` Docker, MySQL 8.4 Testcontainers:
  Catalog decoder·mapper·classifier·sync 선택 테스트 및 Repository 통합 테스트 PASS.
- 같은 환경의 Core snapshot client·projection·repository·detail Service·MockMvc controller,
  Phase 6-1 입력 가이드·Phase 6-3 온라인 Form·문서 경계 선택 테스트 PASS.
- `python -B infrastructure/scripts/verify-catalog-separation.py`: PASS. 별도 Compose 프로젝트에서
  BizInfo synthetic 신청 URL `https://forms.gle/composeRoute123`이 Catalog snapshot과 Core 상세
  HTTP 응답에 동일하게 나타났고, 양쪽 MySQL의 route type도 `GOOGLE_FORMS`였다.
  URL 없는 method-only 공고는 `UNKNOWN`을 유지했다. 네 제공처의 완전한 snapshot,
  Core projection, 검색 및 제공처/Catalog 장애 시 기존 데이터 보존도 PASS. 임시
  컨테이너·볼륨·네트워크는 스크립트 종료 시 정리됐다.
  canonical main이 `9873475`로 갱신된 뒤 같은 격리 검증을 다시 실행해 PASS했다.
- AI Service의 `uv run --locked --extra dev python -m pytest tests/application_preparation/test_public_google_form_reader.py`:
  26 passed. 유료 API 호출·실제 Form inspection 없음.
- 최신 Core 기준 JDK 21 컨테이너의 상세·projection·repository·Phase 6-1/6-3·문서 경계
  선택 테스트 PASS. 요청에 언급된 `AccountPasswordResetFlowIntegrationTest.concurrentRequestsCannotReuseTheSamePasswordResetToken`
  도 최신 main 기반 이번 실행에서 PASS하여 과거 실패를 현재 baseline으로 취급하지 않는다.
- 최신 main의 웹 상세 소비자 `pnpm test src/presentation/features/support-program-detail/view/SupportProgramDetailPage.test.tsx`:
  13 passed. 전체 Web/shared 테스트·빌드는 실행하지 않았다.
- 두 MyBatis XML 구문 검사 PASS. 실제 MySQL round-trip은 위 통합 테스트로 별도 확인했다.
- 첫 Catalog 실행의 기존 테스트 1건은 `reqstMthPapersCn`을 미사용 필드로 가정한 테스트 오류였다.
  미사용 `refrncNm` 사례로 교정하고 신청방법 객체 거절 테스트를 추가한 뒤 관련 테스트 PASS.
- Windows Gradle의 `Unable to establish loopback connection`은 **ENVIRONMENT_FAILURE**.
  Linux 컨테이너에서는 재현되지 않았다. 웹 테스트 첫 실행의 `EPERM`도 작업 트리 권한
  문제였고 권한을 조정한 재실행은 PASS했다.
- 실제 공식 BizInfo API 응답 5~10건, 실제 Google Form URL,
  HWP/HWPX/PDF/DOCX/XLSX 전체 생성 smoke, Web/shared, 배포 검증은 **NOT_RUN**.
  인증된 Provider API 키가 없고 변경 범위가 직접 연동하지 않는 경로들이다.
- 격리 Compose `--config-only`: PASS. 전체 `verify-catalog-separation.py` 첫 실행은 AI 이미지
  빌드 중 `EROFS`와 Docker 엔진 EOF/500 오류로 중단됐다. Docker Desktop 재시작 후 두 번째
  실행은 같은 AI 이미지 레이어 내보내기에서 C: 여유 공간이 약 1GiB로 감소해 추가 고갈을 막기
  위해 중단했다. 디스크 정리·압축 후 세 번째 실행은 끝까지 PASS했다.
- C: 여유 공간이 0바이트에 도달했다. 이 작업 트리의 Gradle `build` 두 곳과 AI 테스트
  `.venv`만 정리했고 소스·기존 컨테이너·볼륨은 삭제하지 않았다. 로컬 JUnit 결과 파일은
  `build`와 함께 제거됐지만 명령 출력의 성공 결과는 확인했다. 이후 여유 공간은 약 12GiB로
  회복됐고 Docker Desktop도 사용자가 재시작했다. 두 번째 빌드에서 여유 공간이 다시 약
  0.55GiB로 줄었다. 실패한 격리 프로젝트의 미사용 이미지 두 개만 제거했으며 다른 프로젝트의
  이미지·컨테이너·볼륨은 보존했다.
- 원격 CI: 커밋·push 후 최신 SHA에 대해 확인 예정. 현재 전체 검증 완료로 표현하지 않는다.
- 실패 분류: `ENVIRONMENT_FAILURE` = Windows Gradle loopback, 앞선 Compose 이미지 빌드의
  저장공간/Docker 엔진 장애, 첫 웹 테스트의 쓰기 권한 오류. 최종 로컬 선택·DB·격리 HTTP·웹
  검증에는 `PATCH_REGRESSION` 없음.
