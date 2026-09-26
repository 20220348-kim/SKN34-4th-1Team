# HWP/HWPX/PDF 3포맷 안정화 최종 판단

실행일: 2026-09-25. 대상 branch: `skn-13`. 현재 요청의 Phase A → B → C → D 순서로 진행했다. 이전 작업의 HWP·HWPX 평가 결과와 이번 실행을 구분한다. 공식 원본·수정본, 사용자 정보, API 키는 저장소에 넣지 않았다.

## 1. PDF FFDetr E2E

[공식 부산 PDF 결과](../pdf-e2e-20260925-v1/README.md): 11페이지, 324,743 B, SHA-256 `4c90df4a5282dd62ae550bb1676766a550089dce7509192008feee988b24bde3`. 기존 AcroForm 필드 0개인 flat 신청서다. 고정 FFDetr 가중치와 PDF MCP가 106개 `PDF_INPUT`을 만들었다. 사람 검토 Ground Truth 5개는 모두 후보에 남았고 인쇄 글자와 교차하지 않았다. 실제 production 문맥 OpenAI Mapping 1회가 Correct **5/5**, Wrong **0**, validator PASS였다.

모델이 고른 5개 주소와 가상값으로 WritePlan을 구성해 검증하고, PDF MCP `PDFBOX_REQUIRED` placement를 Core PDFBox에 전달했다. 출력 PDF는 필드·위젯·appearance·값 **5/5**, Core 재inspect의 `PDF_FIELD` 5개, 전체 11페이지 Poppler 렌더 비교를 통과했다. 변경 픽셀은 2·6페이지의 선택 박스 안에만 있었고 원본은 유지됐다. WritePlan 연산은 평가자가 공급했으며 OpenAI 계획 호출은 하지 않았다. PDF 삭제 경로와 다른 공식 PDF에서의 일반화, Reader UI 재편집은 `NOT_RUN`이다.

## 2. 대형 HWPX 문맥 개선

[경기 디자인 HWPX 결과](../large-hwpx-context-20260925-v1/README.md): 2,564 targets, 편집 가능한 말단 1,520개, 본문·context 864,876자로 기존 400,000자 사전 제한을 넘었다. 기존 Mapping 직렬화 입력은 2,428,665자였다. native 라벨 후보 51개를 보낼 때 실제 입력은 72,064자·82,876 UTF-8 bytes다. 토큰 추정 약 18,016개는 문자/4 휴리스틱이다. Ground Truth target **10/10**이 후보에 남았다.

`mapVersion=native-map-v12-hwpx-context-budget`에서 대형 HWPX는 모든 질문에 native 라벨 후보가 있을 때만 이 51개 말단을 모델에 보낸다. 후보 누락이나 예산 초과는 호출 전에 오류로 끝난다. 실제 OpenAI Mapping 1회는 Correct **10/10**, Wrong **0**, validator PASS였다. 저장된 10개 binding을 scope로 삼은 생성 계획 입력은 17,141자였고 가상값 native write/verify **3/3**을 통과했다. 계획 연산은 평가자가 공급했고 한글 화면 렌더는 `NOT_RUN`이다. 전체 DocumentMap과 native 주소는 검증에 남겨 두며, 다른 칸의 자동 예시 정리까지 완료했다는 뜻은 아니다.

## 3. mapVersion·MySQL 영향

[호환성 검증](../map-version-compatibility-20260925-v1/README.md): AI `MAP_VERSION`이 `PIPELINE_VERSION` hash에 포함된다. Core는 원본 SHA·pipelineVersion이 일치할 때만 저장 지도를 재사용한다. 격리 MySQL 8.4에서 구버전 지도 재매핑 시 binding·편집 scope가 같으면 새 JSON 지도만 저장되고 답변·input revision 2가 유지됐다. 주소 또는 scope가 달라지면 `APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED`(422)로 중단되고 이전 지도·답변·기존 파일이 보존됐다. 이전 파일 fingerprint는 새 pipeline cache hit가 아니지만 소유자 조회로 남는다. DB migration은 없다.

**배포 위험:** 첫 재접근에는 실제 유료 재매핑과 지연이 생길 수 있다. 변경된 binding을 같은 formVersionId에서 승인·이관하는 자동 경로는 아직 없어, 드리프트가 발생한 작성본은 자동 초안 생성이 중단된다. 실제 운영 DB·배포 데이터는 변경하거나 검증하지 않았다.

## 4. 발견 오류와 심각도

| 심각도 | 재현 | 조치·남은 범위 |
|---|---|---|
| CRITICAL 가능성 | 구버전 저장 binding·scope와 새 결과가 달라도 Core가 이전에는 새 결과를 바로 저장할 수 있었음 | 차이 감지 후 저장·자동 작성 중단. 실제 오기입 사례는 관찰하지 않음 |
| HIGH 운영 위험 | 차단된 binding 차이를 사용자가 같은 formVersionId에서 승인·이관할 자동 경로 부재 | 기존 데이터는 보존. 별도 재확인 흐름 필요 |
| MEDIUM | 부산 PDF의 빽빽한 격자에서 라벨 없는 중복 FFDetr 후보가 겹쳐 전체 inspect 중단 | 겹친 새 무라벨 후보만 버리고, 라벨 있는 겹침은 계속 오류 |
| MEDIUM | 디자인 HWPX의 모델 입력 전 400,000자 제한 | validator가 허용하는 모든 라벨 후보를 보존하며 입력을 축소 |

