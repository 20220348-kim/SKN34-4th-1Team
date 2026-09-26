# 신청 문서 MCP 구조

## 현재 호출 경로

React의 저장된 답변·expectedRevision → Core `ApplicationDocumentService` → 공식 첨부 재수집/hash 확인 → AI `/internal/v1/application-preparations/document/generate` → 원본 복사본 지도 → OpenAI 구조화 수정 계획 → HWP는 Core hwplib 계획 실행 / HWPX·PDF는 MCP → Core 결과 확인 → 소유권/revision 잠금 재확인 → 파일 저장 → 기존 다운로드 API.

| 형식 | 편집 경로 | 현재 검증/제약 |
|---|---|---|
| HWP | Core hwplib 검사 → AI 지도·계획 → Core hwplib 편집·재열기 | 일반 문단·표 셀 구간 및 실제 체크/라디오. 미지원 제어 문자·범위 주석은 거절 |
| HWPX | Hangeul inspect + analyze_form/get_table_map/find_cell_by_label → OpenAI 매핑 → analyze_formfit → preview/apply/verify | 셀 주소·병합 구조·항목명 근거 대조. 넘침 검사는 줄별 너비 추정이며 한컴 페이지 렌더링이 아님 |
| PDF | FFDetr 입력 영역 탐지 + pdf-edit-mcp 원문 대조/예시 삭제 → Core PDFBox AcroForm → 재열기·appearance·렌더 실행 | 기존 필드는 재사용하며 평면 문서의 탐지 영역은 인쇄 글자와 겹치지 않아야 함. flatten하지 않음 |

HWPX/PDF MCP 서버는 실제 stdio `initialize`, `tools/list`, `tools/call`을 실행한다. HWP는 새 서버 없이 기존 Core JVM에서 hwplib을 호출한다. AI에 `hwpTargets`로 실제 원본 구조를 보내고, `HWPLIB_REQUIRED` 단계의 원본 bytes와 수정 계획을 받는다. Core는 원본 동일성·계획 hash·revision·저장된 bindings/scope를 검사한 뒤 편집하고 `HWPLIB_VERIFIED` 근거와 최종 출력 hash를 저장한다.

## 지도와 계획

HWP 단독 질문 추출은 성공 시점의 프롬프트·출력 한도를 유지한다. HWPX는 자체 XML 표 추정 대신 Hangeul의 `get_table_map`과 `analyze_form`을 읽고, 질문과 일치하는 원문 라벨에 `find_cell_by_label`을 호출한다. 모호한 라벨 후보를 첫 셀로 자동 확정하지 않는다. 표 주소와 셀 텍스트는 독립적인 `inspect_editable_regions` 결과와 대조한다. `analyze_form` 본문 번호는 빈 문단을 제외하므로 편집 주소로 사용하지 않는다.

HWPX 질문 추출도 표 구조를 먼저 읽는다. Core의 discovery 요청에 해당 원본의 `sourceBase64`·`sourceSha256`을 함께 전달하고, AI는 hash·크기를 검증한 임시 복사본에서 nativeLayout을 만든다. OpenAI에는 바이너리가 아닌 기존 원문 블록과 실제 셀·행·열·병합·입력 후보 정보를 보낸다. 원본 bytes는 DB 양식 JSON에 추가 저장하지 않는다. 새 요청 필드를 받는 AI를 먼저 배포한 뒤 Core를 배포한다.

HWPX 매핑의 모델 응답은 문항별 `assignments`에 단일 targetId 또는 null을 반환하고, 위치별 `scope`에는 포함 여부를 한 번씩 반환한다. 서버가 기존 공개 계약의 bindings/unmappedFieldIds/scopeTargetIds로 변환한다. 같은 위치 ID를 반복 출력해 응답 한도를 소진하거나 한 답변을 여러 반복 행에 복제하는 경로를 제한한다. 연도 표는 항목명·안내문의 연도 및 행 근거를 함께 확인한다. HWP/PDF의 응답 계약은 유지한다.

편집 전 `analyze_formfit`으로 탐지 가능한 셀의 명시적 줄바꿈별 너비를 추정한다. 초과 위험은 `OVERFLOW`로 반환한다. 이 검사는 자동 줄바꿈·행 높이·페이지 넘김까지 검증하지 않으며 실제 렌더링과 구분한다. 질문 ID는 모델 출력 스키마에서 제한하고 연결/미연결 목록의 모순은 최대 한 번 수정 요청한 뒤 다시 검증한다.

