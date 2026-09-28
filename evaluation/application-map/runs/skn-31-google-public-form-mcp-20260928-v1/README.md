# 공개 Google Form 질문 조회 MCP 검증 기록

- 작업 이슈: [skn-31 / GitHub #60](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team/issues/60)
- 기준: `upstream/main` 5eb035c (2026-09-28 재조회·반영)
- 범위: 이미 확보한 익명 responder URL의 질문 구조 읽기 및 기존 ONLINE_FORM 매핑 검토

## 기존 MCP 후보 판정

| 후보 | 라이선스·유지 상태 | 인증/Cloud | 도구·출력 | 공개 responder URL만으로 읽기 | 판정 |
|---|---|---|---|---|---|
| [naster3/google-forms-mcp](https://github.com/naster3/google-forms-mcp) | MIT, 공개 GitHub 마지막 push 2026-04-09, 조사 시 5 commits, pin 가능한 Git commit | Google Cloud 프로젝트·OAuth client/token 필요 | `get_form`, `list_items`, 생성/수정/응답 도구, 구조화 JSON | 아니오 | `NOT_ADOPTED_FOR_PUBLIC_RESPONDER` |
| [HosakaKeigo/mcp-server-google-forms](https://github.com/HosakaKeigo/mcp-server-google-forms) | README에 MIT 표기(GitHub license metadata 없음), 마지막 push 2025-05-23, pin 가능한 Git commit | Forms API 활성화·ADC/OAuth 또는 service account 필요 | 조회·수정 Forms API 도구 | 아니오 | `NOT_ADOPTED_FOR_PUBLIC_RESPONDER` |
| [pickuperast/google-workspace-mcp](https://github.com/pickuperast/google-workspace-mcp) | MIT, 공개 GitHub 마지막 push 2026-06-03, pin 가능한 Git commit | Google Cloud 프로젝트·OAuth client/refresh token 또는 service account 필요 | Workspace 통합 Forms 도구 및 쓰기 도구 | 아니오 | `NOT_ADOPTED_FOR_PUBLIC_RESPONDER` |

세 후보는 공개 `viewform` HTML을 익명으로 읽는 도구가 아니라 공식 Google Forms API 래퍼다. [Google `forms.get` 문서](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/get)는 OAuth scope를 요구한다. 공개 responder URL만 있고 소유·편집 권한이나 access token이 없는 이번 사용 사례의 채택 조건을 충족하지 않는다. push 날짜는 2026-09-28 GitHub 공개 저장소 metadata 기준이다. release/version pin은 따로 검증하지 않았고 세 후보 모두 이번 목적에는 부적합해 채택하지 않았다.

## Parser 근거와 경계

2026-09-28 익명 HTTPS GET으로 공개 Form 3개를 검사했다. 세 응답 모두 `text/html`이며 `<script>`를 제외한 본문에 질문 `role=listitem`, 제목 `role=heading` 및 입력/ARIA 요소가 있었다. 텍스트 입력은 `<input type=text>`, 장문은 `<textarea>`, 단일 선택은 `role=radiogroup/radio`, dropdown은 `role=listbox/option`에서 확인했다. `required` 또는 `aria-required=true`가 노출됐다. 섹션 제목은 `aria-level=2`로 질문과 분리됐다. 예시 표본에서는 질문 컨테이너 26/1/2개가 관찰됐고 첫 번째는 섹션 제목 2개를 포함한다. 실제 질문 수는 아래 smoke에서 parser 결과로 보고한다.

`FB_PUBLIC_LOAD_DATA_`, Google 내부 JS 변수/네트워크 API, `entry.*`, 제출 endpoint는 parser 입력이나 식별자에 사용하지 않는다. 질문 label/type/options/order로 snapshot 내부 `controlId`를 만들고 title/질문 의미 구조로 `semanticFingerprint`를 계산한다. HTML nonce는 fingerprint에 들어가지 않는다. Google의 공식 questionId가 아니다. 복수 페이지의 나머지 질문이 HTML에 없으면 검사를 거절하며, 알 수 없는 질문 유형은 `UNKNOWN`으로 표시하고 Core 매핑은 중단한다.

## 검증 결과

| 사례 | Fetch | Questions | Supported / Unsupported | 반복 fingerprint | 결과 |
|---|---|---:|---:|---|---|
| A: 단문·단일 선택·dropdown | PASS | 24 | 24 / 0 | 동일 | PASS |
| B: 단문·장문 | PASS | 2 | 2 / 0 | 동일 | PASS |
| C: checkbox·단일 선택·단문 | PASS | 7 | 7 / 0 | 동일 | PASS |

- 합성 parser·보안 테스트: `uv run --locked --extra dev python -m pytest tests/application_preparation/test_public_google_form_reader.py -q` 새 reader 25개와 기존 Document MCP 계약을 합한 112개 통과(`--basetemp` 지정).
- 실제 stdio MCP: A/B/C 각각 두 번 조회, 질문 수·순서·required·options·fingerprint 안정성 PASS. 원본 HTML 저장 없음.
- Windows 직접 Gradle은 JDK 21 `PipeImpl` loopback 오류로 시작되지 않았다. 격리된 기존 `eclipse-temurin:21-jdk` 컨테이너에서 Core 선택 테스트를 실행했다. 첫 실행의 47개 중 1개는 새 테스트의 MockRestServiceServer 기대값 등록 순서 오류, 1개는 수동 smoke 환경 미설정으로 건너뜀, 나머지는 통과했다. 오류를 수정한 뒤 Core client 5개·Service 6개·실제 vertical smoke 1개가 모두 통과했다. 기존 ONLINE_FORM·입력 도우미·아키텍처·Document 경계 테스트는 첫 실행에서 통과했다.
- Document MCP: `tests/test_document_mcp_contract.py` 포함 로컬 112개 통과. FILE 5형식 전체 생성·실제 파일 연동은 변경하지 않았고 별도 재실행하지 않았다.
- 원본 main CI 기준선: `5eb035c`의 [GovBiz CI](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team/actions/runs/36366230275)는 Core API `failure`, AI Service·Web/shared·Mobile `success`였다. 로그인된 GitHub CI 화면에서 실패 항목이 `AccountPasswordResetFlowIntegrationTest.concurrentRequestsCannotReuseTheSamePasswordResetToken()`임을 확인했다.
- 첫 작업 커밋 `ddfcbf5`의 [GovBiz CI](https://github.com/20220348-kim/SKN34-4th-1Team/actions/runs/36367815734): AI Service·Web/shared·Mobile 성공. Core API는 1,628개 테스트 중 1개 실패·2개 건너뜀으로 실패. 실패 항목은 원본 main과 같은 `AccountPasswordResetFlowIntegrationTest.concurrentRequestsCannotReuseTheSamePasswordResetToken()`이며 이번 변경에서 새로 실패한 테스트는 관찰되지 않았다. Core 컴파일과 테스트 실행은 완료됐다. 실패로 인해 Container integration은 건너뛰었다.
- 같은 SHA의 [Infra CI](https://github.com/20220348-kim/SKN34-4th-1Team/actions/runs/36367815731), [Ops CI](https://github.com/20220348-kim/SKN34-4th-1Team/actions/runs/36367815684), [LLMOps CI](https://github.com/20220348-kim/SKN34-4th-1Team/actions/runs/36367815680), [Catalog CI](https://github.com/20220348-kim/SKN34-4th-1Team/actions/runs/36367815746)는 성공했다. 실제 배포는 실행하지 않았다.

## 한계

공개 Google HTML은 공식 Forms API 계약이 아니므로 DOM 변경 시 parser가 실패할 수 있다. 로그인 필요 Form, 복수 페이지·조건부 분기 전체 의미, 자동입력·자동제출, 응답 조회는 지원하지 않는다. 원본 HTML을 저장하거나 로그에 기록하지 않는다. Google questionId와 `entry.*` 식별자를 사용하지 않는다.

## 최종 판정

`GOOGLE_PUBLIC_FORM_MCP_READY` — 공개 Form reader·stdio MCP와 실제 Core Service→AI HTTP→MCP→ApplicationOnlineFormSource→기존 review 경로를 확인했다. 이 기능 판정은 전체 저장소 CI 통과나 운영 배포 완료를 뜻하지 않는다. 원본 main에도 있는 Core 비밀번호 재설정 테스트 실패로 이전 SHA의 전체 CI는 실패했고 Container integration은 건너뛰었다. 최신 SHA의 CI는 별도로 확인한다.

## 보완 전후와 실제 vertical smoke

| 항목 | 이전 | 보완 후 |
|---|---|---|
| 공개 Form → reader → stdio MCP | 실제 공개 표본 PASS | A/B/C 각각 24/24, 2/2, 7/7 지원·반복 fingerprint 동일 |
| Core → AI → MCP → Source → review | NOT_VERIFIED | 격리된 JDK 21 Core 테스트와 테스트 전용 AI HTTP 서버에서 실제 공개 Form으로 PASS |
| 공개 responder capability | REQUIRES_AUTH | PUBLIC_READ_SUPPORTED 후보. 실제 공개 여부는 inspection에서 확인 |
| edit URL capability | REQUIRES_AUTH | REQUIRES_AUTH 유지 |

실행 환경: Core는 기존 `eclipse-temurin:21-jdk` 컨테이너에서 실제 `ApplicationPreparationService`와 `ApplicationOnlineFormMcpClient`를 사용했다. Repository·FormService는 합성 소유 계정/Preparation과 저장소의 고정 Manifest를 반환하는 테스트 대역이었다. AI는 로컬 Python의 테스트 전용 FastAPI 앱에서 실제 내부 검사 handler만 노출하고, `DOCUMENT_INTERNAL_TOKEN`에 합성 값 32자를 사용했다. AI 내부 handler는 실제 단기 stdio MCP child를 실행해 공개 responder Form을 익명 GET으로 읽었다. 운영 DB, 사용자 계정, OpenAI key/API 호출은 사용하지 않았다. 이는 실제 HTTP·MCP·Google Form 경로의 검증이며 운영 DB/배포 검증은 아니다.

검사 결과: `formId=gpub-form-v1:d8d1f6bb74516463b84a5cca`, `formTitle` 비어 있지 않음, `fieldMappings=11`, `mappedCount=0`, `unmappedCount=11`, `requiredMissingCount=11`, `reviewRequiredCount=13`. 공개 Form 질문과 고정 Manifest label이 달라 매핑 0건은 예상된 검토 결과다. 별도 합성 HTTP 응답에서는 동일한 Core client→Service 경로로 Manifest label `업체명` 1건이 `MAPPED`가 되는 것을 확인했다. 잘못된 URL은 `APPLICATION_ONLINE_FORM_INVALID_URL`, 잘못된 토큰은 AI의 401을 Core client의 명시적 예외로 전달했다.

보안 검증: Reader는 GET만 사용하고 redirect·DNS 공인 주소·TLS·본문 크기·timeout을 검사한다. 합성 테스트는 비허용 host, 사설 IP, 외부 redirect, redirect 제한, 404/429/5xx, 비 HTML, 크기 초과와 timeout을 확인했다. MCP child 환경에서 `DOCUMENT_INTERNAL_TOKEN`, `OPENAI_API_KEY`, DB 비밀번호, Google refresh token 제외를 테스트했다. Google 내부 payload, `entry.*`, OAuth, prefill, 자동입력·자동제출, 원본 HTML 저장·로그는 사용하지 않는다.

`PUBLIC_READ_SUPPORTED`는 URL/provider에 대한 네트워크 없는 사전 판정이다. 로그인 필요 Form은 실제 inspection에서 실패한다. 공개 HTML은 공식 Forms API 계약이 아니며 Google DOM 변경 시 명시적 오류가 날 수 있다. 복수 페이지와 조건부 분기의 전체 의미는 지원하지 않는다.