## 5. 수정 파일

- production: `backend/ai-service/app/application_preparation/{pdf_form_detection.py,document_pipeline.py,agent.py,document_contract.py}`, `backend/core-service/src/main/kotlin/ai/govbiz/core/applicationpreparation/service/ApplicationDocumentMappingService.kt`.
- 회귀: AI 문서·PDF detector 테스트, Core MappingService 단위 및 신청 준비 MySQL 통합 테스트.
- 평가·문서: `evaluation/application-document/`의 이번 실행 도구·Ground Truth·결과, Core README, 문서 MCP/전체 아키텍처 설명.
- 이전 작업에서 이미 변경돼 있던 다른 HWPX 파일·테스트·평가 자료는 유지했다.

## 6. 테스트와 실제 검증

- AI 로컬: `uv run --locked --extra dev python -m pytest tests/test_document_mcp_contract.py tests/application_preparation` 첫 실행 **213 passed, 1 failed**. 새 PDF fixture의 좌표 정확 비교를 근사 비교로 수정하고 실패 1개를 재실행해 **passed**. 이미 통과한 213개는 반복하지 않았다.
- Core 로컬 JDK 21: `./gradlew test` 선택 실행에서 `ApplicationHwpPlanTest` 5개, `ApplicationDocumentEditorTest` 11개, `SupportProgramDocumentParserTest` 9개가 통과했다. 최종 영향 범위 재실행에서 `ApplicationDocumentMappingServiceTest` 5개와 실제 MySQL 8.4 `ApplicationPreparationApiIntegrationTest` 시나리오 1개가 통과했다. Redis는 해당 통합 테스트의 기존 테스트 연결을 사용했다.
- 실파일: FFDetr/PDF MCP는 기존 AI Docker 이미지와 현재 앱 코드를 네트워크 차단 환경에서 실행했다. Core PDFBox, Poppler, pypdf 독립 재열기·렌더 검사를 별도로 수행했다. 대형 HWPX는 고정 Hangeul MCP 및 기존 kordoc 보조 경로를 사용했다.
- 원격 CI·전체 clean build·실제 서비스 UI·배포·운영 DB 검증은 `NOT_RUN`이다. 자동 테스트와 한 번의 모델 호출을 전체 품질 보증으로 해석하지 않는다.

## 7. 유료 호출

이번 요청에서 **2회**: 공식 부산 PDF Mapping 1회(5 fields), 대형 경기 디자인 HWPX Mapping 1회(10 fields). 둘 다 `gpt-5.6-luna`, `store=false`, 재시도 0, Wrong 0이었다. 모델 입력에는 Ground Truth target ID·가상값·키를 넣지 않았다. WritePlan 모델 호출은 0회다. PDF 호출은 Phase A 당시 `mapVersion` v11, 대형 HWPX 호출은 Phase B의 v12에서 수행했다. v12는 HWPX 대형 문맥 처리만 변경했지만, 현재 버전 PDF의 유료 모델 호출을 반복하지는 않았다.

## 8. 3포맷 상태

| Format | 근거 | 최종 상태 |
|---|---|---|
| HWP | 이전 공식 표본의 모델 Mapping 8/8·Core hwplib write/reopen 8/8. 이번 요청은 관련 Core 회귀 통과 | `PARTIAL` |
| HWPX | 이전 서초구·KISA·직무개발 3개 표본에서 각 10/10. 이번 대형 디자인 양식 10/10, write/verify 3/3 | `PARTIAL` |
| PDF | 이번 공식 flat PDF FFDetr→Mapping 5/5→검증된 WritePlan→PDFBox 5/5·전체 렌더 확인 | `PARTIAL` |

각 실파일에서 Wrong Target 0을 확인했지만, 문서별 한 번의 모델 실행과 한정된 입력칸만 평가했다. 원본 AcroForm PDF 경로, 실제 OpenAI WritePlan 선택, 다른 PDF 일반화, drift 발생 사용자의 재확인 경로가 남아 있어 **3포맷 전체를 `STABLE`로 선언하지 않는다**.

## 9. kordoc / Docling 필요성

이번 실패는 FFDetr 중복 박스, 모델 입력 문맥량, 저장 지도 버전 경계에서 발생했다. 확인한 공식 문서의 native text·표 읽기 부족이 원인은 아니었다. 새 kordoc 연동이나 Docling은 현재 문제 해결에 필요하지 않다.

## 10. 다음 단계

**A. 현재 3포맷 추가 수정.** 저장 binding·scope 드리프트 시 기존 답변을 유지하며 사용자가 새 양식 버전을 명시적으로 확인할 수 있는 경로를 먼저 마련한다. 이어 다른 공식 flat PDF와 기존 AcroForm PDF에서 탐지·Mapping·실제 작성의 일반화를 검증한다. DOCX adapter 또는 새 parser 착수 근거는 현재 없다.

## 11. Git 상태

작업 branch는 `skn-13`이고 변경은 미커밋이다. 기존 working tree를 유지했으며 이번 요청에서 commit·push·PR·배포·history rewrite를 하지 않았다. 최종 `git diff --check`는 통과했다.