양식 스냅샷 조회는 큰 JSON을 포함한 MySQL 정렬을 하지 않고 Repository에서 formVersionId 순서로 정렬한다. 기존 문서 지도·답변을 삭제하거나 전역 정렬 버퍼를 높이지 않는다.

`application-document-mcp-v1`의 지도는 sourceSha256, 형식, engineVersion, mapVersion, 실제 nativeLocator, 본문, 주변 문맥, editable/unsupportedReason을 포함한다. 확인하지 못한 표/페이지 정보는 null이며 구조를 추정하지 않는다. HWPX 엔진의 `tN.rN.cN.pN`/`bN` 주소(표·문단은 1-based, 행·열은 XML의 0-based 주소)를 그대로 사용한다. HWP는 hwplib으로 순회한 section/paragraph/table/row/cell 구조 주소를 사용한다. 모호한 문자 offset을 만드는 컨트롤은 editable=false로 전송하며, BMP 문자열과 줄바꿈에 대해 Python/Core의 범위 인덱스를 동일하게 유지한다.

### 보수적 구조 분석 메타데이터

`native-map-v13-pdf-field-labels`는 원본 target 배열의 위치를 `nativeOrderIndex`, 분석 순서를 `semanticOrderIndex`로 각각 기록한다. `readingOrderIndex`는 호환성을 위한 semantic index 별칭이다. targetId, nativeLocator의 물리 주소, target 배열, HWPX XML 노드, PDF 객체 순서는 바꾸지 않는다. HWPX의 병합되지 않은 `FORM_TABLE`에서 같은 행의 왼쪽 라벨 셀과 오른쪽 입력 셀이 모두 확인된 경우에만 행·열 순서의 국소 semantic index를 계산한다. 실제 차이가 있는 target은 `LOCAL_REORDERED`로 표시한다. 병합 셀, 중복 라벨 반복 그룹, 위쪽 공통 열 라벨만 있는 복합 표, target이 다른 구조와 교차 배치된 표는 `REVIEW_REQUIRED`이며 native 순서를 보존한다. 다른 표는 `PRESERVED`다.

HWPX 표 앞의 원문 문단은 번호 패턴, 짧은 길이, 뒤따르는 `FORM_TABLE`, 확인된 입력 필드 수, 주변 텍스트 반복 여부를 조합해 판단한다. 수치가 충분한 경우에만 `semanticSection`, `headingConfidence`, `headingReason`, 단일 단계 `sectionPath`를 기록한다. 일반 문장형 종결 텍스트, 각주·bullet, 기관장 서명 직함은 heading으로 승격하지 않고, `AMBIGUOUS` 표는 form-density 점수를 제공하지 않는다. 현재 Hangeul 검사 결과에 글자 크기·bold·문단 스타일이 없으므로 해당 값을 추측하지 않으며 실제 heading element도 변경하지 않는다.

HWPX 표는 `FORM_TABLE`, `DATA_TABLE`, `LAYOUT_TABLE`, `DECORATIVE_TABLE`, `AMBIGUOUS` 중 하나로 분류하되 삭제하거나 재작성하지 않는다. `analyze_form`이 실제 입력 필드를 반환하면 기본적으로 `FORM_TABLE`이다. 다만 공식 공고 표본에서 확인된 6셀 이하·2행 이하의 `숫자/붙임 번호 | 빈 spacer | 장 제목` 표는 capacity 0/1의 empty cell이 입력칸으로 오인되므로 `LAYOUT_TABLE`로 분류한다. 빈 셀이 있으나 이 명시적 배너 근거가 없으면 자동 제외하지 않고 `AMBIGUOUS` 검토 대상으로 둔다. 필드가 없고 단일 행의 화살표 흐름이 확인되는 경우도 고신뢰 `LAYOUT_TABLE`이다. 따라서 불확실한 표는 기존 native 후보를 보존한다.

