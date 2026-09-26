# DOCX 최종 안정화 검증

2026-09-26, `skn-14`의 미커밋 변경을 보존한 후속 검증이다. 새 DOCX 기능과 production 의존성은 추가하지 않았다. 기존 writer와 `govbiz/ooxml-native@2`를 유지한다. 독립적인 사람 검수는 아직 수행하지 않았다.

## 1. 대전·세종 페이지 증가

판정은 **A. 입력값 길이에 따른 정상 layout 증가**다. writer를 수정하지 않았다.

원본 SHA-256은 `4679e04cb697c931352fa4f237b38e6c78817a651d777c335e07e1747f1e6b26`, 비교 작성본은 `65ddc033454eb1be9ea400cb1ca243e001edb92a64006be241ab4090bf05fdbb`다. 이전 1차 기록과 동일한 공식 원본·작성본을 Microsoft Word로 비교했다.

최초 위치 차이는 1페이지 실무담당자 정보 표의 이메일 행이다. 원인은 `docx:t:3:r:2:c:2:p:1`에 쓴 16자 `demo@example.org`다. 빈 칸 너비는 87.85pt, 좌우 여백은 각 5pt, 글꼴은 원본·작성본 모두 맑은 고딕 9pt다. Word 렌더에서 `demo@example.or`와 `g`가 두 줄로 나뉘어 행이 15.6pt 높아졌다. 세로 가운데 정렬된 `이메일` 라벨의 y좌표는 505.2→513.0pt로 내려갔다. 다른 셀·표 너비는 유지됐다.

최초 **페이지** 차이는 1페이지 마지막 `외국어 대응인력` 행이다. 원본은 1페이지 y=776.4pt, 작성본은 2페이지 y=49.2pt다. 이 행의 `cantSplit`과 이후 서식의 기존 페이지 나눔이 보존돼, 밀린 행만 담는 페이지가 생기고 뒤쪽 서식들이 한 페이지씩 뒤로 이동했다. 원본 7페이지와 작성본 8페이지의 Word PDF 렌더를 전부 이미지로 확인했다.

| 동일 target의 비교 값 | Word 페이지 |
|---|---:|
| 원본 빈 값 / 기존 무입력 재직렬화 대조본 | 7 |
| 작성한 다섯 값 모두 `가` | 7 |
| 작성한 다섯 값 모두 `가상` | 7 |
| 담당자명 `홍길동`만 작성 | 7 |
| 이메일 `demo@example.org`만 작성 | 8 |
| 기존 다섯 dummy 값 | 8 |

`pPr`, `tcPr`, `trPr`, `tblPr`, `tblGrid`, `keepNext`, `keepLines`, `spacing`, `sz`, `cantSplit`, `trHeight`, `tblLayout`, `sectPr`는 개수와 XML 값이 동일했다. 기존 run 속성은 유지됐고, 새 run의 문자 속성은 원본 문단의 `pPr/rPr`에서 복사됐다. 글꼴·문단·셀·행·표·섹션 속성 손실을 원인으로 보지 않는다. [수치 증거](layout-evidence.json).

비교 스크립트 초기에 동일 `ZipInfo` 객체를 출력 ZIP에 재사용하면서 읽기 CRC 오류를 냈다. 복사본 메타데이터를 분리한 뒤 원본과 기존 작성본의 전체 ZIP CRC가 정상임을 확인했다. 문서 손상이나 adapter 결함이 아니었다. 원본·작성본 바이너리와 렌더 PNG/PDF는 로컬 임시 폴더에만 보관했다.

## 2. 의정부 Mapping 재평가

추가 유료 호출은 승인된 의정부 Mapping **1회**만 실행했다. API 요청 전 환경설정 확인 실패 1건은 유료 호출에 포함하지 않는다. 실제 요청은 `max_retries=0`, evaluation call cap 1로 실행했고 재시도하지 않았다.

| 항목 | 결과 |
|---|---|
| 전체 inspected target / 기존 읽기 전용 포함 leaf | 475 / 352 |
| 축소 후 모델 전송 target | 17 |
| target JSON 문자 | 11,128 |
| 실제 Mapping text 문자 / 추정 token | 13,642 / 4,578 (`o200k_base`, system·schema 제외) |
| 실제 provider input / output / total token | 6,213 / 415 / 6,628 |
| Ground Truth target 보존 | 8/8 |
| 후보 | exact 7, ambiguous 1, wrong 0, unmapped 0 |
| Mapping | Correct 8, Wrong 0, Unmapped 0 |
| Wrong Target Rate | 0/8 = 0% |
| JSON parsing / production validation | PASS / PASS |
| response status / parsing error | `completed` / null |

