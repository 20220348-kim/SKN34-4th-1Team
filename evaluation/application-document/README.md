# 신청 문서 Semantic Analysis 검증

DOCX 공식 신청서 1차 평가와 1회 OpenAI Mapping 결과는 [docx-kotra-20260926-v1](runs/docx-kotra-20260926-v1/README.md)에 기록했다. 원본 DOCX는 저장소에 포함하지 않았다.
추가 공식 신청서 2건, Word 렌더 및 서비스·버전 검증은 [DOCX 안정화 기록](runs/docx-stabilization-20260926-v1/README.md)에 기록했다.
페이지 증가 원인·의정부 재평가·실제 Core↔AI HTTP와 최종 회귀는 [DOCX 후속 안정화](runs/docx-stabilization-r2-20260926-v1/README.md)에 기록한다.

검증일: 2026-09-23
실행 ID: `semantic-validation-20260923-v1`

현재 HWP/HWPX/PDF native editing 계약을 유지한 상태에서 Table Classification, Heading/Section,
Semantic Reading Order와 native identity를 실제 공식 문서 표본으로 확인한 기록이다. 자동 분석 결과이며
독립적인 사람 문서 검수나 기관 확인, 실제 OpenAI mapping 품질 평가는 아니다.

## 표본

| 포맷 | 고유 파일 수 | 출처·특징 | 검증 범위 |
|---|---:|---|---|
| HWPX | 2 | 중기부 2026 창업도약패키지 일반형·딥테크 공식 공고 원문 | 고정 Hangeul MCP inspect, 표·heading·순서·identity |
| HWP | 1 | 기업마당 2026 AI 창업경진대회 공식 미작성 신청서 | Core hwplib 표·checkbox·WritePlan·재열기 |
| PDF | 1 | 딥테크 공고의 기업마당 공식 PDF 대조본 | Core PDF 원문·페이지 locator 파싱 |

추가 Ground Truth는 기업마당 `PBLN_000000000118098`의 공식 서초구 중소기업육성기금 HWPX 신청서다.
원본은 저장소에 복사하지 않고 공식 URL에서 내려받아 SHA-256
`8d253d5c0f5af214caf28d20f108b106d7261c79334b77f167c3886b4b552c91`을 확인한다.
[expected/seocho-2026-v1.json](expected/seocho-2026-v1.json)에 사람이 표 라벨과 인접 셀을 대조한
10개 mapping 및 17개 heading Ground Truth를 기록했다.

HWPX/PDF의 `evaluation/combination-review` 사본과 Core test resource는 SHA-256이 같아 중복으로 세지 않았다.
프로젝트 사업계획서와 아키텍처 발표 PDF는 지원사업 신청서가 아니므로 제외했다.

## HWPX 실제 분석 결과

| 문서 | targets | tables | AMBIGUOUS | DATA | LAYOUT | FORM | accepted heading | semantic reorder |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `general.hwpx` | 1,921 | 54 | 13 | 20 | 15 | 6 | 1 | 0 |
| `deeptech.hwpx` | 1,646 | 51 | 13 | 17 | 15 | 6 | 1 | 0 |

두 문서 모두 targetId, nativeLocator, target 배열과 source SHA-256이 분석 전후 동일했다. semantic reorder가
발생하지 않은 것은 정상 결과다. 병합·복합·AMBIGUOUS 구조는 `REVIEW_REQUIRED` 또는 `PRESERVED`로 남겼다.

대표 표 판정:

| 문서·table | 기대 | 실제 | confidence·reason | 입력 후보 |
|---|---|---|---|---|
| 일반형 `t3` | DATA_TABLE | DATA_TABLE | 0.65, `filled_grid` | 유지 |
| 일반형 `t4` | LAYOUT_TABLE | LAYOUT_TABLE | 0.98, `numbered_section_banner`, `empty_spacer_fields` | 제외 |
| 일반형 `t14` | FORM_TABLE | FORM_TABLE | 1.0, `analyze_form_field` | 유지 |
| 일반형 `t1` | AMBIGUOUS | AMBIGUOUS | 0.0, 근거 부족 | 유지·검토 |
| 딥테크 `t39` | FORM_TABLE | FORM_TABLE | 1.0, 실제 checkbox | 유지·검토 |

저용량 empty spacer가 포함된 장 번호·붙임 제목 표는 Hangeul `analyze_form` 결과만 보면 FORM_TABLE로
오인됐다. 6셀 이하·2행 이하, 명시적 숫자/붙임 표식, 모든 탐지 필드가 capacity 0/1 empty cell인 경우만
LAYOUT_TABLE로 제한해 실제 입력 후보에서 제외했다. 이 명시적 패턴이 없으면 AMBIGUOUS fail-safe를 유지한다.

## Heading과 Reading Order