같은 HWPX 셀에 여러 문단이 있어도 질문 label은 각 문단에 동일하게 붙는다. 라벨이 있는 셀의 본문이 오직 하나의 공백 괄호 입력 서식으로 구성되고, 해당 문단 외의 형제 문단이 모두 비어 있으며 `analyze_form`의 별도 필드나 list marker가 없을 때만 빈 형제 문단의 `bindingEligible`을 false로 둔다. 원본의 paragraph targetId와 parent 주소, editable 상태는 유지하며 유일한 서식 문단의 native leaf ID를 Mapping과 WritePlan에 그대로 사용한다. 이미 저장된 binding이 제외된 문단을 가리키면 WritePlan 검증에서 `SAVED_BINDING_CHANGED`로 거절한다. 여러 비어 있는 문단, 일반 텍스트, 여러 입력 서식, form field가 있는 셀은 이 규칙으로 축소하지 않는다. 서초구 공식 양식의 두 사례에서는 첫 문단이 빈 `<hp:run/>`, 다음 문단이 공백 괄호 `<hp:t>`였지만 문단 순서 자체를 판정 규칙으로 사용하지 않는다. mapVersion 변경은 pipelineVersion fingerprint도 갱신하므로 Core는 기존 버전의 저장 지도를 재사용하지 않고 다시 매핑한다.

Mapping에서 공식 표의 인쇄 라벨이 여러 문단으로 나뉘어 있어도 셀 전체 텍스트가 질문 라벨과 일치하면 자식 문단 모두를 입력 후보에서 제외한다. 이 셀에 별도 답변 문단이 있다는 근거가 없으므로 라벨 조각에 값을 쓰지 않는다. 기존 지도와 새 판정의 혼용을 막기 위해 mapVersion을 올렸으며, Core는 pipelineVersion 불일치 시 새 매핑을 저장한다.

대형 HWPX에서 원본 target의 본문·context 합계가 400,000자를 넘으면 모델 입력을 모든 target으로 만들지 않는다. 모든 질문에 native `fieldLabels`가 일치하는 편집 가능한 말단 후보가 있을 때만 그 후보의 합집합을 Mapping 입력과 선택 가능 scope로 사용한다. validator가 원래도 각 질문의 라벨 후보 밖 binding을 거절하므로 허용되는 target ID는 줄지 않는다. 후보가 없는 질문이나 축소 후에도 입력이 400,000자를 넘으면 `LIMIT_EXCEEDED`로 중단한다. 검증용 전체 DocumentMap과 물리 주소는 보존한다. 생성 단계는 저장된 scope만 계획 입력에 보이고 같은 문맥 예산을 확인한다. 따라서 대형 문서의 예시 정리 범위는 매핑된 후보 scope에 제한되며, 모든 양식 구역을 자동 정리했다고 주장하지 않는다.

`documentAnalysis`는 readingOrder, heading, tableClassification, mapping, verification 단계의 상태·대상 수·결과 수·검토 수를 선택적으로 보존한다. readingOrder에는 total/reordered/reviewRequired/preserved target 수를, heading에는 candidate/accepted/review 수를 함께 기록한다. 모든 단계는 `nativeTargetsChanged=false`이며 감사 정보가 편집 권한을 갖지 않는다. HWP의 실제 쓰기와 PDF의 AcroForm 배치는 Core가 담당하므로 AI 응답 시점의 verification은 `PENDING_EXTERNAL`이고, HWPX MCP의 apply/verify가 끝난 경우에만 `PASSED`다. 기존 sourceSha256, 저장 bindings/scope, WritePlan, 원본 재검사 규칙은 그대로 적용한다.

WritePlan은 sourceSha256/mapVersion/answerRevision/planHash와 허용 연산만 담는다. 모든 쓰기 값은 저장된 fact ID인 valueRef에서 해결하며 모델이 값이나 코드를 생성할 수 없다. expectedText는 빈 문자열까지 서비스에서 정확히 비교한다. Hangeul 엔진 자체는 빈 expected_text를 검사 생략으로 해석하므로 해당 검사를 위임하지 않는다. 같은 fact의 여러 입력란 사용은 허용하지만 겹친 범위, 중복 주소, 부모 셀과 자식 문단 동시 편집은 거절한다. 범위 인덱스는 Python Unicode code point, 0-based/end-exclusive이다.

