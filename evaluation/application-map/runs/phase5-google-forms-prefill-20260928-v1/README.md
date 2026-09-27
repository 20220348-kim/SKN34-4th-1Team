# Phase 5-5 Google Forms 공식 read/prefill Decision Gate

Issue: #56 [skn-29]. 조사일: 2026-09-28.
Canonical main: d6441d8931dc533da8b5f307e83749afb8459ce6 (upstream fetch 후 확인).
판정: **PHASE5_GOOGLE_FORMS_PREFILL_BLOCKED**.

이번 변경은 Phase 5-4 capability 구현을 보존하고 공식 경로의 실행 조건과 blocker를 기록한다.
Forms incremental auth, REST collector, Apps Script helper/client, prefilled URL은 **NOT_IMPLEMENTED**다.
공식 API 존재 확인을 실제 read/prefill 성공으로 간주하지 않는다. Phase 5 종료 조건은 미충족이다.

## 기존 OAuth 구조 확인

확인한 production 파일:
- `account/client/oauth/GoogleOAuthClient.kt`: 로그인 인가 scope는 `openid email`, PKCE S256과 nonce를 보낸다.
  token exchange 뒤 ID token의 issuer/audience/expiry/issued-at/nonce를 검사하여 OAuthProfile만 반환한다.
  Google access/refresh token을 반환하거나 저장하지 않는다.
- `account/config/AccountOAuthProperties.kt`: 기존 로그인 callback은 `/api/v1/auth/oauth/google/callback`이다.
- `account/service/AccountOAuthService.kt`: state와 provider를 대조하고 subject로 계정을 찾거나 생성한다.
  `safeReturnPath`는 앱 내부 절대 경로만 허용한다.
- `account/controller/AccountOAuthController.kt`: 시작과 callback은 302, callback에서 state 쿠키를 지운다.
- `account/helper/OAuthStateCookieHelper.kt`: HMAC 서명, HttpOnly/SameSite=Lax, 로그인 경로 제한,
  10분 TTL이다. **서명은 암호화가 아니다.** payload는 base64url JSON이다.
- `AccountOAuthIdentityMapper`, `AccountOAuthIdentityDbRow`, 대응 XML: account/provider/subject/linkedAt만 저장한다.

기존 GoogleOAuthClientTest, AccountOAuthServiceTest, AccountOAuthFlowIntegrationTest 및 state helper 테스트도 읽었다.
기존 로그인 scope/endpoint/동작은 수정하지 않았다. DB에 Google access/refresh token을 추가하지 않았다.

## 단기 상태 저장 검토와 blocker

현재 `ApplicationDocumentMigrationProposalStore`는 owner/preparation/token 키와 15분 TTL로
문서 변경 제안을 Redis에 저장한다. 이 데이터는 bearer credential이 아니다.
`infrastructure/compose.yaml`과 `compose.prod.yaml`의 Redis는 AOF 영속화를 사용한다.
단순 TTL 키에 access token을 넣으면 TTL만으로 디스크/백업에서 token 제거를 보장할 수 없다.
기존 state 쿠키 역시 access token 암호화나 account/session binding 저장소로 재사용할 수 없다.

이는 Redis를 원천적으로 사용할 수 없다는 판정이 아니다. **현 저장 방식을 그대로 credential 저장에
재사용할 수 있다는 근거가 없다는 판정**이다. 안전한 token 수명·재사용 정책이 확정되지 않았다.
요청의 저장 정책 Decision Gate에 따라 새 credential 암호화/저장 체계를 임의로 추가하지 않았다.
요청 처리 안에서만 token을 사용하는 방식도 이후 사용자 매핑 확인까지 이어지는 lifecycle과 함께 결정해야 한다.

조회한 worktree에는 `.env.example`/`.env.compose.example`만 있으며, 현재 프로세스에서 Google Forms
credential/smoke 설정 환경변수는 확인되지 않았다. secret 값은 읽거나 출력하지 않았다.
같은 Cloud 프로젝트의 API executable 배포, 배포 접근 설정, delegated identity를 확인할 설정과
A/B/C smoke 대상이 제공되지 않았다. 배포가 외부에 존재하지 않는다고 단정하지 않는다.
사용자에게 준비 여부/안전한 설정 위치를 요청했으며 현재 확인된 정보만으로 gate를 통과하지 않았다.

## Incremental authorization 설계 (미구현)

일반 Google 로그인 `openid email`은 유지한다. Forms 기능을 선택한 사용자만 별도 application-preparation
흐름에서 추가 동의를 시작해야 한다. 로그인 transaction과 Forms transaction의 의미·쿠키 경로를 분리한다.