전송한 각 target의 visible label, `fieldLabels`, table/row/col nativeLocator와 요청 scope는 보존됐다. 원래 `tableHeadings`가 빈 문서라 빈 구조 heading이 새로 생겼다고 주장하지 않는다. 범위 문구와 표의 순서·주소가 section context를 제공한다. Ground Truth 정답 ID는 모델 입력에 추가하지 않았다.

최초 기록의 18,423자·5,583 추정 token은 메시지 content 컨테이너를 다시 JSON 직렬화한 길이이며, 위 표는 내부 Mapping text 자체의 길이다. [입력 증거](mapping-input-evidence.json), [유료 평가 결과](../docx-uijeongbu-recheck-20260926-v1/mapping.json), [raw 응답·status·usage·parse 진단](../docx-uijeongbu-recheck-20260926-v1/response-diagnostics.json). API key는 기록하지 않았다.

## 3. ambiguous 기업명

| 후보 | 구조적 근거 | 최종 선택 |
|---|---|---|
| A: `docx:t:1:r:1:c:2:p:1` | 시티온 트랙 참여 신청서의 `참여기업 정보`. 같은 행에 사업자번호가 있고 다음 행에 설립일이 있다. | 모델 선택, Ground Truth와 일치 |
| B: `docx:t:8:r:1:c:2:p:1` | 뒤쪽 `붙임 6. 지원기업 투자유치 현황`. 기업명 칸이 가로 gridSpan 3이며 다음 행에 대표자·사업자등록번호가 있다. | 선택하지 않음 |

반복 `기업명` 라벨만으로 두 칸을 같은 질문으로 취급하지 않는다. 실제 모델은 요청한 시티온 트랙 신청서의 A를 골랐다. 이 1건의 사람 검수 완료를 선언하지 않는다.

## 4. 실제 Core ↔ AI HTTP E2E

실제 테스트 JVM의 Core Tomcat TCP 서버 → production `ApplicationDocumentMcpClient` → 별도 Python/Uvicorn AI HTTP router → production inspect/map/plan/generate/native adapter → 실제 MySQL 8.4 및 Redis → Core 저장 → Core HTTP 다운로드 → DOCX 재열기 경로를 검증했다. `MockMvc`나 Mock AI Client를 사용하지 않았다.

KOTRA 공식 원본 SHA `26a761197b64aaf884cd6636851d423f7d1a51686249d418a1f2c3e57ab50cd7`와 더미 Fact만 사용했다. 제품에 사용자 upload endpoint가 없으므로 원본은 `BizInfoAttachmentClient` fixture로 공급하고 양식 snapshot은 실제 Repository로 등록했다. 원격 기업마당 수집·양식 발견 LLM은 이번 E2E 범위에 포함하지 않는다. Core 생성·입력 저장·다운로드는 실제 HTTP다.

추가 유료 호출을 막기 위해 AI의 **모델 호출 경계만** 저장된 KOTRA Mapping 결과와 더미 작성 계획 fixture로 교체했다. AI의 router, production Agent의 입력/schema 구성, validation, adapter와 결과 계약은 실제 코드다. 모델 자체의 E2E 품질 평가가 아니다.

| 단계 | 결과 |
|---|---|
| 공식 원본 fixture / snapshot 등록 / Core HTTP 신청 준비 생성 | PASS |
| `format=docx` / 실제 AI inspect·map HTTP / 저장된 mapping | PASS |
| WritePlan validation / 실제 AI generate HTTP | PASS |
| 실제 MySQL Core 저장 / Core HTTP download | PASS |
| Content-Type / DOCX filename / 세션 인증 | PASS |
| 다운로드 ZIP/native 재열기 / 작성값 | PASS, dummy 5/5 |
| 다른 target 텍스트 보존 | PASS, 259개 |
| 다운로드 Word 재열기 | PASS, 2페이지 |

출력은 20,482 bytes, SHA `badf9b3ac4914f7aa542974e48e2a7f2110a41bf1978ffb3d18ed9e932184030`이며 기존 성공한 KOTRA 작성본과 동일하다. JDK 21의 opt-in `DocxRealHttpIntegrationTest` 1 passed, failures/errors/skipped 0. [E2E 수치 증거](http-e2e.json).