Core가 기존 `documentMapSnapshot`의 `pipelineVersion`과 새 버전을 비교해 재매핑할 때, 저장된 binding(field ID·target ID·box)과 편집 scope의 집합이 새 결과와 모두 같아야 MySQL JSON 지도를 갱신한다. 어느 쪽이든 달라지면 `APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED`로 자동 작성을 중단하고 이전 지도·사용자 답변·생성 파일을 보존한다. 생성 응답은 변경 문항·기존/새 위치 문맥과 짧은 승인 토큰을 포함한다. 새 지도 제안은 활성 MySQL 지도와 분리해 Redis에 15분 보관한다. 소유자가 현재 원본 SHA·pipelineVersion·답변 revision을 확인하고 승인하면 MySQL transaction이 해당 작성본 전용 양식 스냅샷을 만들고 그 작성본의 formVersionId만 변경한다. 이전 답변·revision·파일과 다른 사용자의 지도는 유지되며 새 초안 생성은 별도 요청이다.

이관 비교는 fact ID·target ID·binding box와 현재 PDF 필드의 kind·page·widget/box 위치, 선택 scope를 사용한다. Heading/reading-order 같은 semantic metadata만 변한 경우에는 이관으로 보지 않는다. 생성 요청의 422 응답은 native ID 대신 문항명과 기존/새 위치 문맥을 제공한다. 승인하지 않고 취소하면 Redis 승인안만 만료되고 활성 MySQL 지도·답변·파일은 바뀌지 않는다. 승인 transaction의 clone 삽입 후 작성본 revision CAS가 실패하면 둘 다 rollback된다.

공식 문항 추출 뒤 사용자에게 질문을 보여주기 전에 `/document/map`으로 sectionKey:fieldKey와 실제 targetId/box를 연결한다. 답변 값은 이 요청에 포함하지 않는다. 지도·bindings·선택 양식 scope는 기존 양식 스냅샷 JSON의 documentMapSnapshot에 함께 저장하며 공개 응답 DTO에는 노출하지 않는다. 생성 계획은 이 bindings/scope를 벗어나지 못하고 원본에서 주소를 재검증한다. 과거 스냅샷은 지도 필드만 JSON_SET으로 복원하고 기존 문항·사용자 답변·이력은 보존한다. 같은 파이프라인의 첫 검증된 지도는 덮어쓰지 않는다. 유료 호출을 하지 않는 기존 기록 재현(recordedPayload) 경로는 기존 계약을 보존하고, 필요하면 실제 생성 시 지도를 복원한다. 위치 연결 실패는 MAPPING_FAILED로 기록하여 사업 정보 부족으로 다시 질문하지 않는다.

예시 삭제는 색상 필터를 사용하지 않는다. 모델이 의미·문맥과 정확한 문자열 구간을 지정하며, 미답변 예시 삭제에는 valueRef가 없다. 항목명과 예시가 섞이면 지정 구간 외 문자열은 보존한다. 단순하고 위치가 모호하지 않은 구간 변경은 원래 run을 유지하는 최소 확장으로 처리한다. 반복 텍스트 때문에 어느 run을 바꾸는지 모호하거나 보존 run을 합쳐야 하는 변경은 거절한다. 본문을 비워 bN 순번이 달라지는 경우에는 원본/결과를 다시 분석하여 유지된 문단 구조 위치에서 값을 확인한다. 독립 한글 렌더링은 별도 검증이 필요하다.

HWP 작성 계획을 요청할 때는 저장된 선택 양식 scope에 포함된 targets만 모델에 전달하고, bindings는 현재 확정 답변이 있는 문항으로 한정한다. 검증·감사용 원본 지도는 바꾸지 않는다. 미답변 문항은 답변 배치 실패 대상으로 삼지 않으며, 선택 범위 안의 예시 정리는 별도로 판단한다. 모델이 범위 밖 위치를 반환하면 여전히 거절한다. 거절 로그에는 mode/code/고정 reason만 남기며 답변·원문·모델 응답은 기록하지 않는다.

## PDF 좌표·단계

