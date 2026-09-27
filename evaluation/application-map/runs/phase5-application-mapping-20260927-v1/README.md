# Phase 5-1 신청 문항 상위 매핑 경계

- Issue: #44 [skn-24]
- 기준: canonical main `4de4d90e868d102ea052a70d25e13ace48d0ad67`
- 현재 상태: 구현 및 로컬 필수 검증 통과. 최종 커밋의 원격 CI는 push 후 별도 확인한다. PR/merge는 수행하지 않는다.

## 현재 구조와 책임

공식 문항은 `ApplicationFormManifest.sections`의 `ApplicationFormFieldDefinition`이 소유한다.
문항 ID는 `sectionKey:fieldKey`이며 `ApplicationDocumentPlacement.factId`와 같다.
`application_form_snapshot.manifest_json`은 sections와 documentMapSnapshot을 함께 보존한다.
후자는 bindings, scopeTargetIds, sourceSha256, mapVersion, pipelineVersion, engineVersion과 raw DocumentMap을 소유한다.
`mappingChanges`는 binding target/box, native kind/position과 scope 변경을 비교하고 기존 승인 흐름이 유지된다.

```text
공식 첨부 → AI DocumentMap/Mapping → Core 검증 → manifest_json
                                                       ↓
manifest.sections + snapshot.bindings → fieldMappings → ApplicationDocumentService
                                                       ↓
                                     기입/미기입 답변 분리
snapshot.DocumentMap/bindings/scope → WritePlan → native editor → verification → 저장
```

## 추가 모델과 필요성

`ApplicationFieldMapping`은 문항별 업무 관계를 나타내며 fieldId, label, required, status, bindings만 가진다.
writable은 MAPPED이며 binding이 존재할 때 true다. `ApplicationFieldBinding`은 targetId/box 참조만 담는다.
새 projection 함수는 공식 문항 순서와 한 문항의 복수 입력 위치를 유지한다.
문서 생성 Service가 raw 파일 구조를 이해하지 않고 기입/미기입 답변을 판단하는 실제 production 소비자다.
필수 연결 누락은 성공으로 표시하지 않고 기존 오류 코드로 중단한다.

DocumentMap을 대체하지 않는다. 상위 모델에는 raw DocumentMap/nativeLocator/NativeTarget/pageImages/OOXML/
workbookMetadata/버전/scope가 없다. 기존 binding과 scope를 원본 snapshot에서 생성 요청과 편집기에 전달한다.
파일 주소 검증, 원본 hash, WritePlan validation, planHash 및 native verification authority는 기존 경계에 남는다.

## FILE projection 예시

```text
company:name / 기업명 / required=true
  binding: docx:t:1:r:1:c:2:p:1
  → MAPPED / writable=true / targetId 참조 1개
company:consent / 동의 / required=false
  binding: 없음
  → UNMAPPED / writable=false
필수 문항 + binding 없음 → REQUIRED_MAPPING_MISSING / writable=false → 생성 422
PDF binding의 box와 한 문항의 복수 target은 참조로 그대로 유지한다.
```

## ONLINE_FORM 확장 위치와 미구현 범위

후속 `ApplicationPreparationService → 별도 FormMap → 상위 문항 관계 → 사용자 검토` 경로에서
field identity, confirmed fact mapping, writable/unmapped 상태와 사용자 검토 의미를 공유할 수 있다.
FILE의 DocumentMap/NativeTarget/WritePlan/native editor는 공유하지 않는다.
현재 ONLINE_FORM production 모델/provider/registry/enum/adapter, Google Forms API, OAuth,
브라우저 자동화와 제출 자동화는 구현하지 않았다. 외부 API/유료 모델 호출도 이 작업에서 하지 않는다.
기존 저장 JSON으로 계산하므로 DB migration, 새 테이블과 column은 없다.

## 변경 파일

- `backend/core-service/src/main/kotlin/ai/govbiz/core/applicationpreparation/domain/ApplicationFieldMapping.kt`: 업무 projection.
- `backend/core-service/src/main/kotlin/ai/govbiz/core/applicationpreparation/service/ApplicationDocumentService.kt`: production 소비.
- `backend/core-service/src/test/kotlin/ai/govbiz/core/applicationpreparation/domain/ApplicationFieldMappingTest.kt`: 6개 요구 사례와 공식 순서.
- `backend/core-service/src/test/kotlin/ai/govbiz/core/applicationpreparation/controller/ApplicationPreparationApiIntegrationTest.kt`: cached required binding 누락 오류 추가.
- `docs/architecture.md`, `docs/application-document-mcp-architecture.md`, `backend/core-service/README.md`: 상위/파일 경계 및 후속 seam.
- 이 평가 보고서. AI Service 및 기존 FILE domain 계약 파일은 변경하지 않는다.

## 검증

### 로컬 Core: PASS

JDK 21.0.12, Gradle 9.5.1에서 다음 선택 테스트를 실행했다.