재현에는 `evaluation/application-document/serve_docx_fixture.py`를 별도 실행하고, 테스트에 `DOCX_HTTP_E2E=true`, `DOCX_E2E_AI_URL`, `DOCUMENT_INTERNAL_TOKEN`, `DOCX_E2E_SOURCE_PATH`, `DOCX_E2E_EXPECTED_PATH`, `DOCX_E2E_OUTPUT_PATH`를 지정한다. 기본 전체/CI suite에서는 외부 AI 프로세스가 필요한 이 opt-in 테스트를 건너뛰며, 이번 실제 실행 성공을 그와 구분한다.

## 5. Ground Truth 사람 검수 목록

아래 위치는 OOXML **physical cell**의 1-based table/row/cell/paragraph다. 병합 후 화면상 열 번호와 혼동하지 않는다. 전체 Ground Truth를 다시 만들지 않았고 `humanReviewed=false`다. [전체 구조 근거](human-review.json).

### 대전·세종 대표 5개

| field name / visible label | targetId | 위치 | 사람이 확인할 근거 |
|---|---|---|---|
| 회사명 국문 / 회사명(국문) | `docx:t:2:r:2:c:2:p:1` | T2 R2 C2 P1 | 첫 기업 기본정보 표의 국문 라벨 바로 오른쪽. 같은 행의 영문 칸과 구분. |
| 회사명 영문 / 회사명(영문) | `docx:t:2:r:2:c:4:p:1` | T2 R2 C4 P1 | 같은 행에서 반복되는 회사명 문구 중 영문 라벨 바로 오른쪽. |
| 사업장 주소 / 사업장 주소 | `docx:t:2:r:5:c:2:p:1` | T2 R5 C2 P1 | 소재지역 선택 행 다음 주소 라벨 오른쪽. 같은 행 홈페이지 칸과 구분. |
| 담당자명 / 담당자명 | `docx:t:3:r:1:c:2:p:1` | T3 R1 C2 P1 | 실무담당자 정보 첫 행. 앞 표 대표자명 및 뒤쪽 서명 칸과 구분. |
| 이메일 / 이메일 | `docx:t:3:r:2:c:2:p:1` | T3 R2 C2 P1 | 실무담당자 이메일 입력칸. 앞 표의 복합 `대표자 이메일·연락처` 칸과 구분. 페이지 증가의 원인 칸. |

대전·세종 전체 원본에는 `gridSpan`/`vMerge` 병합 셀이 없어 merged-cell 인접 검수는 해당 없음이다.

### 의정부 대표 5개

| field name / visible label | targetId | 위치 | 사람이 확인할 근거 |
|---|---|---|---|
| 기업명 / 기업명 | `docx:t:1:r:1:c:2:p:1` | T1 R1 C2 P1 | ambiguous A. 뒤쪽 투자유치 현황의 기업명 B와 신청 범위를 대조. |
| 사업자번호 / 사업자번호 | `docx:t:1:r:1:c:4:p:1` | T1 R1 C4 P1 | 첫 기업 정보 행의 오른쪽 빈 칸. 뒤쪽 대표자·사업자등록번호 반복 서식과 구분. |
| 설립일 / 설립일(창업일) | `docx:t:1:r:2:c:2:p:1` | T1 R2 C2 P1 | 오른쪽 physical C3는 창업 7년 조건 안내가 든 가로 병합 셀이다. 그 안내 셀 대신 C2 빈 칸을 선택. |
| 주소 / 주소지 | `docx:t:1:r:3:c:2:p:1` | T1 R3 C2 P1 | 같은 행의 근로자수 C4와 구분하고, 아래 기업소개 개요의 가로 병합 칸을 주소 칸으로 오인하지 않았는지 확인. |
| 프로젝트명 / 프로젝트명 | `docx:t:2:r:1:c:2:p:1` | T2 R1 C2 P1 | 프로젝트명 첫 행의 빈 칸. 아래 소개·내용 행의 가로 병합 입력영역과 구분. |

## 6. DOCX 지원 범위