새 입력란의 box는 **회전된 CropBox 화면의 왼쪽 위** 기준 0..1이다. PDFBox는 CropBox 원점과 0/90/180/270도 회전을 반영하여 PDF 포인트로 변환한다. 픽셀을 PDF 포인트로 취급하지 않는다. 예시 삭제는 MCP `pdf_find_text`의 실제 일치 결과를 확인한 뒤 `pdf_replace_single(replacement="", reflow=false)`로 내용 스트림을 수정한다. 흰 사각형은 쓰지 않는다. 같은 문자열이 여러 번 나타나면 잘못된 영역 삭제를 피하기 위해 명시적으로 거절한다. MCP 원시 좌표를 PDFBox 신규 필드 좌표로 재사용하지 않는다.

PDF_PAGE는 읽기 전용이다. 평면 PDF의 Core 렌더 이미지에서 로컬 FFDetr가 탐지한 TextBox만 PDF_INPUT 후보로 제공한다. 원문 표의 빈 칸과 탐지 영역이 충분히 겹치면 최종 경계는 원문에서 측정한 칸을 사용한다. 연락처 등 세부 칸도 원문 라벨로 구분하고, 원문 글자와 겹친 영역은 제외한다. ChoiceButton·Signature는 현재 자동 텍스트 입력 대상이 아니다. 탐지가 없거나 실패하면 선 기반 결과로 대신 성공시키지 않는다. 모델은 위치 ID만 선택하고(box=null), 실제 box와 page-N 변환은 서버의 nativeLocator에서 결정한다. 기존 PDF_FIELD는 Core가 검사한 원래 필드명·대체 표시명을 native `fieldLabels`로 전달해 질문 의미와 다른 필드를 거절하며 FFDetr를 호출하지 않는다. `native-map-v15-pdf-field-scope-options`에서는 AcroForm의 모델이 선택한 field binding으로 최소 편집 scope를 구성하고, 저장 binding에 대한 `set_field` range·box는 코드가 생성한다. Core는 PDF 원본의 display/export 선택지 쌍이나 위젯 caption이 유일하게 대응할 때만 사용자 값을 native 값으로 변환한다. 중복 export label의 라디오는 위젯 인덱스를 native 선택지로 사용한다. 대응 근거가 없거나 중복되어 의미를 확정할 수 없으면 `APPLICATION_DOCUMENT_UNRESOLVED_OPTION`으로 중단한다. Core는 기존 AcroForm 위젯 높이에 맞는 읽을 수 있는 글자 크기(최소 8pt)를 사용하고, 들어가지 않으면 `OVERFLOW`로 거절한다. 한국어 폰트는 기존 NanumGothic을 사용하고, Core가 값·AcroForm 필드 트리·appearance를 재열어 검사한다. 렌더 실행은 사람의 화면 확인과 다르다.

FFDetr는 별도 외부 서비스가 아니라 기존 PDF MCP의 `govbiz_pdf_detect_inputs` 도구로 실행한다. Python 3.12/Linux CPU용 PyTorch·RF-DETR 의존성을 PDF 도구 가상환경에 고정하고, 가중치는 빌드 시 고정 revision과 SHA-256으로 확인한다. stdio 출력과 모델 로그를 분리하고 실행 중 모델 다운로드를 막는다. 모델 프로세스는 요청 후 종료하며 AI worker당 PDF 검사는 직렬화한다. 여러 worker를 사용하면 worker 수만큼 모델이 동시에 실행될 수 있으므로 메모리 산정에 포함해야 한다.

## 입력칸별 질문과 수동 작성 항목

공식 첨부 → OpenAI 질문 추출 → 원본 입력 위치 매핑 → Core 양식 스냅샷 → 질문 UI 순서다. 표 제목 하나로 여러 열을 묻지 않고 각 칸의 원문 열 이름을 질문에 유지한다. 반복 표는 첫 입력 행을 명시한다. HWPX의 실제 표 구조·병합 정보·탐지 필드·라벨 검색 후보와 원문 제목을 지도에 포함하고 질문의 의미와 다른 열을 거절한다. 포괄적인 이전 질문은 FORM_REANALYSIS_REQUIRED로 중단하여 잘못된 첫 열 기입을 막는다.

