# XLSX 1차 구현·검증 — skn-17

**판정: XLSX_1ST_PASS / 전체 XLSX 상태 PARTIAL.** 공식 표본 2개의 16개 Ground Truth 필드에서 후보 coverage 100%, OpenAI Mapping Correct 16, Wrong 0, Unmapped 0을 확인했다. 문서당 1회, 총 2회만 호출했다. 각각 5개 dummy 값을 별도 작성본에 기입했고 원본 불변·재열기·보존 검증이 통과했다. 실제 Core HTTP→AI HTTP→MySQL→다운로드도 통과했다. Excel UI 검증과 공식 수식 표본 검증은 남아 있고 전체 회귀의 기존 실패를 숨기지 않는다.

## 1. XLSX 기술

- parser: openpyxl 3.1.5, Python 3.12.10.
- writer: openpyxl의 값 직렬화 결과에서 승인 셀의 값만 원본 worksheet XML에 반영. 다른 ZIP 파트는 바이트 그대로 보존한다.
- engineVersion: `govbiz/xlsx-native@1+openpyxl-3.1.5`.
- 의존성: openpyxl 및 et-xmlfile만 추가했다. 다른 잠금 의존성 버전은 바꾸지 않았다.
- [openpyxl 공식 안내](https://openpyxl.readthedocs.io/en/3.1/tutorial.html)는 전체 저장 시 일부 도형 보존의 한계를 설명한다. 전체 저장본을 결과로 사용하지 않는 이유다. 복잡한 object는 미지원으로 거절한다.

## 2. NativeTarget

ID는 `xlsx:s:{URL-encoded sheetName}:c:{cellAddress}`다. 예: `xlsx:s:Sheet1:c:B4`.
sheetName, cellAddress, row, column, value, displayValue, dataType/cellType, numberFormat, formula, mergedMaster/Range, hidden, protected, locked, editable, fieldLabels/rowLabels/columnLabels/tableHeadings, sectionPath, dataValidation을 기록한다.
displayValue는 raw 문자열이며 Excel의 실제 렌더 표시값으로 주장하지 않는다. 규칙 적용 범위(sqref)는 sourceRange, option source 표현은 formula1이다.

## 3. 지원 구조

| 구조 | 상태 | 확인 범위 |
|---|---|---|
| Basic Cell Form | STABLE | 공식 두 표본의 대표 입력칸 |
| Merged Cell | STABLE | 공식 master 작성 및 child 거절, 보존 검증 |
| Formula Preservation | PARTIAL | 합성 수식 보호·비손상 테스트. 공식 표본에는 수식 없음 |
| Data Validation / Dropdown | PARTIAL | 공식 inline list, 합성 range/named range. dynamic/non-list 규칙 미지원 |
| Hidden Sheet/Row/Column | NOT_FULLY_TESTED | 합성 hidden/veryHidden·row·column/group·hidden label 배제 |
| Protected Cell | NOT_FULLY_TESTED | 합성 workbook 보호·sheet locked/unlocked |
| Complex Workbook | UNSUPPORTED | macro, 외부 계산 링크, drawing/chart, embedded/control, 서명 |

빈 셀 전체를 입력칸으로 취급하지 않는다. visible label 근거 및 실제 XML 셀이 필요하며 formula/merged child/hidden/protected/불명확한 validation을 validator와 adapter에서 거절한다. Excel named table은 DATA_TABLE로 읽기 전용이다. 구조 삭제·이동·재정렬·보호 우회는 하지 않는다.

## 4. 공식 XLSX 표본

A: [기업마당 — 2026년 찾아가는 공공구매 상담회 참가신청서](https://www.bizinfo.go.kr/sie/siea/selectSIEA430Detail.do?eventInfoId=EVEN_000000000068305).

- SHA-256: `69c0733389fa4aacbdf81be9f389f1f3e5679078f865d6958bf63595b782a062`.
- sheet/visible: 1/1, 기업목록, used range A1:I6, merged 1, formula 0, validation 0.

B: [중소벤처기업부 — 2021년 K-스타트업센터 참여 신청서](https://www.mss.go.kr/site/smba/ex/bbs/View.do?bcIdx=1024494&cbIdx=310&parentSeq=1024494).

- SHA-256: `1baafab04a94715a1f686f1db543db433aa3027d44b3e7a174ef4a6c4bdd7f74`.
- sheet/visible: 1/1, 신청서(국문), used range A1:H36, merged 36, formula 0, validation 2.

초기 aT 경쟁력/시장분석 신청서 2개는 폼 컨트롤·drawing 때문에 UNSUPPORTED로 거절했다. 삭제·변환해서 표본으로 만들지 않았다. [거절 표본 출처와 구조](unsupported-official-samples.json).
공식 formula 표본은 이번 두 문서에 없으며 수식 관련 실제 일반화 검증을 완료했다고 주장하지 않는다.

## 5. Ground Truth

A는 업체명·대표자·공급품목·보유 인증·참석자·연락처·이메일·비고, B는 신청국가·대표자 신청자명·국문/영문 기업명·투자계약일자·대표자/팀원 첫 행 이메일·국문/영문 아이템 요약이다. 실제 label과 셀 주소를 읽어 문서당 8개를 정의했다.
Agent의 문서 검토이며 사용자의 독립 검토나 사람이 판정한 정답으로 표기하지 않는다.
[정답 A](../../expected/xlsx-purchase-v1.json), [정답 B](../../expected/xlsx-startup-v1.json)와 blind 질문 파일은 분리한다. 모델 요청에는 expectedTargetId를 넣지 않는다.

## 6. Candidate 결과

| 표본 | coverage | exact | ambiguous | wrong | unmapped |
|---|---:|---:|---:|---:|---:|
| A | 100% | 8 | 0 | 0 | 0 |
| B | 100% | 8 | 0 | 0 | 0 |

rich-text heading 누락을 수정하고 XLSX label 정규화 값의 일치를 요구해 대표자 질문을 단순 팀원 성명에 연결하지 않도록 했다.
[preflight A](../xlsx-purchase-20260927-v1/preflight.json), [preflight B](../xlsx-startup-20260927-v1/preflight.json). 각 question의 단일 후보가 준비된 제한된 평가이며 대규모 일반화 성능으로 해석하지 않는다.

## 7. OpenAI Mapping

모델 gpt-5.6-luna, 문서당 1회, 전체 2회. 자동 추가 호출 없음.

| 표본 | Correct | Wrong | Unmapped | Wrong Target Rate |
|---|---:|---:|---:|---:|
| A | 8 | 0 | 0 | 0% |
| B | 8 | 0 | 0 | 0% |

두 결과 모두 production validate_mapping 통과.
[Mapping A](../xlsx-purchase-20260927-v1/mapping.json), [Mapping B](../xlsx-startup-20260927-v1/mapping.json).
Ground Truth ID 비노출과 API 호출 수를 각 run에 기록했다.

## 8. Write / Verify

각 표본 5개 입력칸에 테스트기업, 홍길동, 테스트제품, 테스트 전화·이메일 또는 공식 허용 국가 등 dummy 값만 작성했다. 실제 사용자 개인정보는 사용하지 않았다.
원본과 별도 작성본이며 requested/resolved/applied/verified=5, unresolved=0, reopened=true.
[작성 증명 A](../xlsx-purchase-20260927-v1/write-verification.json), [작성 증명 B](../xlsx-startup-20260927-v1/write-verification.json).
최신 adapter로 작성본과 실제 HTTP 다운로드를 다시 열고 target 값과 source hash를 확인했다.

## 9. Excel/LibreOffice 실제 열기

Excel은 설치돼 있으나 computer-use의 Excel 실행 요청이 `Computer Use app approval timed out`으로 끝났다. 이후 Excel 미실행 상태를 확인했다.
Excel 시각 검토·복구 경고 여부·실제 표시·수식 재계산은 NOT_RUN이다. LibreOffice는 설치돼 있지 않았다.
[실제 열기 상태](excel-opening.json). openpyxl 재열기 통과를 Excel 열기 통과로 대체하지 않는다.

## 10. Formula / Style / Validation 보존

승인 셀 값 payload만 제외한 전체 worksheet XML을 비교하고 다른 ZIP 파트가 동일한지 검사한다. 다른 값, 수식과 기존 cache, merged range, 스타일/numberFormat, validation/conditional formatting, row height/column width, sheet/hidden state, freeze pane, workbook properties를 보존한다.
수식은 합성 SUM 셀로 보호·비손상을 확인했으며 공식 표본의 formula count는 0이다. 수식을 재계산하지 않았고 실제 계산값이 맞다고 주장하지 않는다.
General 및 식별자는 문자열을 유지하며 =로 시작한 답변도 formula로 바꾸지 않는다. 명시 숫자·날짜·% 형식만 검증 후 변환한다.

## 11. Core ↔ AI ↔ Storage ↔ Download

공식 표본 A로 실제 Core TCP HTTP→실제 AI TCP HTTP→inspect→saved Mapping→WritePlan→native write→MySQL 8.4/Redis Testcontainers→Core 저장→인증 다운로드→재열기 PASS.
공식 첨부 획득은 이미 내려받은 binary fixture이며 live collector E2E가 아니다. Mapping은 실제 성공한 결과, 계획 생성의 모델 경계는 fixture로 대체했다. inspect·검증·작성·DB·HTTP·download는 실제 코드다. 이 E2E의 유료 호출은 0회.
다운로드 bytes는 독립 native 작성·검증본과 동일하다. [HTTP 증명](http-e2e.json).

Frontend - Web: 확장자·응답 MIME·다운로드 MIME whitelist 및 다운로드 테스트를 추가했다.
Frontend - Mobile: 직접 변경 없음. Shared의 지원 형식 오류 문구만 공통 반영했다.
별도 사용자 upload API는 추가하지 않았고 현재 공식 첨부 수집 경로를 확장했다.

## 12. Version / Cache

기존 HWP/HWPX/PDF/DOCX engineVersion, mapVersion 및 공통 pipelineVersion을 실제 main과 비교해 동일함을 확인했다.
XLSX engine만 지도·생성 fingerprint·migration 승인 시 검사한다. XLSX 추가만으로 기존 네 형식의 캐시를 invalidate하지 않는다.
[버전 증명](version-evidence.json).

## 13. Regression

- AI 전체 최초 실행: 1,440 passed, bootstrap 2 failed, 기존 pytest temp ACL 오류 57. 새 작업 임시 폴더로 관련 오류를 재검증했다.
- AI 문서 관련 전체: 279 passed. 마지막 XLSX hidden-label/서명 보완 영향 범위: 48 passed.
- AI bootstrap: 수정되지 않은 최신 main 소스에서도 2 failed/8 passed. FakeChatOpenAI.model_name 누락이며 수정하지 않았다.
- Core `clean build`: 1,553 tests, 1,545 passed, 6 failed, 2 skipped. compile·packaging 통과, 전체 build 최종 상태는 FAIL이다.
- Core 실패: 기존 계정 동시 재설정 429 한 개, 미변경 코드의 Windows POSIX attribute 제한 다섯 개. 계정 실패는 이전 DOCX base 비교 기록에서도 재현됐다. 이번 Core full baseline 재실행은 하지 않았으며 POSIX 실패는 source 동일성과 명시 오류로 구분했다. 문서 관련 신규 실패는 없다. XlsxRealHttpIntegrationTest opt-in은 별도 PASS다.
- Web: 제한된 worker 전체 실행 101 files/1,271 tests에서 2개 timeout. 남은 catalog 파일 40개 단독 재실행 모두 PASS. lint·tsc -b·vite production build PASS. 초기 unrestricted worker 실패도 기록했으며 제품 테스트 코드를 완화하지 않았다.
- Shared: 19 tests, lint, typecheck PASS.
- CI: commit/push 금지 때문에 원격 실행하지 않았다. 로컬 결과로 전체 CI 완료를 선언하지 않는다.
- 최종 `git diff --check` 및 신규 파일 whitespace 점검: [최종 점검](final-checks.json).

[실행 명령·실패 목록](regression.json). JDK Windows AF_UNIX 문제는 테스트 프로세스의 임시 unixdomain 경로 설정으로 JDK TCP fallback을 사용했다. 저장소 실행 설정을 바꾸지 않았다.

## 14. 발견 오류

- HIGH, 수정: self-closing 셀 XML 매칭이 다음 셀까지 잡을 수 있었다. 구조 보존 검사에서 중단돼 결과를 저장하지 않았으며 매칭 범위를 수정해 작성·보존 테스트가 통과했다.
- MEDIUM, 수정: workbook.security=None 검사 오류, rich-text label 누락, 부분 label의 대표자/팀원 오매핑 위험.
- MEDIUM, 수정: 숨긴 label에서 visible 입력칸을 추론하는 경계. label 근거도 visible로 제한한다.
- MEDIUM, 보호: 비표준 파트 이름의 macro/object/signature도 content type·relationship로 거절한다.
- LOW, 수정: 첫 HTTP fixture에서 MSS 문서를 BIZINFO 출처로 선언해 정상 host 검증이 거절했다. 검증 규칙을 완화하지 않고 BIZINFO 표본으로 수정했다.
- 환경/기존 코드: pytest temp ACL, Java AF_UNIX, worker timeout, bootstrap/계정/POSIX 실패. 범위 밖 production·사용자 파일을 변경하지 않았다.
- 미검증: Excel UI·수식 계산·공식 formula/hidden/protected 실제 일반화·독립 Ground Truth 검토·원격 CI.

## 15. XLSX 상태

**XLSX_1ST_PASS / PARTIAL.** 두 공식 표본에서 inspect, coverage, Wrong Target 0, native write, reopen, merge/style/validation 보존, Core/Web 연결과 기존 네 포맷 관련 회귀 조건을 확인했다.
전체 XLSX 일반화나 전체 repository/CI 안정화를 완료한 상태는 아니다. [상태](status.json).

## 16. 다음 단계

**A. XLSX 추가 안정화**를 권장한다. Excel 실제 열기·공식 수식 표본·독립 표본 검토를 먼저 마친다. PR 준비는 별도 요청이며 기존 회귀 실패/CI 판단을 함께 정리한다. ApplicationMap 설계로 바로 넘어가지 않는다.

## 17. Git 상태

- 작업 branch: skn-17, 최신 main의 DOCX 병합 commit에서 분기한 별도 managed worktree.
- working tree: 이번 변경은 미커밋·unstaged 상태.
- 신규 commit 0, push 없음, PR 없음, history rewrite 없음, 배포 없음.
- 원래 skn-13 checkout과 기존 계정 테스트 수정은 보존했다.
- 원본·작성·다운로드 XLSX binary, API key, 사용자 개인정보, base64 payload, temp file은 평가 저장소에 넣지 않았다.
- [최종 Git/파일 점검](final-checks.json). base SHA는 해당 파일에 실제 값을 기록했다.