| 영역 | 상태 | 검증된 범위와 한계 |
|---|---|---|
| Paragraph form | PARTIAL | 명시적 빈 placeholder의 단순 텍스트만. 공식 paragraph-form 전체 표본 검증은 부족하며 혼합 스타일·다중 줄은 미지원. |
| Table/Cell form | STABLE | 인접 label이 명확한 단일 문단 입력칸, 단일 physical cell의 가로 gridSpan. 공식 3개 표본의 mapping/write/reopen 및 KOTRA 실제 HTTP 관통. 세로 병합·불명확한 다중 문단은 범위 밖. 입력 길이에 따른 페이지 변화는 발생할 수 있음. |
| Content Control | NOT_FULLY_TESTED | 명시적 plain-text control은 합성 단위 테스트. 공식 표본 3개는 native control 0. |
| Native Checkbox | NOT_FULLY_TESTED | 합성 native checkbox 상태 검증. 공식 표본에서 native checkbox 0. 인쇄된 □를 native control로 취급하지 않음. |
| Dropdown | UNSUPPORTED | 선택항목 편집 구현 없음. |
| Text Box/Shape | UNSUPPORTED | drawing/pict/object 등 복합 영역 자동 작성 제외. |
| Signed DOCX | UNSUPPORTED | `_xmlsignatures/`가 든 패키지를 명시적으로 거부. |

## 7. Version/cache

`mapVersion=native-map-v15-pdf-field-scope-options`, 공통 `pipelineVersion=2cacb34e74db390dddd98402e5d2703823794b40781b2e24803db03254be867d`, DOCX `engineVersion=govbiz/ooxml-native@2`를 유지한다. 실제 base SHA의 상수를 읽어 기존 세 포맷 engine·mapVersion 및 pipeline hash와 일치함을 확인했다. [Version 비교](version-evidence.json). DOCX 전용 engine은 지도 재사용과 생성 fingerprint에 반영되며 HWP/HWPX/PDF 기존 식은 유지된다. 기존 바인딩 변경은 기존 migration confirmation 흐름을 사용한다. 이번 후속 작업에서 production version·dispatch·cache·storage 계약은 추가 변경하지 않았다.

## 8. Regression

전체 Core 실행과 실패 범위 재검증을 완료했다. 아래 PASS는 실제 완료한 범위만 표시한다. Core 전체 build를 PASS로 표시하지 않는다.

| 영역 | 실제 실행 / 결과 |
|---|---|
| AI 전체 | `uv run --locked --extra dev python -m pytest`, 독립된 basetemp·JUnit 보고서. 최종 1,446 passed / failed 0 / errors 0 / skipped 0. 의도적인 duplicate ZIP 거부 테스트 warning 1. |
| AI 첫 실행 | npm 설치·다른 검증과 겹친 실행에서 1,444 passed, 기존 logging subprocess timeout 2. 환경 부하 감소 후 위 전체 재실행 통과. 테스트 제한시간이나 production 코드 변경 없음. |
| Core 실제 HTTP E2E | JDK 21 `clean test --tests '*DocxRealHttpIntegrationTest' --no-daemon`, MySQL 8.4·Redis·실제 AI HTTP, 1 passed. |
| Core base 비교 | `af801ae11b7a3fa7762e4ea1dce81313463ef465` git archive의 `clean build`에서 `AccountPasswordResetFlowIntegrationTest.concurrentRequestsCannotReuseTheSamePasswordResetToken`의 동일한 기존 assertion failure를 line 139에서 실제 재현. 비교 목적을 달성한 뒤 이 검증 전용 컨테이너만 종료했다. 전체 base suite 완료·통과로 보고하지 않는다. 원래 checkout의 사용자 account 테스트 변경은 포함하지 않음. |
| Core skn-14 전체 | JDK 21 `./gradlew clean build --no-daemon --max-workers=2`에 임시 테스트 메모리 설정을 적용. 169 suite files / 1,539 tests: 1,536 passed, 2 failed, errors 0, skipped 1. production 컴파일·bootJar는 PASS, 전체 build는 FAIL. 실패는 base에서도 재현된 account 테스트(예상 200, 실제 429)와 아래 격리 환경 ES 초기화 오류다. |
| Core DOCX·기존 포맷 관련 | 전체 suite의 관련 19개 suite / 149 tests: 148 passed, failed/errors 0, skipped 1. skip은 외부 AI 프로세스가 필요한 opt-in 실제 HTTP 테스트이며 별도 실제 실행에서 1 passed로 검증했다. HWP/HWPX/Flat PDF/AcroForm dispatch·cache·migration·저장·다운로드 관련 자동 회귀에 새 실패 없음. |
| Core ES 환경 보완 재검증 | 최초 격리 디렉터리에 `../../infrastructure/elasticsearch/Dockerfile`이 빠져 `Dockerfile does not exist`로 초기화 실패했다. production Dockerfile의 실제 상대 경로를 복원한 뒤 `test --tests '*ElasticsearchSupportProgramClientIntegrationTest'` 재실행: 실제 ES+Nori 9 passed, failed/errors/skipped 0. production·테스트 코드 변경 없이 검증 환경만 수정했다. |
| Web | Node 24.18.0 / pnpm 11.22.0. `pnpm test --maxWorkers=2`: 101 files / 1,270 passed. `pnpm lint`, `pnpm exec tsc -b --pretty false`, `pnpm build` PASS. 기존 500kB bundle warning 유지. |
| Web 첫 실행 | 기본 worker 실행에서 기존 catalog 테스트 1 timeout, 1,269 passed. 전체 재실행 통과. Web에는 `typecheck` script가 없어 첫 `pnpm typecheck`는 실행 명령 오류였고 실제 tsc로 별도 확인. |
| Shared | `pnpm test`, `pnpm lint`, `pnpm typecheck` PASS, 3 files / 19 passed. |
| git diff --check | PASS. 신규 JSON·Python 구문 및 문서 링크·공백도 확인. |
| 원격 CI·배포 | 미실행. commit/push가 금지되어 원격 CI 결과 없음. 로컬 결과를 CI 전체 완료로 표시하지 않음. |