필수 문항의 위치를 찾지 못하면 양식 검증이 실패한다. 선택 문항 중 지원하지 않는 위치는 documentMap.unmappedFieldIds에 기록하고 공개 fields[].documentWritable=false로 전달한다. 생성 시 binding이 없는 저장 답변은 AI 요청에서 제외하되 삭제하거나 숨기지 않고, 생성 파일에 당시 식별자·표시명·값·사유를 불변 스냅샷으로 보존해 다운로드 화면과 이력에 표시한다. 과거 파일에 스냅샷이 없으면 현재 답변으로 채우지 않는다. binding이 있는 답변이 하나도 없으면 원본을 성공 결과로 반환하지 않는다. 재분석은 기존 discovery-jobs API를 사용자의 명시적 클릭으로 호출하고 GET으로 완료를 기다린다. 기존 작성 건·답변은 유지하며 새 양식에 임의로 재분배하지 않는다.

카탈로그에 등록된 공고의 명시적 재분석은 해당 가용성 행의 실행권을 확보한다. 검증 완료 후 snapshot 저장과 활성 버전 갱신을 기존 Repository transaction으로 묶는다. 실행 중인 다른 작업의 lease를 빼앗지 않으며 과거 snapshot은 삭제하지 않는다. 따라서 재분석 결과는 새 작성에 사용할 수 있고 기존 작성 건은 이전 버전으로 계속 조회할 수 있다.

## 격리·중복 실행·저장

- 파일 경로와 실행 명령은 서버 구성에서만 결정한다. 원본은 job별 임시 디렉터리의 고정 파일명으로 복사한다. 크기 32 MiB, ZIP 256 entries/확장 32 MiB, PDF 50페이지, fact 200개 제한을 유지한다.
- Core와 AI는 동일한 내부 생성 토큰을 사용하고 AI는 body 수신 전에 인증한다. 별도 HWP 브리지 토큰·호스트 포트·Windows 런타임은 없다.
- MCP child 환경에 OpenAI/내부 인증 비밀값을 전달하지 않는다. upstream stderr는 내용 유출 위험 때문에 폐기하며 고정 오류 종류/엔진 이름만 기록한다.
- Core는 Redis의 작성 건별 실행 잠금으로 중복 생성을 막는다. 기존 결과 불명 잠금은 유지하며 자동 삭제하지 않는다. HWP 편집은 요청별 in-memory 원본 복사본에 적용하므로 COM 프로세스와 전역 executor 잠금이 필요 없다.
- HWPX/PDF 중간 파일은 결과 검증을 통과하기 전 다운로드 저장소에 들어가지 않는다. 실패한 복사본을 이어 쓰지 않는다.
- fingerprint는 원본 hash + 입력 revision + 지도/계획 정책과 선택 도구 commit을 포함한 pipelineVersion으로 계산한다. 실제 지도·planHash·검증 결과는 placements_json의 mcp에 보존한다. V38은 fingerprint 고유키를 추가하며 기존 파일은 이력 다운로드로 유지한다.
- 외부 호출은 DB transaction 밖이다. 최종 Repository.save에서 소유권과 revision을 잠그고 재검사한다.

## kordoc

HWP는 Core의 hwplib 구조를 단일 기준으로 사용해 kordoc을 호출하지 않는다. HWPX/PDF 주 분석에 문맥이 없거나 중복된 비어 있지 않은 항목이 있으면 읽기 보조가 필요하다고 판단한다. 그 외에는 SKIPPED_PRIMARY_SUFFICIENT를 기록한다. 별도 읽기 전용 복사본과 `parse_document`만 허용하며 OCR/수식 OCR 다운로드는 끈다. 주 편집기의 원문과 정확히 일치하는 문자열만 연결하며 kordoc 셀 주소를 편집 주소로 전용하지 않는다. 필요한 보조 호출 실패는 생성 실패이다. OS 수준의 완전한 악성 프로세스 sandbox를 제공하는 것은 아니며 운영 실행 계정 권한도 제한해야 한다.

고정 버전 `chrisryugj/kordoc@f715573df1712d415604ac949603a00e387cd3d7`에서 현재 사용하는 공개 경계는 `parse_document`뿐이다. 추가 semantic QA 결과도 기존 `auxiliaryStatus`·`auxiliaryText` 또는 별도의 read-only 분석 메타데이터로만 합칠 수 있다. 확인하지 않은 kordoc 주소나 추정 API를 nativeLocator 또는 WritePlan에 넣지 않는다.

## 지원 범위와 후속 확장 위치

