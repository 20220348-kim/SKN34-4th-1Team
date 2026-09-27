# Phase 6-1 온라인 신청 입력 도우미

판정: PHASE6_ONLINE_INPUT_HELPER_READY (답변 준비·복사·TXT 및 관련 회귀 검증 완료).
전체 필수 CI 완료 판정과는 별개다. Core clean build는 아래 canonical 기존 실패로 실패했고 Container integration은 건너뛰어졌다.
Issue #58 [skn-30], 기존 브랜치와 1 logical commit을 유지한다.
Canonical main: `3a4afe79837bff8a965efbc087ea32ebc20a6730`.

## Before / After와 의미

| 집계 | 이전 | 수정 후 합성 fixture |
|---|---:|---:|
| Total | 8 | 8 |
| Ready | 0 | 5 |
| Needs review | 1 | 1 |
| Missing | 2 | 2 |
| Direct input | 5 | 0 |
| Saved answers | 5 | 5 |

이전에는 유효한 PROVIDED Fact 5개를 savedAnswers에서 복사할 수 있었지만 외부 control mapping 부재 때문에 DIRECT_INPUT/copyable=false로 표시했다.
수정 후 answer readiness ≠ external form mapping readiness다.
READY는 현재 사용자가 복사할 확정 답변의 준비 상태다. 외부 자동 입력 가능 여부를 뜻하지 않는다.
PROVIDED + answer 존재 + 공식 options 검증 통과(또는 options 없음)는 READY/copyable=true다.
공식 선택지 불일치는 NEEDS_REVIEW/copyable=false, 답변 없음/UNKNOWN Fact는 MISSING/copyable=false다.
DIRECT_INPUT은 복사 답변으로 해결할 수 없는 신뢰할 타입이 확인된 경우의 상태이며, 현재 Manifest에는 해당 타입 정보가 없으므로 추측해서 생성하지 않는다.
`inputMode=UNKNOWN`과 READY는 함께 가능하다. `externalMappingVerified=false`는 독립적으로 외부 매핑 미확인을 표현한다.
공식 신청 URL과 mapping snapshot 부재는 답변 READY의 blocker가 아니다.

## Architecture / data authority

HTTP Controller → ApplicationPreparationService → 소유 Preparation / 고정 Form / 현재 Input Fact Repository → Result → Response → Shared DTO → Web.
REPEATABLE_READ 읽기 전용 transaction에서 revision과 Fact를 함께 읽는다.
Manifest가 field identity/label/required/options를 소유하며 현재 PROVIDED Fact만 답변으로 사용한다.
낮은 revision의 현재 Fact도 삭제되지 않은 값이면 포함한다. AI 제안·생성 본문·label 추측·placeholder는 포함하지 않는다.
쓰기/외부 HTTP/AI/MCP 호출, DB schema 변경, FILE/Phase 5 pipeline 변경은 없다.

## Copy / TXT / UI

헤드라인은 `준비된 답변 5 / 8`이다. 외부 입력 방식과 문항 위치 미확인은 별도 안내다.
개별 버튼은 item.status=READY + copyable + answer 존재일 때만 표시하며 item.answer를 복사한다.
READY + UNKNOWN에는 외부 문항을 확인해 붙여넣으라는 안내를 표시한다.
NEEDS_REVIEW에는 공식 options와 불일치 안내, MISSING에는 기존 입력 영역 안내, DIRECT_INPUT에는 직접 처리 필요를 표시한다.
새 editor는 추가하지 않는다.
savedAnswers는 READY field와 정확히 일치하며 Shared 응답 검증이 집계/ID/label/answer/copyable/options 일관성을 검사한다.
개별 답변은 그대로 복사한다. 전체 복사와 TXT는 savedAnswers의 `Q. 질문\nA. 답변` 블록을 빈 줄로 연결하고 Manifest 순서를 유지한다.
NEEDS_REVIEW/MISSING/DIRECT_INPUT은 제외한다.
Clipboard API 성공/실패 안내는 유지한다. TXT는 UTF-8 BOM text/plain;charset=utf-8, application-answers-{preparationId}.txt다.
Blob은 브라우저에서 만들며 서버 저장이나 외부 전송은 없다.

## Synthetic fixture

