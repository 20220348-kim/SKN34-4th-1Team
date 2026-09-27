# Phase 5-3 ONLINE_FORM source review 평가

Issue #51 [skn-27], 기존 Phase 5-2 계약에 읽기 전용 Service 검토 경로를 추가한다.
이전 base: 928d9e609f2ba32fe0e0e18c8abf48ba538008cd.
최신 canonical main: 82baae46ad79208c8e8dde1861c39e30858a7ae8 (upstream fetch 후 rebase).
[Phase 5-2 보고서](../phase5-online-form-map-20260927-v1/README.md)는 보존한다.

## 구현과 정책

Phase 5-2 FormMap과 source snapshot은 서로 다른 계약이다.
[Source fixture](../../fixtures/synthetic-online-form-source-v1.json)는 source 의미 정보와 미대응 동의 문항을 담는다.
[FormMap fixture](../../fixtures/synthetic-online-form-v1.json)는 확인된 field/control 관계다.
Source schemaVersion/formId/formTitle/controls의 validation과 deterministic matching은 Domain에 둔다.
FormMap은 confirmed fieldId/controlId/label/required만 소유하고 기존 fieldMappings projection을 재사용한다.

공백만 정규화(Unicode whitespace, 줄바꿈/탭/연속 공백 → 한 칸, trim)한다.
양쪽 label이 유일하고 required가 같으면 MAPPED다. case·숫자·괄호·단어는 유지한다.
부분문자열·fuzzy·embedding·LLM은 없다.
복수 source candidate 또는 복수 Manifest label은 AMBIGUOUS_CONTROL로 임의 선택하지 않는다.
필수 여부 충돌은 REQUIRED_FLAG_MISMATCH다. required missing은 REQUIRED_CONTROL_NOT_FOUND와
REQUIRED_MAPPING_MISSING, optional missing은 issue 없이 UNMAPPED다.
무관한 source는 UNMATCHED_SOURCE_CONTROL로 표시하되 정상 매핑을 막지 않는다.

Service는 findOwned → 고정 Manifest 조회 → domain matching → projection → Review Result 순서다.
Result의 mapped/unmapped/requiredMissing은 문항 수, reviewRequired는 issue 수다.
미매핑 수에는 requiredMissing이 포함된다. 충돌 candidate는 unmatched로 중복 계산하지 않는다.
본인/없는/다른 소유자 preparation, 반복 계산 결과, Fact/content/revision 및 snapshot 불변을 테스트한다.
DB write 및 외부 호출 없는 경로를 Mockito 호출 검증으로도 확인한다.

## 회귀와 미구현 범위

FILE DocumentMap → native binding → WritePlan → native editor → verification는 수정하지 않는다.
HWP/HWPX/PDF/DOCX/XLSX FILE의 mapped/autoFillSupported/writable=true 계약을 회귀 검증한다.
ONLINE_FORM은 confirmed mapping도 mapped=true, autoFillSupported=false, writable=false다.
DocumentMap, NativeTarget, WritePlan, sourceSha256, mapVersion, pipelineVersion, engineVersion,
bindings, scopeTargetIds, DB schema, AI Service, MCP contract는 변경하지 않는다.
외부 provider/collector, HTTP DTO/endpoint, persistence, browser automation, autofill, submit은 미구현이다.
후속 단계는 실제 수집 경계의 의미 정보 확인 후 별도로 설계한다. 새 provider abstraction은 없다.
합성 fixture·mock·자동 검증을 실제 사이트 연동이나 사람 품질 검수로 해석하지 않는다.

## 실행 결과

로컬: JDK 21.0.12.1 / Gradle 9.5.1 / Windows, 12개 스위트·123개 테스트 PASS.
실패·오류·skip 0. ApplicationPreparationApiIntegrationTest는 실제 MySQL 8.4 및 Redis Testcontainers로 실행했다.
최초 실행은 신규 테스트의 ai 변수와 package 이름 충돌로 컴파일 실패했다. import로 수정 후 재실행하여 통과했다.
production 매칭 및 Service 실패는 없었다.

실행 위치: backend/core-service.
```powershell
$env:JAVA_TOOL_OPTIONS='-Djdk.net.unixdomain.tmpdir=C:\nonexistent-gradle-unix-socket-directory'
.\gradlew.bat test --tests '*ApplicationOnlineFormSourceTest' --tests '*ApplicationOnlineFormMapTest' --tests '*ApplicationFieldMappingTest' --tests '*ApplicationPreparationServiceOnlineFormTest' --tests '*ApplicationPreparationApiIntegrationTest' --tests '*ApplicationPreparationArchitectureTest' --tests '*ApplicationDocumentBoundaryContractTest' --tests '*ApplicationDocumentMappingServiceTest' --tests '*ApplicationDocumentMappingChangeTest' --tests '*ApplicationDocumentMcpClientTest' --tests '*ApplicationDocumentEditorTest' --tests '*ApplicationHwpPlanTest' --no-daemon
```
JAVA_TOOL_OPTIONS는 기존 Windows JDK loopback 대응을 검증 프로세스에만 적용했다.

| 스위트 | 테스트 | 결과 |
|---|---:|---|
| ApplicationOnlineFormSourceTest | 8 | PASS |
| ApplicationOnlineFormMapTest | 13 | PASS |
| ApplicationFieldMappingTest | 11 | PASS |
| ApplicationPreparationServiceOnlineFormTest | 2 | PASS (mock 호출 경계) |
| ApplicationPreparationApiIntegrationTest | 36 | PASS (실제 MySQL/Redis) |
| ApplicationPreparationArchitectureTest | 1 | PASS |
| ApplicationDocumentBoundaryContractTest | 2 | PASS |
| ApplicationDocumentMappingServiceTest | 15 | PASS |
| ApplicationDocumentMappingChangeTest | 3 | PASS |
| ApplicationDocumentMcpClientTest | 12 | PASS (stub) |
| ApplicationDocumentEditorTest | 15 | PASS |
| ApplicationHwpPlanTest | 5 | PASS |

5-format FILE 확인은 기존 projection과 editor/계약 회귀 검증 범위이며 실제 사이트나 5종 문서의 사람 품질 검수를 뜻하지 않는다.
문서 참조·두 fixture JSON 구문 및 git diff --check도 확인한다.
전체 clean build와 AI/Web/Shared/Mobile/Container 전체 검증은 push 후 최신 SHA의 CI 결과로 별도 판단한다.
GovBiz CI는 push 이벤트에 branch/path 제한이 없어 skn-27 push가 검증 대상이다.

CANONICAL_MAIN_FAILURE: canonical main 82baae46의
[GovBiz CI](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team/actions/runs/36317389018)에서
AccountPasswordResetFlowIntegrationTest.concurrentRequestsCannotReuseTheSamePasswordResetToken 실패를 확인했다.
1589 tests, 1 failed, 2 skipped. AI Service/Web and shared/Mobile는 성공, Container integration은 skipped였다.
해당 계정 테스트는 변경하지 않았다. PATCH_REGRESSION은 로컬 선택 검증에서 0이며 원격 결과는 push 후 확인한다.