초기 실행에서는 `중소벤처기업부 장관`, 별첨 참고 문장, 제출서류 bullet이 heading으로 과분류됐다.
서명 직함과 `*`, `※`, `◦`, `○`, `•`로 시작하는 note/bullet을 보존 대상으로 바꾼 뒤 두 문서에서
`< 창업기업 선정평가 절차(안) >`만 confidence 0.70으로 수락했다. 문서별 2건은 근거 부족으로
`REVIEW_REQUIRED`였다. `sectionPath`는 단일 단계라는 한계를 유지한다.

Reading Order는 FORM_TABLE이 아닌 표, 병합 셀, 다른 행 label/input, interleaved target을 재정렬하지 않았다.
일반형 306 targets, 딥테크 309 targets가 복잡성 때문에 review 상태였고 semantic index 변경은 0건이었다.
실제 reorder 사례를 만들기 위해 임계값을 낮추지 않았다.

## Mapping·WritePlan·Verification 범위

- 이 공고 HWPX 2종에는 현재 form manifest의 실제 질문 세트와 사람이 확정한 expected mapping이 없어
  OpenAI Question → Target mapping 정확도는 실행하지 않았다. 정상/unmapped/wrong-target 수를 추정하지 않는다.
- 실제 HWP 표본은 Core 테스트에서 표 입력, checkbox 그룹, expectedText, scope, WritePlan과 재열기를 확인했다.
- HWPX는 실제 MCP initialize/tools/list/inspect와 원본 hash 불변을 확인했지만 사람이 확정한 입력 target이
  없어 편집하지 않았다.
- PDF는 Core parser에서 실제 원문과 페이지 locator를 확인했다. FFDetr 입력칸 탐지·PDFBox 최종 작성은
  이번 로컬 실행 범위가 아니며 성공으로 표시하지 않는다.

### 실제 신청서 Ground Truth 결과

`validate_mapping.py --source <공식 HWPX>`는 production의 label 보호와 `mapping_label_matches` 후보 생성을
그대로 재현한다. OpenAI 최종 선택은 실행하지 않는다.

| 지표 | 결과 |
|---|---:|
| Ground Truth fields | 10 |
| exact candidate 1개 | 2 |
| expected target 포함 ambiguous | 8 |
| wrong | 0 |
| unmapped | 0 |
| exact accuracy | 20% |
| expected candidate coverage | 100% |

scope title이 `tableHeadings`·`columnLabels`·`sectionPath`에 존재하는 target만 보는 진단 필터에서는 exact
6건, ambiguous 4건, wrong/unmapped 0건이었다. 이는 metadata 유효성 진단일 뿐 production Mapping에
강제 적용하지 않았다. 실제 Agent 정확도로 표현하지 않는다.

사람이 확정한 빈 leaf target 6개에 dummy 값을 작성했다. preview 6, apply 6, verify 6, unresolved 0,
XML 검사 통과였으며 예상 밖 target text 변경은 0건이었다. 원본 hash와 target/address 구조를 유지했다.
한컴 렌더링은 `NOT_RUN`이다.

Heading Ground Truth 17개 중 12개를 section metadata로 감지했고 주요 Roman heading 중 5개는 단일 단계
sectionPath 정책 때문에 누락됐다. 수정 후 false positive는 0건이며 1개 table은 review 상태다.
Reading-order review 540 targets는 14개 table에서 반복됐으므로 target 단위 수치보다 table 단위 audit이
운영 검토량을 더 정확히 나타낸다. 이번 작업에서는 aggregation을 구현하지 않았다.

## 발견 문제와 조치

| 심각도 | 재현 | 원인 | 조치 |
|---|---|---|---|
| HIGH | 두 HWPX의 장 번호·붙임 제목 표 | `analyze_form`이 장식용 empty spacer를 입력칸으로 반환 | 명시적 section banner만 LAYOUT_TABLE로 제한하고 회귀 테스트 추가 |
| MEDIUM | 두 HWPX의 서명·참고·제출서류 문장 | 짧은 텍스트와 후속 field density만으로 heading 수락 | note/bullet/signature 제외 및 회귀 테스트 추가 |
| LOW | 실제 표본 semantic reorder 0건 | 공식 공고의 form 후보가 대부분 병합·복합 구조 | fail-safe 유지, heuristic 완화하지 않음 |

## kordoc 판단과 다음 단계

현재 실패는 native text coverage 부족이 아니라 Hangeul의 empty spacer 의미 오인과 heading 후보 필터 문제였고
기존 구조 근거로 재현·수정됐다. 따라서 **현재는 kordoc Semantic QA 확대가 불필요**하다. 다만 실제 신청서
HWPX 표본과 사람이 확정한 mapping 정답이 아직 부족하므로 다음 작업은 **C. 실제 표본을 더 확보한 후 재검증**을
권장한다. 실제 heading hierarchy 누락이나 text coverage 차이가 확인될 때 kordoc 확대를 다시 판단한다.