현재 편집 지원 형식은 HWP, HWPX, PDF뿐이다. DOCX, XLSX, XLS, PPTX, Google Forms, 일반 Web Form, Docling 편집, Upstage API, pyhwpx worker는 이번 구현에 포함하지 않는다. 현재 `DocumentMap → native binding → WritePlan → 형식별 native editor → verification` 경계도 `ApplicationMap`으로 이름을 바꾸지 않는다.

DOCX와 XLSX를 추가할 때는 `document_adapters.py`의 기존 구체 adapter와 같은 수준에 각각의 native inspector/editor를 두고, `document_contract.py`의 format 및 target kind를 실제 지원 시점에 명시적으로 확장한다. DOCX는 paragraph/table/content control 주소, XLSX는 workbook/sheet/cell/named range 주소를 사용하며 기존 HWPX/PDF 주소로 변환하지 않는다. 구현 전에는 계약에 빈 형식이나 범용 provider 추상화를 미리 추가하지 않는다.

Google Forms와 일반 Web Form은 파일이 아니므로 현재 MCP의 네 번째 파일 adapter로 넣지 않는다. 후속 구현에서는 신청 준비 Service가 FILE 경로의 DocumentMap과 ONLINE_FORM 경로의 별도 form map을 선택하고, 확인된 Fact mapping과 사용자 검토 단계만 공유하는 방식이 자연스럽다. 외부 Form의 최종 제출 자동화는 별도 권한·동의·사이트 계약 검토 없이는 포함하지 않는다.

### 확인된 빈 run 최소 확장

서초구 공식 신청서(원본 SHA-256 `8d253d5c0f5af214caf28d20f108b106d7261c79334b77f167c3886b4b552c91`)의 기업체명 셀은 `<hp:run charPrIDRef="33"/>`로 되어 있어 고정 Hangeul 엔진이 `no_text_nodes`를 반환했다. `hwpx_mcp_extension.py`는 이 엔진의 in-memory 텍스트 치환 primitive에만 빈 run/t 처리를 추가한다. 원본 파일을 미리 고치거나 별도 편집기로 전환하지 않는다. 기존 charPrIDRef와 문단을 유지하며 이미지·컨트롤·중첩 표·기존 문자가 있으면 확장을 거절한다. 다문단 빈 셀은 실제 조회된 자식 문단이 하나일 때 그 주소로 배치 편집하고 엔진의 확장 문단 검증 결과를 확인한다.

### PDF 한글 문자 매핑 보완

정상적인 PDF `/ToUnicode`가 있고 내장 TrueType subset에 선택적인 `cmap` 테이블이 없는 경우, pdf-edit-engine 0.2.0의 추가 문자 복원 함수가 KeyError를 발생시켜 기존 매핑까지 누락했다. `pdf_mcp_extension.py`는 이 선택적 복원 함수의 명시된 계약대로 추가 매핑이 없음을 반환하고 기존 `/ToUnicode`를 유지한다. 임의 문자·폰트 매핑을 만들지 않는다. 일반 텍스트까지 비어 있거나 Core가 읽은 페이지 텍스트에 대응하는 native layout이 없으면 미지원 오류로 중단한다. 여러 PDF 텍스트 연산자에 나뉜 예시는 주 MCP의 `pdf_detect_paragraphs`가 반환한 실제 문단과 원문 구간으로 묶는다. 이 엔진의 글꼴 크기/문단 bbox는 변환 행렬에 따라 시각적 크기와 다를 수 있어 `geometryVerified=false`로 기록하며, 새 입력란 좌표는 렌더 이미지와 PDFBox CropBox/회전 변환으로 검증한다.

### PDF 위치 보정 경고 처리

일부 한글 PDF의 기울어진 text matrix에서는 삭제 후 상대 위치 보정을 건너뛰었다는 경고가 발생한다. 이 경고를 무조건 통과시키지 않는다. 고정 읽기 검증 도구 `govbiz_verify_pdf_deletion`로 원본과 수정본의 모든 텍스트 이외 연산자가 동일하고, 변경된 텍스트가 전부 빈 문자열이며, 해당 BT/ET 텍스트 객체에 남는 문자가 없음을 확인한 경우에만 경고 사유와 검증 결과를 결과 메타데이터에 보존한다. 다른 degradation, 글꼴 대체, glyph 누락, overflow는 계속 실패 처리한다. 독립 렌더링 확인은 별도 검증 수준이다.