- REST read 요청 scope: `https://www.googleapis.com/auth/forms.body.readonly`만 우선 요청한다.
- Apps Script prefill scope: `https://www.googleapis.com/auth/forms`가 별도로 필요하다.
  `FormApp.openById`는 이 scope를 요구한다. `forms.body.readonly`로 대체할 수 없다.
  임의 외부 Form을 여는 standalone helper에 `forms.currentonly`를 대신 사용할 수 없다.
- `include_granted_scopes=true` 등 incremental authorization 정책은 로그인 scope 변경과 구분한다.
- state, PKCE S256, callback 검증, 짧은 TTL, 일회용 소비, 현재 account/session binding,
  preparation ownership과 안전한 return path를 검증해야 한다. offline access/refresh 저장은 추가하지 않는다.
- Forms 권한 동의와 해당 Form 접근 권한은 별개다. 사용자 소유/공유 권한을 API에서 확인해야 한다.

이는 배포된 endpoint나 검증된 auth 구현에 대한 설명이 아니다.

## 공식 read 경로와 URL identity

[forms.get](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/get)는
`GET https://forms.googleapis.com/v1/forms/{formId}`이며 `forms.body.readonly`를 허용한다.
새 concrete Client가 필요하면 호출은 `ApplicationPreparationService → GoogleFormsClient → Forms API`로 둔다.
외부 DTO는 client/googleforms/dto, 변환은 client/googleforms/mapper에서 수행하고 Domain에 JSON을 넘기지 않는다.
이번 gate가 막혀 실제 Client/수집 경로는 추가하지 않았다.

[Form resource](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms)는 formId와
응답자용 responderUri를 별개 필드로 제공한다. Phase 5-4의 docs.google.com/forms 참조와 forms.gle
분류는 **REQUIRES_AUTH** 판정일 뿐 ID 추출이나 권한 확인이 아니다.
`/d/e/{published-id}/viewform`의 published ID와 short link를 API formId로 추측하지 않는다.
이번 실행에서 responder/published URL의 실제 smoke 근거가 없으므로 지원 범위를 확대하지 않는다.

## Question type (공식 schema 조사, production 지원 NONE)

| 후보 | 공식 REST 구조 | 변환 시 사용할 identity |
|---|---|---|
| Short text | question.textQuestion.paragraph=false | question.questionId |
| Paragraph | question.textQuestion.paragraph=true | question.questionId |
| Single choice | choiceQuestion.type=RADIO | question.questionId |
| Checkbox | choiceQuestion.type=CHECKBOX | question.questionId |
| Dropdown | choiceQuestion.type=DROP_DOWN | question.questionId |

itemId와 questionId는 별개이며, REST questionId를 Apps Script item ID로 임의 캐스팅하지 않는다.
helper 연동 전에 실제 공식 identity 대응을 확인해야 한다. index 기반 ID와 entry ID 추측은 금지다.
Source는 기존 ApplicationOnlineFormSource(formId/formTitle/controlId/label/required)를 그대로 사용한다.
이후 기존 reviewOnlineForm → ApplicationOnlineFormMap → fieldMappings를 재사용하고 fuzzy matching을 추가하지 않는다.

grid/checkbox grid, file upload, date/time, scale/rating, conditional navigation, 복잡한 quiz/grading은
안전한 변환 대상에서 제외하고 명시적인 UNSUPPORTED_CONTROL 검토 사유를 남겨야 한다.
선택지의 기타 값·분기·options와 저장 Fact 표현의 호환성도 확인해야 한다.
현재 collector가 없으므로 Google question type의 production 지원은 모두 NONE이며 새 enum도 추가하지 않았다.

## 공식 prefill 실행 Decision Gate

