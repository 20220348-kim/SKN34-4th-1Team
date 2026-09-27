# Phase 5-4 ONLINE_FORM source acquisition 평가

Issue #56 [skn-29]. canonical main: d6441d8931dc533da8b5f307e83749afb8459ce6 (작업 시작 시 upstream fetch 확인).
판정: PHASE5_EXTERNAL_SOURCE_PARTIAL. 실제 지원 provider: NONE.
기존 Phase 5-2·5-3 평가 기록은 수정하지 않는다.

## Provider feasibility와 decision gate

| 후보 | 공식/안정 계약 | 인증·권한 | 현재 판정 |
|---|---|---|---|
| Google Forms | 공식 forms.get GET API 존재 | OAuth scope, token 주체의 form 접근 권한, 실제 formId 필요 | REQUIRES_AUTH |
| Public HTML Form | 표준 form/label/input/textarea/select 존재 | 사이트별 공개 여부·인증·markup 확인 필요 | concrete target 없음, UNSUPPORTED_PROVIDER |

공식 근거 (2026-09-28 확인):
- [forms.get](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/get): forms.body.readonly 등의 scope 필요.
- [응답자 공개·권한 관리](https://developers.google.com/workspace/forms/api/guides/publish-form): 응답자 공개와 권한을 따로 관리한다.
- [HTML 표준](https://html.spec.whatwg.org/multipage/forms.html): form과 control의 표준 계약.

공식 문서는 공개 responder URL 소유만으로 Forms API 접근이 보장된다고 명시하지 않는다.
owner/editor 등 실제 주체의 권한은 향후 credential 및 대상 form으로 확인해야 하며,
현재 어떤 권한 조합이 가능하다고 단정하지 않는다.
현 GoogleOAuthClient는 openid email만 요청하고 ID token에서 OAuthProfile만 반환한다.
Forms token 저장/refresh/ownership lifecycle이 없으므로 로그인 기능을 Forms 인증으로 재사용하지 않는다.
고정 환경변수 access token, 신규 OAuth lifecycle, Google 내부 payload scraping은 추가하지 않는다.
저장소 manifest와 요청에서 일반 HTML concrete target을 확인하지 못했다. HTML 표준만으로 실제 지원을 선언하지 않는다.

## 구현된 경계와 기존 review

External reference → HTTPS/identity validation → Service findOwned → pinned Manifest lookup
→ GOOGLE_FORMS URL 계약 확인 → REQUIRES_AUTH 또는 UNSUPPORTED_PROVIDER.

sourceUrl/provider 문자열만 보존하며 미확인 provider enum·metadata·registry·factory·Client는 없다.
정확한 Google Forms host/path 또는 forms.gle short reference만 인증 필요로 분류한다.
short link를 resolve하거나 responder ID를 공식 API formId로 추측하지 않는다.
미지원 URL에는 Google host suffix 위장, 다른 Google 문서, formResponse 제출 경로,
일반 HTML·미등록 provider·private/metadata 주소가 포함된다.
Google URL 판정은 실제 존재·접근 권한 검증이 아니다. SOURCE_UNAVAILABLE은 원격 조회 없이 반환하지 않는다.
Capability result는 source/review/성공 상태를 포함하지 않는다.

기존 ApplicationOnlineFormSource → reviewOnlineForm → ApplicationOnlineFormMap
→ ApplicationFieldMapping → Review Result는 그대로다. 외부 참조와 이 경로 사이의 acquisition은 미구현이다.
가짜 source를 주입하는 external E2E 성공 테스트를 만들지 않는다.
DB write·Fact/revision/content/snapshot 변경·AI 호출 없음은 Service mock 호출과 값 비교로 검증한다.
실제 DB 통합 검증으로 표현하지 않는다.

## 보안과 제한

HTTPS만, 최대 URL 2048자, 정규화된 provider 식별자, host 필수.
userinfo·명시적 port·fragment 및 malformed URI 거절. 오류/toString은 URL을 출력하지 않는다.
로그·token·응답 데이터는 추가하지 않는다.
SSRF fetch 방어, DNS pinning, redirect validation/limit, connect/read timeout,
maximum body size, content-type: N/A (외부 I/O 자체 없음).
private URL의 미지원 분류 테스트는 실제 SSRF network defense 테스트가 아니다.
실제 collector를 도입할 때에는 위 안전 경계가 모두 필요하다.

Public HTTP API, persistence, browser automation, auto fill, submit: NOT_IMPLEMENTED.
Form responses 조회: NOT_IMPLEMENTED.
DocumentMap/NativeTarget/WritePlan/5-format editors/DB schema/Flyway/AI Service/MCP: UNCHANGED.

## 검증

로컬: Windows / JDK 21.0.12.1 / Gradle 9.5.1. 12개 스위트, 91 tests PASS.
failures/errors/skipped 모두 0. git diff --check PASS. source reference 2, service 4,
기존 Source 8 / FormMap 13 / FieldMapping 11, Architecture 1 / Boundary 2,
FILE MappingService 15 / MappingChange 3 / McpClient 12 / Editor 15 / HwpPlan 5.
Service·AI HTTP stub 검증과 FILE projection/editor 회귀이며 실제 provider나 실제 DB 검증은 아니다.

실행 위치: backend/core-service.
~~~powershell
$env:JAVA_TOOL_OPTIONS='-Djdk.net.unixdomain.tmpdir=C:\nonexistent-gradle-unix-socket-directory'
.\gradlew.bat test --tests '*ApplicationOnlineFormSourceReferenceTest' --tests '*ApplicationOnlineFormSourceTest' --tests '*ApplicationOnlineFormMapTest' --tests '*ApplicationFieldMappingTest' --tests '*ApplicationPreparationServiceOnlineFormTest' --tests '*ApplicationPreparationArchitectureTest' --tests '*ApplicationDocumentBoundaryContractTest' --tests '*ApplicationDocumentMappingServiceTest' --tests '*ApplicationDocumentMappingChangeTest' --tests '*ApplicationDocumentMcpClientTest' --tests '*ApplicationDocumentEditorTest' --tests '*ApplicationHwpPlanTest' --no-daemon
~~~
위 JAVA_TOOL_OPTIONS는 Windows JDK socket 대응을 해당 검증 프로세스에만 적용한다.
GovBiz CI의 push는 branch/path 제한이 없으며 Core는 JDK 21 clean build와 전체 테스트를 실행한다.
선택 로컬 검증은 원격 CI나 MySQL 8.4 Testcontainers 전체 검증을 대체하지 않는다.
최신 작업 commit의 원격 CI 결과를 확인하기 전에는 전체 검증 완료를 선언하지 않는다.

REAL_PROVIDER_SMOKE: NOT_RUN (사용 가능한 credential 및 concrete target 없음).
Client/collector mock HTTP, 401/403/404/timeout/payload/control normalization: N/A (collector 없음).
기존 Source normalization/matching은 기존 Phase 5 테스트로 검증한다.
CANONICAL_MAIN_FAILURES: 최신 canonical d6441d8의
[GovBiz CI](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team/actions/runs/36331210925)는
Core failure / Container skipped, Web·Shared·Mobile·AI success임을 공개 API로 확인했다.
공개 annotation은 exit code 1만 제공하여 세부 테스트 원인은 확인하지 못했다.
과거 보고서의 비밀번호 재설정 동시성 실패를 현재 원인으로 단정하지 않고 해당 테스트도 수정·재실행하지 않았다.
SKN29_FAILURES: 로컬 선택 검증 0. PATCH_REGRESSION: 로컬 선택 검증 0. 원격 CI는 push 후 별도 확인.

## 후속 단계

사용자가 승인한 실제 form, 접근 가능한 API formId와 주체·scope·credential lifecycle을 확인한 뒤
공식 Google Forms Client를 도입하거나 실제 공개 HTML 표준 form 대상을 확인한다.
수집 성공 시 기존 Source 계약으로 정규화하고 기존 review를 재사용한다.
인증·권한·timeout·payload·지원하지 않는 control과 읽기 전용 E2E를 검증해야 READY다.
PR: NOT_CREATED. merge: NOT_RUN. main push: NOT_RUN.