`../../fixtures/synthetic-online-input-guide-v1.json`: 모든 값은 합성 데이터다.
기업명/대표자명/사업자등록번호/지원동기/공식 선택지와 일치하는 업종 5개가 READY다.
지원 분야 문자열 `AI\\nSaaS`는 하나의 공식 option과 일치하지 않으므로 NEEDS_REVIEW다. 구분자를 추측하지 않는다.
사업계획서 label만으로 FILE 타입을 추측하지 않으며 null 답변 2개는 MISSING이다.
Core 테스트는 동일 fixture로 Manifest/PROVIDED Fact를 구성해 실제 projection의 8/5/1/2/0 집계와 savedAnswers ID 동등성을 확인한다.

## 이번 보완의 로컬 검증 (2026-09-28)

| 검증 | 명령 / 결과 |
|---|---|
| Web 전체 | `pnpm --filter govbiz-web test`: 103 files, 1303 tests 통과 (jsdom/stub) |
| Web lint / 타입 | `pnpm --filter govbiz-web lint`, `pnpm --filter govbiz-web exec tsc -b`: 통과 |
| Shared 전체 | `pnpm --filter @govbiz/shared test`: 4 files, 28 tests 통과 |
| Shared 타입 / lint | `pnpm --filter @govbiz/shared typecheck`, `pnpm --filter @govbiz/shared lint`: 통과 |
| FILE Python | AI service에서 `uv run --locked --extra dev python -m pytest tests/application_preparation/test_document.py tests/application_preparation/test_docx_adapter.py tests/application_preparation/test_xlsx_adapter.py tests/application_preparation/test_pdf_form_detection.py --basetemp=.pytest-phase6 --tb=short -q`: 106개 통과 |
| Core 선택 | JDK 21 `gradlew test --tests '*ApplicationOnlineInputGuideTest'` 및 Phase 5/Architecture/FILE 관련 선택 패턴: 실행 전 loopback 오류로 미실행 |
| Controller 실제 MySQL | 기존 ApplicationPreparationApiIntegrationTest에 저장 전 MISSING 및 저장 후 READY/copyable/UNKNOWN/외부 매핑 false, owner/401/404/no-store/읽기 불변 검증. 검증 코드 SHA 0dcf073의 실제 MySQL 8.4 CI에서 해당 범위 실패 없음 |
| Phase 5 | ApplicationFieldMappingTest, ApplicationOnlineFormMapTest, ApplicationOnlineFormSourceTest, ApplicationPreparationServiceOnlineFormTest, ApplicationOnlineFormSourceReferenceTest: 검증 코드 SHA 0dcf073의 실제 MySQL 8.4 CI에서 해당 범위 실패 없음 |
| Architecture | ApplicationPreparationArchitectureTest, ApplicationDocumentBoundaryContractTest: 검증 코드 SHA 0dcf073의 실제 MySQL 8.4 CI에서 해당 범위 실패 없음 |
| FILE Core HWP/HWPX/PDF/DOCX/XLSX | 기존 writer/document suite: 검증 코드 SHA 0dcf073의 실제 MySQL 8.4 CI에서 해당 범위 실패 없음 |
| 개별/전체 복사 및 TXT | Web jsdom 테스트 통과. BOM 실제 3 bytes EF BB BF / filename / 동일 payload 확인. 실제 외부 사이트 사용은 미검증 |
| git diff --check | 통과, 최종 커밋에서도 재확인 |

Shared 첫 실행에서 MISSING 테스트 fixture의 copyable을 true로 바꾼 오류를 PATCH_REGRESSION으로 수정했다. 영향 범위 Shared 전체 재검증은 통과했다.
Core는 JVM IPv4/임시 경로 옵션을 추가해도 PipeImpl/UnixDomainSockets `Invalid argument: connect`로 실행 전에 실패했다. production 설정은 수정하지 않았다.
로컬 선택 검증을 실제 MySQL/전체 CI 완료로 보고하지 않는다.

## Baseline / CI