[Apps Script API 실행 조건](https://developers.google.com/apps-script/api/how-tos/execute):
API executable 배포, 같은 standard Google Cloud 프로젝트의 OAuth client, Apps Script API 활성화,
script 전체 scope를 충족하는 delegated OAuth token과 배포의 사용자 접근 설정이 필요하다.
service account는 지원하지 않는다. 문서의 실행 요청은 배포 ID를 사용하며 devMode는 소유자 전용이다.
기존 로그인 OAuth의 Cloud 프로젝트와 해당 배포의 연결 및 실제 사용자 실행 권한은 **NOT_VERIFIED**다.
따라서 script source/appsscript.json/production bridge를 추가하지 않는다.

공식 경로는 FormApp.openById → Form.createResponse → Item.createResponse →
FormResponse.withItemResponse → [toPrefilledUrl](https://developers.google.com/apps-script/reference/forms/form-response#toPrefilledUrl())다.
[openById](https://developers.google.com/apps-script/reference/forms/form-app#openById(String))는
접근 권한이 부족하면 오류가 난다고 명시한다. 공개 응답 링크만으로 성공한다고 판단하지 않는다.

허용되는 helper는 URL 생성만 담당해야 한다. Form 수정/생성/삭제, 권한 변경, 응답 저장/조회 및 submit은 금지다.
401/403/PERMISSION_DENIED를 우회하거나 정상 결과로 숨기지 않는다.
REQUIRES_AUTH / INSUFFICIENT_FORM_PERMISSION / PREFILL_NOT_SUPPORTED 같은 capability 확장은
실제 read/prefill 경로가 생길 때 기존 Phase 5-4 구조에서 최소한으로 수행한다.
현재는 REQUIRES_AUTH/UNSUPPORTED_PROVIDER만 존재하며 READ_SUPPORTED/PREFILL_SUPPORTED를 반환하지 않는다.

## 실제 permission matrix

| Case | forms.get | FormApp.openById | Official prefill | URL 화면 입력값 |
|---|---|---|---|---|
| A: Owned | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| B: Shared (권한 수준 미제공) | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| C: Public responder-only | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |

세 경우 모두 권한 결과는 **UNKNOWN_NOT_VERIFIED**다. Case C를 실패/성공으로 추측하지 않는다.
PREFILL_SUCCESS_EVIDENCE: NONE. credential 및 실제 대상, API executable 배포 정보가 없다.
responder-only 공식 권한 실패가 실제 확인되면 Phase 6에서 답변 검토·값 복사·원본 링크까지만 제공한다.
그 UX도 이번 Phase에서 구현하지 않았으며 scraping/prefill fallback을 추가하지 않았다.

실제 smoke 재개 시 GOOGLE_FORMS_REAL_SMOKE=1 같은 명시적 opt-in과 secure local config를 사용하고,
A/B/C 주체·scope·공유 권한 수준을 구분한다. form ID/token/실제 답변은 repository에 저장하지 않는다.
read, prefill, URL 열기/사람의 입력 표시 확인은 각각 결과를 기록하고 제출하지 않는다.

## 보안 상태와 보존 계약

| 항목 | 현재 확인/상태 |
|---|---|
| 기존 login state/PKCE/TTL/safe return | 기존 코드 유지; 회귀 검증 결과는 아래 별도 기록 |
| Forms account/session binding, token TTL/일회용 소비 | NOT_IMPLEMENTED; 기존 로그인 테스트로 대체하지 않음 |
| Preparation ownership | 기존 Phase 5-4 findOwned 경로 유지 |
| Token persistence/logging | 신규 저장·로그 없음; access/refresh token DB 저장 없음 |
| Forms URL reference validation | 기존 HTTPS/host/path 분류 유지; API formId 추출 없음 |
| Prefilled URL allowlist | NOT_IMPLEMENTED; URL 반환 자체 없음 |
| 향후 URL 반환 | 최소 docs.google.com의 공식 Forms responder 경로 검증 후만 반환; 임의 host 확장 금지 |
| FILE DocumentMap/NativeTarget/WritePlan/5-format | UNCHANGED |
| DB schema/Flyway/MCP/AI Service production | UNCHANGED |
| OpenAI call | NONE |

AUTO_SUBMIT: NOT_IMPLEMENTED. FORM_RESPONSE_SUBMIT_CALL: NONE (최종 정적 검사 결과 아래).
정부 포털 자동화: NOT_IMPLEMENTED. Full Form contents/token/code/header 로그 추가 없음.

## 검증 기록

이번 실행의 실제 최종 결과는 아래에 기록한다. 과거 테스트 개수를 재사용하지 않는다.
Forms OAuth/REST Client/prefill helper 테스트: NOT_RUN (해당 production 코드 없음).
mock HTTP 200/401/403/404/429/5xx/timeout/malformed JSON: NOT_RUN (collector 없음).
실제 permission matrix: NOT_RUN. 로컬 회귀 통과가 실제 Google 권한/read/prefill 성공은 아니다.
CI: GovBiz CI push 이벤트는 branch/path 제한 없이 Core JDK 21 clean build/전체 테스트를 실행한다.
최신 작업 SHA의 실제 CI 결과 확인 전 전체 검증 완료를 선언하지 않는다.
Baseline과 이번 branch CI 결과는 구분한다.

## Phase 5 종료 판정

FILE mapping, ONLINE_FORM FormMap/Source/deterministic review와 provider capability 기반은 보존됐다.
Google 공식 read path 실제 검증과 공식 prefill 성공/권한 범위 확정은 미완료다.
**Phase 5: NOT_CLOSED. PHASE5_GOOGLE_FORMS_PREFILL_BLOCKED.**

재개 조건: 같은 Cloud 프로젝트의 배포/접근 설정과 사용자 delegated 실행 확인,
안전한 account/session/preparation-bound 단기 token lifecycle 결정, A/B/C 실제 대상과 credential 준비.
조건이 충족되면 최소 incremental auth 및 read 경로부터 구현하고 공식 prefill과 identity 대응을 검증한다.
READY는 실제 공식 read → Source → mapping → 확정 Fact → prefilled URL 성공과 submit 없음이 확인된 뒤만 선언한다.

PR: NOT_CREATED. Draft PR: NOT_CREATED. merge: NOT_RUN. main push: NOT_RUN.

### 이번 실행의 최종 로컬 결과

Windows / Eclipse Temurin JDK 21.0.12.101 / Gradle 9.5.1.
**17 suites / 126 tests PASS, failures=0, errors=0, skipped=0.**

| 범위 | 실제 결과 |
|---|---|
| 기존 GoogleOAuthClient / AccountOAuthService / Controller / state helper | 31 tests PASS (공급자 HTTP mock/서비스 대역) |
| AccountOAuthFlowIntegrationTest | 4 tests PASS (실제 MySQL 8.4 Testcontainers, Google/Kakao Client 대역) |
| Phase 5 FieldMapping / FormMap / Source / Reference / Service | 38 tests PASS |
| FILE mapping / migration change / MCP stub / editor / HWP plan | 50 tests PASS |
| Architecture / DocumentBoundary | 3 tests PASS |
| Forms incremental OAuth / REST client / prefill / 실제 permission | NOT_RUN (미구현 또는 credential/target/배포 부재) |
| git diff --check / 변경 문서 상대 링크 | PASS |

FILE 테스트는 기존 HWP/HWPX/PDF/DOCX/XLSX projection/editor 경로 회귀이며 실제 Google Form 검증이 아니다.
생산자·소비자 계약 변경 없음. 실제 API/OpenAI 호출 없음. CI 전체 테스트/클린 빌드/컨테이너 검증을 대체하지 않는다.

실행 위치: backend/core-service.
~~~powershell
$env:JAVA_TOOL_OPTIONS='-Djdk.net.unixdomain.tmpdir=C:\nonexistent-gradle-unix-socket-directory'
.\gradlew.bat test --tests '*GoogleOAuthClientTest' --tests '*AccountOAuthServiceTest' --tests '*AccountOAuthFlowIntegrationTest' --tests '*AccountOAuthControllerTest' --tests '*OAuthStateCookieHelperTest' --tests '*ApplicationFieldMappingTest' --tests '*ApplicationOnlineFormMapTest' --tests '*ApplicationOnlineFormSourceTest' --tests '*ApplicationPreparationServiceOnlineFormTest' --tests '*ApplicationOnlineFormSourceReferenceTest' --tests '*ApplicationPreparationArchitectureTest' --tests '*ApplicationDocumentBoundaryContractTest' --tests '*ApplicationDocumentMappingServiceTest' --tests '*ApplicationDocumentMappingChangeTest' --tests '*ApplicationDocumentMcpClientTest' --tests '*ApplicationDocumentEditorTest' --tests '*ApplicationHwpPlanTest' --no-daemon
~~~
JAVA_TOOL_OPTIONS는 Windows JDK socket 대응을 이 검증 프로세스에만 적용했다.
전체 production 경로에서 `.submit(...)`, `FormResponse.submit`, `forms.responses.create`,
`FB_PUBLIC_LOAD_DATA_`, 숫자 entry ID와 formResponse 경로를 rg로 검사했다.
유일한 production `.submit(...)` match는 ApplicationFormDiscoveryJobController의 수집 작업 큐 등록이며
Google Form 제출이 아니다. Google response 제출·비공식 parsing 코드 match는 없다.

CANONICAL_MAIN_FAILURES: d6441d8의
[GovBiz CI](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team/actions/runs/36331210925)를
이번 실행에서 공개 GitHub API로 재확인했다. Core API failure / Container integration skipped,
Web and shared·Mobile·AI Service success. 세부 실패 원인은 확인하지 못했으므로 특정 테스트로 추정하지 않는다.
SKN29_LOCAL_FAILURES: NONE. 원격 CI는 최종 push SHA를 기준으로 별도 확인하며,
이 파일을 수정해 push SHA의 사후 CI 결과를 기록하는 추가 커밋은 만들지 않는다.
