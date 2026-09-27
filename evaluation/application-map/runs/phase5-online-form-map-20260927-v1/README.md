# Phase 5-2 ONLINE_FORM 매핑 계약

- Issue: [#51 / skn-27](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team/issues/51)
- 기준 canonical main: 928d9e609f2ba32fe0e0e18c8abf48ba538008cd (작업 시작 시 upstream fetch)
- Phase 5-1: PR #50 병합 후 FILE projection을 유지한다.
- 목표: 별도 ONLINE_FORM 계약을 공식 문항 projection으로 검증하고 mapping과 현재 작성 능력을 분리한다.

## 계약과 실행 경계

| 책임 | FILE | ONLINE_FORM |
|---|---|---|
| 지도 | 기존 DocumentMap/snapshot | ApplicationOnlineFormMap |
| 입력 참조 | native targetId, box | confirmed controlId, box 없음 |
| 공유 | ApplicationFieldMapping 공식 identity/status/label/required | 동일 |
| mapped | MAPPED + binding 존재 | 동일 |
| autoFillSupported | FILE binding의 현재 편집 경로 지원 | false |
| writable | mapped && autoFillSupported | false |
| 실행 | DocumentMap → bindings/scope → WritePlan → native editor → verification | 없음 |

ApplicationDocumentService와 기존 writableFacts/unfilledAnswers/필수 누락/NO_WRITABLE_INPUT 경로는 수정하지 않는다.
DocumentMap, NativeTarget, WritePlan, mapVersion, pipelineVersion, DB schema, MCP contract는 변경하지 않는다.
새 의존성, interface, registry, adapter 또는 provider 계층은 없다.
Binding은 단일 concrete class에 sourceType를 추가한다. targetId/box 생성자와 FILE 기본값을 보존하고
referenceId는 같은 값의 읽기 전용 별칭이다. 상위 projection을 DB나 HTTP에 새로 직렬화하지 않는다.

## FormMap schema 및 validation

schemaVersion=1, formId, controls[{fieldId, controlId, label, required}].
schemaVersion, 빈 form/control/field/label, 중복 controlId와 중복 fieldId를 거절한다.
projection에서 Manifest에 없는 fieldId와 required 충돌을 거절한다.
공식 문항 순서와 label/required는 Manifest authority를 따른다.
필수 control 누락은 REQUIRED_MAPPING_MISSING, 선택 누락은 UNMAPPED다.

한 문항의 복수 control은 현재 분할 입력·대체 입력·반복 입력 구분 근거가 없다.
FILE의 복수 native target 의미를 ONLINE_FORM에 가정하지 않고 명시적 검토 필요 오류로 거절한다.
새 REVIEW 상태나 실행 계층은 추가하지 않는다.

## Synthetic fixture

[synthetic-online-form-v1.json](../../fixtures/synthetic-online-form-v1.json)은 기업명, 대표자명,
사업자등록번호, 지원금 사용 목적의 sectionKey:fieldKey와 확인된 control 관계 4개를 제공한다.
ApplicationOnlineFormMapTest가 실제 JSON을 읽고 control 순서를 역순으로 투영하여 공식 문항 순서를 확인한다.
필수/선택 누락, unknown fieldId, duplicate controlId, multiple controls, schema/blank,
required 충돌, status/binding 불일치와 ONLINE_FORM box 금지도 확인한다.
5-format FILE 참조의 mapped/autoFillSupported/writable을 신규 테스트에서 확인하며 기존 Phase 5-1 테스트는 수정하지 않는다.
합성 계약·스텁 회귀를 실제 폼 연동, 문서 품질 검수 또는 사용자 검토 완료로 표현하지 않는다.

## 검증 결과

로컬 PASS: JDK 21.0.12.1 / Gradle 9.5.1 / Windows, 10개 스위트·112개 테스트, 실패·오류·skip 0.
최초 실행은 신규 fixture 테스트의 Jackson map 컬렉션 변환 컴파일 오류로 실패했다.
toList().map으로 수정한 후 전체 선택 회귀를 재실행하여 통과했다. production 컴파일 오류는 없었다.

실행 위치: backend/core-service.
명령: .\gradlew.bat test --tests '*ApplicationOnlineFormMapTest' --tests '*ApplicationFieldMappingTest' --tests '*ApplicationDocumentMappingServiceTest' --tests '*ApplicationPreparationApiIntegrationTest' --tests '*ApplicationDocumentBoundaryContractTest' --tests '*ApplicationPreparationArchitectureTest' --tests '*ApplicationDocumentMappingChangeTest' --tests '*ApplicationDocumentMcpClientTest' --tests '*ApplicationDocumentEditorTest' --tests '*ApplicationHwpPlanTest' --no-daemon

JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\nonexistent-gradle-unix-socket-directory는
기존 Windows JDK loopback 대응을 해당 검증 프로세스에만 적용했다.

| 스위트 | PASS |
|---|---:|
| ApplicationOnlineFormMapTest | 13 |
| ApplicationFieldMappingTest (기존 테스트 변경 없음) | 11 |
| ApplicationDocumentMappingServiceTest | 15 |
| ApplicationPreparationApiIntegrationTest | 35 |
| ApplicationDocumentBoundaryContractTest | 2 |
| ApplicationPreparationArchitectureTest | 1 |
| ApplicationDocumentMappingChangeTest | 3 |
| ApplicationDocumentMcpClientTest | 12 |
| ApplicationDocumentEditorTest | 15 |
| ApplicationHwpPlanTest | 5 |

synthetic FormMap 4문항은 모두 MAPPED/mapped=true/autoFillSupported=false/writable=false다.
5-format projection은 신규 5개와 기존 5개 parameterized case에서 통과했다.
FILE 생성·에러·native 편집 회귀는 기존 Service/API/Editor/MCP client/HWP plan 테스트 범위다.
API integration은 실제 mysql:8.4 Testcontainers를 사용하나 외부 AI/MCP HTTP는 스텁이다.
실제 외부 MCP 서버, 유료 OpenAI, 온라인 폼 접근·입력·제출과 사람의 렌더 품질 검수는 NOT_RUN이다.
AI production/계약 변경이 없어 무료 AI 회귀를 로컬에서 반복하지 않았으며 전체 CI 범위로 남긴다.
구조·문서 링크와 git diff --check PASS. 파일 이동·삭제 없음.
SKN27_FAILURES: 최종 로컬 선택 회귀 0.
PATCH_REGRESSION: 최종 로컬 선택 회귀 0 (전체 원격 결과는 push 이후 별도 판단).
최종 커밋 push 이후 원격 CI 결과는 별도 확인하며 미실행·실패·skip은 통과로 보고하지 않는다.
전체 Core clean build와 MySQL 8.4 전체 통합, AI 전체 검증은 .github/workflows/ci.yml의 push CI 범위다.

## Baseline 구분

최신 canonical main 928d9e6의 [GovBiz CI](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team/actions/runs/36314911770)는 실패했다.
[Core 로그](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team/actions/runs/36314911770/job/108607684339)에서
AccountPasswordResetFlowIntegrationTest.concurrentRequestsCannotReuseTheSamePasswordResetToken의
AssertionError(:139)를 확인했다. 1,589개 실행, 실패 1·skip 2다. 이 baseline 문제는 수정하지 않는다.
같은 최신 run에서 AI Service/Web/shared/Mobile은 PASS, Container integration은 SKIPPED다.
이전 AI 모델 기대치 실패는 최신 run에서 확인되지 않았으므로 현재 baseline 실패로 계상하지 않는다.
CANONICAL_MAIN_FAILURES: Core 1개, AI 0개 (위 최신 SHA의 원격 실행).
이전 Phase 5-1 보고서의 실패를 최신 main의 실측 결과로 복사하지 않는다.
CANONICAL_MAIN_FAILURE와 PATCH_REGRESSION은 최신 실행 근거별로 구분한다.

## 미구현 범위 및 후속 후보

FormMap contract만 구현한다. 외부 API/OAuth, 브라우저/DOM/selector, 자동 작성, submit,
persistence/DB migration, Controller/public DTO/frontend API, AI Service/MCP 변경은 없다.
기존 Manifest는 공식 FILE 첨부 identity를 계속 가진다. 이 단계는 해당 Manifest의 공식 문항을 이용한
synthetic projection 검증이며 ONLINE_FORM source discovery/manifest 수집까지 구현한 것이 아니다.
후속 후보는 실제 source identity 확인, control의 복수/required 의미 검토, 사용자 Fact·검토 흐름 연결이다.
writer와 안전한 사용자 실행 계약을 실제 구현하기 전 ONLINE_FORM을 writable로 올리지 않는다.

PR: NOT_CREATED
MERGE: NOT_RUN