Core 두 비교에는 동일한 임시 설정(maxHeap 1536m, maxParallelForks 1, forkEvery 250, Spring context cache 2)을 적용했다. 테스트나 production 코드를 변경하지 않았다. 최초 Windows bind-mounted Gradle 캐시의 지연은 기존 Linux Docker cache로 전환해 해결했다. [JUnit 집계·실패 분리](core-regression.json), [최종 수치](verification-summary.json).

CI의 Core `clean build`, AI 전체 pytest/Qdrant 통합, Web test/lint/build, Shared typecheck/test/lint는 `.github/workflows/ci.yml`에 유지돼 있다. push/pull_request 이벤트에는 브랜치·경로 제한이 없다. 이번 opt-in 실제 HTTP 테스트는 외부 fixture 프로세스가 없는 기본 CI에서 실행되지 않는다. 로컬 실제 HTTP 성공과 CI 검증은 별도다.

## 9. 남은 limitation

사람 검수·기관 확인 미실행, 공식 content control/checkbox 실문서 표본 부재, paragraph-form 전체 표본 부족, 실제 개인 답변과 임의 길이의 모든 layout 미검증, dropdown/text box/shape/signed DOCX 미지원은 그대로다. 이 제한을 새 기능으로 보완하지 않았다. 이번 E2E는 공식 첨부 acquisition·discovery와 유료 모델 품질을 검증하지 않는다.

로컬 전체 Core에는 base에서 재현된 비밀번호 재설정 테스트 실패 1건이 남는다. 이번 DOCX 변경의 회귀로 분류하지 않지만, 저장소 전체 green build가 완료됐다고 주장하지 않는다. 원격 CI 상태는 미확인이다. E2E용 AI fixture와 검증 전용 Core 프로세스는 종료했다.

## 10. 최종 판정

**PR_READY — 이번에 검증한 보수적인 DOCX 지원 범위 기준.** 페이지 증가의 정상 원인을 입증했고, 의정부 8개 질문의 Mapping·JSON·Wrong Target 0을 확인했으며, 실제 Core↔AI HTTP·MySQL 저장·다운로드·DOCX/Word 재열기가 통과했다. 기존 포맷의 관련 자동 회귀에 새 실패가 없고 현재 DOCX 범위의 미해결 CRITICAL/HIGH 차단 이슈는 없다. 전체 Core build PASS나 원격 CI 완료라는 의미는 아니다.

## 11. 다음 단계

다음 단계는 DOCX PR 준비다. 별도 요청에서 기존 account 테스트 실패와 원격 CI 상태를 함께 확인해야 한다. 이번 요청에서는 commit/push/PR을 수행하지 않는다. 대표 10개 target의 독립적인 사람 검수는 위 목록으로 진행할 수 있다.

## 12. Git 상태

작업 worktree branch는 `skn-14`, HEAD는 기존 `af801ae11b7a3fa7762e4ea1dce81313463ef465`다. 기존 및 이번 변경은 미커밋 상태이며 commit/push/PR/history rewrite를 수행하지 않았다. 원래 checkout의 `skn-13`과 account 테스트 미커밋 변경을 보존했다.