Canonical main SHA 3a4afe79837bff8a965efbc087ea32ebc20a6730의 실제 CI 로그를 이번 실행에서 다시 확인했다.
CANONICAL_MAIN_FAILURES: AccountPasswordResetFlowIntegrationTest.concurrentRequestsCannotReuseTheSamePasswordResetToken(), assertion line 139.
Canonical Core: 1617 tests completed, 1 failed, 2 skipped.
https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team/actions/runs/36335923576/job/108666631099
현재 작업에서 해당 실패나 skn-13의 미커밋 변경은 수정하지 않는다.
PATCH_REGRESSION: Shared 테스트 fixture 오류 수정 완료.
첫 push c1bd2dc90829a905f5dadd84f1b5471766f74062의 Core compileTestKotlin에서 Jackson 3 JsonNode.map과 Kotlin 컬렉션 map의 충돌이 발견됐다.
합성 fixture 테스트에서 JsonNode를 toList()로 변환 후 map/filter하도록 수정했다. production 코드의 컴파일은 통과했다.
첫 push의 Web/Shared 전체 test/lint/build 및 Mobile은 통과했다.
https://github.com/20220348-kim/SKN34-4th-1Team/actions/runs/36339377452
수정 후 0dcf073의 Core CI에서 신규 회귀 없음. 전체 실패 1개는 위 canonical baseline과 동일하다.
`.github/workflows/ci.yml`의 push 이벤트는 Core clean build/실제 MySQL 8.4, Web/Shared 전체 검사, AI 및 Container 검증을 실행한다.
## 의미 수정 후 원격 CI 결과

검증 코드 SHA: `0dcf073ac80ce718d81478b643d5f537f1e9d1e8`.
https://github.com/20220348-kim/SKN34-4th-1Team/actions/runs/36339544167
- Core: 1622 tests completed, 1 failed, 2 skipped. 1619개 통과.
- 유일한 실패: AccountPasswordResetFlowIntegrationTest.concurrentRequestsCannotReuseTheSamePasswordResetToken(), assertion line 139. CANONICAL_MAIN_FAILURE다.
- 새 PROVIDED/valid option READY, invalid option, MISSING, UNKNOWN+READY, savedAnswers 동등성, fixture 8/5/1/2/0, Controller 계약 및 ownership 테스트에 실패 없음.
- Phase 5, ApplicationPreparationArchitectureTest, ApplicationDocumentBoundaryContractTest 및 기존 FILE 5포맷 writer/document 회귀에 실패 없음.
- 조건부 DocxRealHttpIntegrationTest/XlsxRealHttpIntegrationTest는 DOCX_HTTP_E2E/XLSX_HTTP_E2E 설정이 없어 건너뛴다. 실제 HTTP E2E 두 개를 통과로 보고하지 않는다.
- Web/Shared 전체 test/lint/type/build, Mobile, AI Service 성공.
- Catalog separation, LLMOps, GovBiz Ops, Infra CI 성공.
- Core clean build 전체는 실패이며 Container integration은 skipped다. 전체 필수 CI 통과나 배포 완료를 주장하지 않는다.
- PATCH_REGRESSION: 최초 Shared 기대값 및 Jackson fixture map 컴파일 오류 수정 후 검증 코드에서 신규 실패 없음.

이 최종 결과 반영은 보고서만 바꾸며 위 SHA의 실행 코드·설정·테스트는 그대로다.
보고서 반영 최종 SHA의 CI 실행 상태는 최종 대화에서 별도로 보고한다. 이전 코드 SHA의 결과를 새 SHA의 CI 통과로 간주하지 않는다.

## External integration / limitations

Official application URL acquisition: NOT_IMPLEMENTED (`officialApplicationUrl=null`)
External control mapping persistence: NOT_IMPLEMENTED (`externalMappingVerified=false`)
Google Forms API: NOT_USED
Google OAuth Forms scope: NOT_USED
Google prefill: NOT_IMPLEMENTED
External DOM automation: NOT_IMPLEMENTED
Auto submit: NOT_IMPLEMENTED
DB schema change: NONE
AI Service production change: NONE
MCP change: NONE

공고 sourceUrl을 공식 신청 URL로 재사용하지 않는다. HTTP(S)/자격증명 없는 URL과 noopener noreferrer 링크 계약은 유지한다.
실제 외부 입력/선택/업로드/기관 제출, 유료 API 평가 및 이번 수정 후 실제 Chrome 수동 복사는 실행하지 않았다.
기존 보완 전 Chrome 합성 fixture 검증은 이전 실행의 증거이며 이번 READY 변경의 브라우저 검증으로 재사용하지 않는다.
PR: NOT_CREATED, Draft PR: NOT_CREATED, merge: NOT_RUN, main push: NOT_RUN.