## 실행 결과

- 실제 HWPX: 고정 `Hangeul-mcp@b6fef153...`의 initialize/tools/list/inspect를 공식 HWPX 2종에 실행했다.
  각각 1,921/1,646 targets를 읽었고 source hash 및 native identity 불변을 확인했다.
- AI 단위·스텁: `uv run --locked --extra dev python -m pytest tests/test_document_mcp_contract.py tests/application_preparation`
  결과 206 passed.
- Core 실제 문서 대상: JDK 21에서 `ApplicationHwpPlanTest` 5개, `ApplicationDocumentEditorTest` 11개,
  `SupportProgramDocumentParserTest` 9개, 합계 25개가 모두 통과했다. 첫 실행의 Windows AF_UNIX loopback
  오류는 기존 검증 절차대로 검증 JVM에만 존재하지 않는 `jdk.net.unixdomain.tmpdir`을 지정해 TCP fallback으로
  분리 해결했으며 production 설정은 변경하지 않았다.
- 실제 OpenAI 호출, HWP/HWPX/PDF 최종 렌더링, 배포 및 원격 CI는 실행하지 않았다.

Ground Truth 재현 명령:

```text
python evaluation/application-document/validate_mapping.py \
  --source <SHA-256을 확인한 공식 seocho HWPX 경로>
```


## XLSX 공식 표본 평가

`expected/xlsx-*-v1.json`에는 공식 출처·SHA-256·sheet 구조와 8개 필드 정답 주소를 저장하고 `blind-xlsx-*-v1.json`에는 모델에 전달할 질문만 둡니다. 정답 주소는 모델 입력에 넣지 않습니다. 원본과 작성본 XLSX는 저장소 밖 임시 경로에만 둡니다.

`run_xlsx_mapping.py --source <official.xlsx> --expected <expected.json> --blind <blind.json> --output <runs/xlsx-...> --preflight`로 무료 coverage를 먼저 확인합니다. coverage가 100%이면 같은 명령에서 `--preflight`를 제거해 문서당 1회, 이 작업 전체 최대 2회만 Mapping할 수 있습니다. 자동 재호출은 없고 attempt 파일이 있으면 동일 문서를 다시 호출하지 않습니다. 실제 평가 환경 파일은 `XLSX_EVALUATION_ENV`로 지정하되 키를 출력·기록하지 않습니다.
`run_xlsx_write.py --source <official.xlsx> --expected <expected.json> --output <separate.xlsx>`는 검토한 3~5개 dummy 값만 작성하고 재열기·보존 증명을 반환합니다.

실제 TCP Core→AI→DB→download 검증은 `XlsxRealHttpIntegrationTest`를 사용합니다. `XLSX_HTTP_E2E=true`, `XLSX_E2E_SOURCE_PATH`, `XLSX_E2E_EXPECTED_PATH`, `XLSX_E2E_OUTPUT_PATH`, `XLSX_E2E_AI_URL`, `DOCUMENT_INTERNAL_TOKEN`을 설정합니다. `serve_xlsx_fixture.py`는 saved Mapping 결과 경로(`XLSX_E2E_MAPPING_PATH`), 저장소 밖 로그(`XLSX_E2E_AI_LOG`)와 포트(`XLSX_E2E_AI_PORT`, 기본 18082)를 받고 production AI router/agent/pipeline을 실행합니다. 모델 경계만 fixture이며 유료 호출은 0회입니다. MySQL 8.4·Redis Testcontainers와 실제 AI HTTP 서버가 필요합니다.
MockRest/ASGI 검증, 실제 OpenAI Mapping, 실제 DB·TCP HTTP, Excel 실제 열기는 서로 다른 검증 수준으로 기록합니다. Ground Truth는 agent의 공식 셀 검토 결과이며 사용자의 독립 검토 완료로 표기하지 않습니다.

### XLSX 안정화 r2

[최종 안정화 기록](runs/xlsx-stabilization-r2-20260927-v1/README.md)은 Microsoft Excel 실제 열기·저장·재열기, 공식 수식/보호 표본과 실제 latest main 대비 전체 회귀를 구분합니다. 기존 두 표본의 유료 Mapping을 반복하지 않았습니다.
`run_xlsx_stabilization.py`는 추가 공식 표본 한 개의 GT 5~10개와 blind 입력을 사용합니다. 이번 추가 평가에서만 `--mapping` 1회를 허용하고 attempt가 있거나 기존 두 호출 이후가 아니면 중단합니다. `--write`는 무료 native dummy 작성입니다. 이 작업의 추가 유료 호출 한도는 이미 사용했으며 재호출하지 않습니다.
단일 안내문 validation(type 생략, formula 없음) 보존 수정으로 XLSX engine은 `govbiz/xlsx-native@2+openpyxl-3.1.5`입니다. 공통 버전과 기존 네 형식 엔진은 유지됩니다.