```powershell
$env:JAVA_TOOL_OPTIONS = '-Djdk.net.unixdomain.tmpdir=C:\nonexistent-gradle-unix-socket-directory'
.\gradlew.bat test --tests '*ApplicationFieldMappingTest' --tests '*ApplicationPreparationArchitectureTest' --tests '*ApplicationDocumentBoundaryContractTest' --tests '*ApplicationDocumentMappingServiceTest' --tests '*ApplicationDocumentMappingChangeTest' --tests '*ApplicationDocumentMcpClientTest' --tests '*ApplicationDocumentEditorTest' --tests '*ApplicationFormAvailabilityIntegrationTest' --tests '*ApplicationPreparationApiIntegrationTest' --no-daemon
```

| 스위트 | 통과 |
|---|---:|
| ApplicationFieldMappingTest | 11 |
| ApplicationPreparationArchitectureTest | 1 |
| ApplicationDocumentBoundaryContractTest | 2 |
| ApplicationDocumentMappingServiceTest | 15 |
| ApplicationDocumentMappingChangeTest | 3 |
| ApplicationDocumentMcpClientTest | 12 |
| ApplicationDocumentEditorTest | 15 |
| ApplicationFormAvailabilityIntegrationTest | 13 |
| ApplicationPreparationApiIntegrationTest | 35 |
| 합계 | 107 |

9개 스위트, 실패/오류/skip 0. 통합 48개는 실제 `mysql:8.4` Testcontainers를 사용했다.
외부 AI/공식 첨부 응답은 스텁이며 실제 OpenAI·제공처 호출이나 사용자 문서 품질 평가는 아니다.
Windows JDK의 Unix-domain socket connect 오류로 첫 Gradle 실행은 테스트 전 중단됐다.
프로세스 한정 임시 경로로 JDK가 TCP loopback 경로를 사용하게 한 후 성공했다. production 설정 변경은 없다.

### 기존 5포맷 회귀: PASS (자동 계약/fixture 범위)

Python 3.12.10의 잠금된 dev 의존성에서 다음을 실행했다.

```text
uv run --locked --extra dev python -m pytest tests/application_preparation/test_document.py tests/application_preparation/test_docx_adapter.py tests/application_preparation/test_xlsx_adapter.py tests/application_preparation/test_pdf_form_detection.py
uv run --locked --extra dev python -m pytest tests/application_preparation/test_docx_adapter.py tests/application_preparation/test_xlsx_adapter.py --lf --basetemp=.venv/phase5-adapter-tmp --tb=short
uv run --locked --extra dev python -m pytest tests/test_document_mcp_contract.py --basetemp=.venv/phase5-contract-tmp --tb=short
```

첫 실행 40개 통과, 66개는 기존 공용 pytest 임시 디렉터리 권한 오류로 setup 실패했다.
격리된 worktree 임시 경로에서 실패한 66개만 재실행해 모두 통과했다(기통과 1개 deselected).
공통 DocumentMap/NativeTarget/WritePlan/MCP 계약 테스트 87개도 통과했다. 최종 고유 193개 통과.
DOCX/XLSX는 synthetic OOXML 작성·재열기·보존 검증, HWP/HWPX/PDF는 Core fixture와 AI stub/native 계약 범위다.
실제 Hangeul/PDF MCP 서버, FFDetr 가중치 실행·사람 렌더 검수·실제 신청 제출은 NOT_RUN이다.

### 변경·참조 검증: PASS

`git diff --check`와 최종 코드 검토, 문서 상대 경로/heading 참조를 확인했다.
DocumentMap, NativeTarget, WritePlan, mapVersion, pipelineVersion, engineVersion, DB schema 및 AI Service 코드 변경 없음.
새 production 의존성/Provider/registry/ONLINE_FORM 구현 없음. 파일 이동·삭제 없음.

### 원격 CI / Core 전체 build

로컬 전체 `clean build`는 NOT_RUN이며 repository 규칙에 따라 CI에 맡긴다.
최종 커밋 CI가 실제 통과하기 전에는 전체 검증 완료나 PHASE5_APPLICATION_MAPPING_READY를 선언하지 않는다.
CI 결과는 최종 전달 시 커밋 SHA와 함께 별도로 보고한다.
Core CI는 push 이벤트에서 JDK 21 `./gradlew clean build --no-daemon`을 실행하며 실제 MySQL 8.4 통합을 포함한다.
로컬 선택 테스트를 CI 전체 빌드나 실제 신청 문서 품질 검수로 취급하지 않는다.

## 최신 canonical main rebase 검증 (2026-09-27)

- 이전 기준 SHA: `4de4d90e868d102ea052a70d25e13ace48d0ad67`.
- 재조회한 최신 canonical main: `a4103e945cc3b7295761d314c0e824b602a576ad`.
- `git rebase upstream/main`: 충돌 없이 완료. Phase 5 production 코드·테스트는 이전 커밋과 동일하다.
- branch는 `skn-24`, canonical main 대비 feature commit은 1개로 유지한다.
- 기존 Account 테스트나 AI 설정·모델·테스트는 수정하지 않는다.

### rebase 후 로컬 전체 Core 검증

JDK 21.0.12와 실제 MySQL 8.4 Testcontainers에서 아래를 실행했다.
기존 Windows JDK loopback 우회는 테스트 프로세스에만 적용했다.

```powershell
$env:JAVA_TOOL_OPTIONS = '-Djdk.net.unixdomain.tmpdir=C:\nonexistent-gradle-unix-socket-directory'
.\gradlew.bat clean build --no-daemon
```

전체 1,589개: 통과 1,581, 실패 6, skip 2. 전체 build는 FAIL이며 성공으로 표시하지 않는다.
위의 필수 9개 선택 스위트 107개는 전체 실행에서 모두 PASS(실패/오류/skip 0)다.
신청 준비 기능 전체 18개 스위트는 155개 PASS, 실제 DOCX/XLSX HTTP 실행 조건이 없는 2개는 skip이다.
5-format 회귀는 ApplicationDocumentEditorTest, ApplicationDocumentMcpClientTest,
ApplicationDocumentMappingServiceTest, ApplicationHwpPlanTest, ApplicationPreparationApiIntegrationTest의
fixture/스텁·native 편집 검증 범위로 통과했다. 실제 외부 MCP 서버·유료 API·렌더 검수는 여전히 NOT_RUN이다.
AI production/lock/FILE 계약이 바뀌지 않아 이전 무료 AI 회귀 193개는 반복하지 않았다.

### 같은 환경의 canonical main baseline 비교

feature 전체 결과를 보존한 뒤, clean worktree를 최신 main detached HEAD로 잠시 전환했다.
아래 실패 관련 3개 스위트만 같은 JDK·OS·MySQL 환경에서 실행하고 `skn-24`로 복귀했다.
main branch를 수정하거나 push하지 않았다.

```text
.\gradlew.bat test --tests '*SupportProgramCatalogSyncOnceServiceTest' --tests '*SupportProgramRepositoryIntegrationTest' --tests '*AccountPasswordResetFlowIntegrationTest' --no-daemon
```

62개 실행, 56개 통과·6개 실패. feature에서 실패한 6개와 테스트명·예외 메시지가 모두 같았다.

| 실패 | canonical main | skn-24 |
|---|---|---|
| AccountPasswordResetFlowIntegrationTest.concurrentRequestsCannotReuseTheSamePasswordResetToken | 예상 200 / 실제 429 | 동일 |
| SupportProgramRepositoryIntegrationTest.oneShotSyncPreservesOtherSourcesIsIdempotentAndKeepsOldSnapshotOnIndexFailure | Windows posix:permissions 미지원 | 동일 |
| SupportProgramCatalogSyncOnceServiceTest.publishesOnceAndPersistentReceiptBlocksEverySubsequentAttempt | Windows posix:permissions 미지원 | 동일 |
| SupportProgramCatalogSyncOnceServiceTest.failedIndexKeepsReservationAndDoesNotPublishOrRetry | Windows posix:permissions 미지원 | 동일 |
| SupportProgramCatalogSyncOnceServiceTest.longUnicodeInputUsesTheSamePerDocumentTokenCeilingAsAiService | Windows posix:permissions 미지원 | 동일 |
| SupportProgramCatalogSyncOnceServiceTest.exclusiveCreationAlsoRejectsAReceiptCreatedDuringCollection | Windows posix:permissions 미지원 | 동일 |

`CANONICAL_MAIN_FAILURES=6`, `SKN24_FAILURES=6`, `PATCH_REGRESSION=0` (동일 환경에서 재현한 로컬 범위).
canonical main 전체를 로컬에서 다시 실행한 것은 아니며 실패한 3개 스위트를 비교했다.

### canonical main 원격 CI 근거

[canonical GovBiz CI](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team/actions/runs/36311466690):
Core 1,577개 중 비밀번호 재설정 동시성 실패 1개·skip 2개, AI 1,514개 통과·기본 모델 기대치 불일치 1개 실패.
AI는 expected `gpt-5.6-luna` / actual `gpt-6-luna`이며 해당 파일은 이번 feature에서 변경하지 않았다.
Web/shared와 Mobile은 PASS, Container integration은 선행 CI 실패로 SKIPPED다.
Linux CI에는 Windows POSIX 미지원 실패가 없으므로 로컬/원격 실패 수를 섞어 비교하지 않는다.

최종 feature SHA의 새 CI 상태는 push 후 최종 전달에서 별도로 보고한다.
Phase 5 관련 검증과 patch regression 0은 전체 CI 성공·배포·실제 문서 품질 검수 완료를 뜻하지 않는다.
