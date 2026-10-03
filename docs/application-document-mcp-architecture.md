# 신청 문서 MCP 구조

## 현재 호출 경로

React의 저장된 답변·expectedRevision → Core 생성 작업 접수(`POST …/documents/jobs`, 202) → 같은 프로세스의 `ApplicationDocumentGenerationJobWorker`가 claim → `ApplicationDocumentService.generateNow` → 공식 첨부 재수집/hash 확인 → AI `/internal/v1/application-preparations/document/generate` → 원본 복사본 지도 → OpenAI 구조화 수정 계획 → HWP는 Core hwplib 계획 실행 / HWPX·PDF는 MCP → Core 결과 확인 → 소유권/revision 잠금 재확인 → 파일 저장 → 기존 다운로드 API.

| 형식 | 편집 경로 | 현재 검증/제약 |
|---|---|---|
| HWP | Core hwplib 검사 → AI 지도·계획 → Core hwplib 편집·재열기 | 일반 문단·표 셀 구간 및 실제 체크/라디오. 미지원 제어 문자·범위 주석은 거절 |
| HWPX | Hangeul inspect + analyze_form/get_table_map/find_cell_by_label → OpenAI 매핑 → govbiz_hwpx_fit → preview/apply/verify | 셀 주소·병합 구조·항목명 근거 대조. 넘침 검사는 한컴 줄바꿈 규칙의 줄 수 추정이며 한컴 페이지 렌더링이 아님 |
| PDF | FFDetr 입력 영역 탐지 + pdf-edit-mcp 원문 대조/예시 삭제 → Core PDFBox AcroForm → 재열기·appearance·렌더 실행 | 기존 필드는 재사용하며 평면 문서의 탐지 영역은 인쇄 글자와 겹치지 않아야 함. flatten하지 않음 |

HWPX/PDF MCP 서버는 실제 stdio `initialize`, `tools/list`, `tools/call`을 실행한다. HWP는 새 서버 없이 기존 Core JVM에서 hwplib을 호출한다. AI에 `hwpTargets`로 실제 원본 구조를 보내고, `HWPLIB_REQUIRED` 단계의 원본 bytes와 수정 계획을 받는다. Core는 원본 동일성·계획 hash·revision·저장된 bindings/scope를 검사한 뒤 편집하고 `HWPLIB_VERIFIED` 근거와 최종 출력 hash를 저장한다.

## 지도와 계획

HWP 단독 질문 추출은 성공 시점의 프롬프트·출력 한도를 유지한다. HWPX는 자체 XML 표 추정 대신 Hangeul의 `get_table_map`과 `analyze_form`을 읽고, 질문과 일치하는 원문 라벨에 `find_cell_by_label`을 호출한다. 모호한 라벨 후보를 첫 셀로 자동 확정하지 않는다. 표 주소와 셀 텍스트는 독립적인 `inspect_editable_regions` 결과와 대조한다. `analyze_form` 본문 번호는 빈 문단을 제외하므로 편집 주소로 사용하지 않는다.

HWPX 질문 추출도 표 구조를 먼저 읽는다. Core의 discovery 요청에 해당 원본의 `sourceBase64`·`sourceSha256`을 함께 전달하고, AI는 hash·크기를 검증한 임시 복사본에서 nativeLayout을 만든다. OpenAI에는 바이너리가 아닌 기존 원문 블록과 실제 셀·행·열·병합·입력 후보 정보를 보낸다. 원본 bytes는 DB 양식 JSON에 추가 저장하지 않는다. 새 요청 필드를 받는 AI를 먼저 배포한 뒤 Core를 배포한다.

HWPX 매핑의 모델 응답은 문항별 `assignments`에 단일 targetId 또는 null을 반환하고, 위치별 `scope`에는 포함 여부를 한 번씩 반환한다. 서버가 기존 공개 계약의 bindings/unmappedFieldIds/scopeTargetIds로 변환한다. 같은 위치 ID를 반복 출력해 응답 한도를 소진하거나 한 답변을 여러 반복 행에 복제하는 경로를 제한한다. 연도 표는 항목명·안내문의 연도 및 행 근거를 함께 확인한다. HWP/PDF의 응답 계약은 유지한다.

작성 계획을 검증하기 전에 `govbiz_hwpx_fit`(HWPX 도구 확장)이 답을 쓴 셀마다 셀 전체 문구(같은 셀의 다른 문단 포함)의 줄 수를 추정한다. 셀 폭·높이·글자 크기는 Hangeul `analyze`의 셀 정보(`field_id`가 target ID와 같음)에서, 줄 수는 python-hwpx 6.6.0(Apache-2.0) `form_fit.measure.estimate_lines`의 한컴 줄바꿈 규칙에서 얻는다. 한컴은 줄바꿈된 글에 맞춰 행을 늘리므로 칸보다 길다는 것만으로 실패시키지 않고, python-hwpx의 보정값대로 가장 촘촘한 줄 간격 기준 셀 높이의 두 배(최소 2줄 추가)를 넘는 셀만 넘침으로 본다. 병합 행이나 높이를 알 수 없는 셀은 줄바꿈만 하고 넘침으로 보지 않는다. 넘친 셀의 답은 문서의 모든 위치에서 빼고(`skippedFacts`, `OVERFLOW`, 들어가는 대략의 글자 수 `capacity`) 나머지 답을 쓰며, 쓸 답이 없으면 `OVERFLOW`로 실패한다. `apply`는 같은 검사를 다시 해 넘침이 남으면 쓰지 않는다. 이 검사는 페이지 넘김까지 검증하지 않으며 실제 렌더링과 구분한다. 질문 ID는 모델 출력 스키마에서 제한하고 연결/미연결 목록의 모순은 최대 한 번 수정 요청한 뒤 다시 검증한다.

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

공식 문항 추출 뒤 사용자에게 질문을 보여주기 전에 `/document/map`으로 sectionKey:fieldKey와 실제 targetId/box를 연결한다. 답변 값은 이 요청에 포함하지 않는다. 지도·bindings·선택 양식 scope는 기존 양식 스냅샷 JSON의 documentMapSnapshot에 함께 저장하며 공개 응답 DTO에는 노출하지 않는다. 생성 계획은 이 bindings/scope를 벗어나지 못하고 원본에서 주소를 재검증한다. 과거 스냅샷은 지도 필드만 JSON_SET으로 복원하고 기존 문항·사용자 답변·이력은 보존한다. 같은 파이프라인의 첫 검증된 지도는 덮어쓰지 않는다. 위치 연결 실패는 MAPPING_FAILED로 기록하여 사업 정보 부족으로 다시 질문하지 않는다.

모델 계획의 예시 삭제는 색상 필터를 사용하지 않는다(저장 binding의 결정적 계획은 아래 예시 정리 규칙을 따른다). 모델이 의미·문맥과 정확한 문자열 구간을 지정하며, 미답변 예시 삭제에는 valueRef가 없다. 항목명과 예시가 섞이면 지정 구간 외 문자열은 보존한다. 단순하고 위치가 모호하지 않은 구간 변경은 원래 run을 유지하는 최소 확장으로 처리한다. 반복 텍스트 때문에 어느 run을 바꾸는지 모호하거나 보존 run을 합쳐야 하는 변경은 거절한다. 본문을 비워 bN 순번이 달라지는 경우에는 원본/결과를 다시 분석하여 유지된 문단 구조 위치에서 값을 확인한다. 독립 한글 렌더링은 별도 검증이 필요하다.

Core의 HWP 기입(`applyHwpPlan`)은 바뀐 문단의 줄 나눔과 셀 높이를 다시 계산하는데, 셀 안에 표·그림 같은 컨트롤 문단이 있으면 컨트롤 높이를 알 수 없으므로 셀·표 높이는 그대로 두고 바뀐 문단의 줄 나눔만 다시 잡는다(이전에는 생성을 `UNSUPPORTED`로 거절했고, 실제 공고 신청서의 표 안 표가 이 경우였다). 줄 높이는 원본 문단에 저장된 줄 배치 값(lineSeg의 줄 높이·간격·기준선)을 그대로 쓰고, 셀은 답으로 늘어난 줄만큼만 키운다(한 줄 답은 행 높이를 유지한다). 줄은 서버 글꼴(나눔고딕)로 잰 폭이 칸 폭을 넘을 때만 나눈다(서버 글꼴이 한/글 글꼴보다 넓어 여유를 두면 전화번호·이메일 같은 한 줄 답도 두 줄로 잡혀 행이 커졌다). 답 글자는 앞 글자의 글꼴·크기·장평·자간을 쓰되 검은색에 기울임·굵게·밑줄·취소선 없이 쓰고, 선택 표시(`■`·`√`·`○`)는 인쇄된 글자 모양을 따른다. HWPX는 생성 세션에서 `govbiz_hwpx_prepare_answer_styles`가 색이 있거나 꾸민 글자 모양(파란·회색·빨간 예시, 굵은 라벨 등)마다 검은색·꾸밈 없는 복제본을 header에 더한 사본을 만들고, 답만 담은 run의 `charPrIDRef`를 그 복제본으로 바꾼다(라벨과 같은 run에 쓴 답은 원래 모양 유지). 편집기 내부 검증이 실패하면 예외 클래스·메시지·발생 위치를 `application_document_editor_unsupported` 경고로 남긴다(답변 값은 남기지 않음).
HWP 매핑 응답에는 `scopeTargetIds`가 없다. 큰 HWP 양식은 문단 target이 수천 개라 이를 모두 나열한 응답이 실제 공고에서 JSON 중간에 잘렸다(`OUTPUT_TRUNCATED`). 모델은 bindings와 unmappedFieldIds만 답하고, 서버 `hwp_scope`가 바인딩된 문단의 최상위 표(`s{n}-p{n}-t{n}` 접두) 안의 편집 가능한 target 전체, 바인딩된 본문 문단, 바인딩된 선택지의 그룹 전원을 scope로 만든다. 이후 `validate_mapping`·Core 검증·생성 규칙은 그대로 적용된다.
저장된 bindings가 있는 HWP·HWPX·DOCX·XLSX 생성은 모델 계획을 부르지 않고 `deterministic_plan`이 binding마다 연산을 만든다. 빈 text target은 `input`(0,0)이다. 글자가 있는 text target은 `answer_slots`가 다음 순서로 빈칸을 정한다: 빈 날짜 줄(`2026년    월    일`, `.  .  .`)은 날짜 답을 연·월·일로 나눠 쓰고, 인쇄된 선택지(`□`, `[ ]`)는 답과 같은 항목만 `■`·`√`로 표시하며(답이 없는 항목이면 `기타(  )` 빈칸에 쓰고 그 항목을 표시), 예시 문구(`예)`, `(예시)`)는 전체 교체, 밑줄·빈 괄호(`____`, `(   )`)는 괄호를 남기고 안에 쓰며, 괄호 선택지(`유( ) 무( )`)는 `○`로 표시한다. 글머리표만 있으면 그 뒤에, 자리표시자(`000`, `○○○`)는 전체 교체하되 라벨 뒤 자리표시자(`기업명 ㅇㅇㅇ`)는 라벨을 남기고 그 부분만 바꾸며, 한 자리씩 쓰는 숫자 칸(`□□□-□□-□□□□□`, `(우 □□□□□)`)은 자릿수가 같은 답만 칸을 숫자로 바꿔 쓰고(다르면 `SLOT_MISMATCH`), 괄호 하나 안의 선택지(`(동의함 □ 동의하지 않음 □)`)도 답과 같은 항목만 표시한다. 2칸 이상 띄운 빈칸은 앞 라벨·뒤 단위(`명`, `백만원`, `(백만원)`, `달러`, `톤`, `(인)`)를 남기고 단위 쪽 또는 라벨 쪽에 쓰되 남는 공백은 유지해 뒤 글자 위치를 바꾸지 않는다. 글자 사이를 띄운 라벨(`업  체  명`)과 문장 속 공백은 빈칸으로 보지 않는다. `:`로 끝나는 라벨 문단은 한 칸 띄우고 끝에 삽입하며, 그 밖은 예시 문구로 보고 전체 교체한다. 빈칸이 여럿이면 답 항목명과 같은 라벨 뒤의 빈칸 하나를 고르고, 정하지 못하면 `AMBIGUOUS_SLOT`, 답이 인쇄된 선택지나 연도와 다르면 `SLOT_MISMATCH`로 그 답을 계획에서 빼 `skippedFacts`에 담는다(같은 답의 다른 위치도 함께 뺀다). 답 대신 쓰는 파생 문구(띄어쓰기를 붙인 답, `■`·`√`·`○`, 날짜 조각)는 연산의 `literal`에 담기며, `validate_plan`은 같은 규칙으로 다시 계산한 연산과 정확히 같을 때만 받아들이고 모델 계획 스키마의 `literal`은 항상 null이다. Core `applyHwpPlan`은 `literal`이 선택 표시이거나 답의 일부인지 확인한 뒤 쓴다. CHECKBOX는 `set_check`, HWP_FIELD·DOCX_CONTROL은 `set_field`, XLSX_CELL은 `input`이다. 한 text target에 여러 fact가 묶인 경우만 그 fact와 binding으로 축소한 요청을 모델에 보내고 결과 연산을 합친다. 합친 계획도 `validate_plan`의 저장 binding·scope·범위 검증을 그대로 통과해야 하며, 실패는 이전과 같은 code/reason으로 닫힌다. 결정적 계획은 HWP·HWPX에서 fit 검사 뒤 `plan_example_cleanup`으로 작성 예시를 정리한다. 예시는 검사 결과의 `exampleText`(HWP는 Core, HWPX는 확장 inspect가 파란색 또는 본문보다 옅은 회색 글자 모양에서 읽음)이며, 문단 안에 한 구간으로 한 번만 나올 때만 지운다. 답을 쓴 칸(표 밖 문단은 그 문단)의 예시와, 답을 쓴 표에서 답이 없고 채워진 칸이 모두 예시인 샘플 행의 예시를 `delete_range`(valueRef 없음)로 지운다. 답과 겹치거나 맞닿는 예시는 답이 교체한 것으로 보고, HWPX는 답을 쓴 문단 안의 예시를 지우지 않는다(run 보존 편집기가 한 문단의 두 변경을 거절). 답이 없는 표·칸의 예시는 사용자가 직접 쓸 부분이라 남기고, 그 칸 수를 생성 응답 `remainingExampleCount`로 돌려준다. `exampleText`는 매핑·계획 모델 입력에서 뺀다. 예시만 지운 HWPX 칸은 fit 검사를 하지 않는다(글자를 지워 행이 커지지 않음). 이전 실제 실행에서 모델 계획이 `SAVED_BINDING_CHANGED`·`UNRESOLVED_TARGETS`로 흔들리던 문제를 없애기 위한 규칙이다. 칸 규칙·`skippedFacts`·예시 정리 도입으로 `PLAN_VERSION`이 `confirmed-facts-bound-v8-printed-slots-example-cleanup`으로(HWPX 엔진 버전에는 `answer-style-v1`이 붙음), PDF 라벨 순서·탐지 영역 정리와 매핑 프롬프트(인쇄된 선택지·날짜 줄을 그 질문의 입력칸으로 연결) 변경으로 `MAP_VERSION`이 `native-map-v16-pdf-reading-order-choice-lines`로 바뀌어 pipelineVersion이 달라지므로, 저장된 입력칸 매핑은 다음 생성 때 다시 만들어진다(이전 지도의 PDF 영역 ID를 새 검사 결과에 그대로 쓰면 `INVALID_SAVED_SCOPE`가 된다). 모델이 `unresolvedTargets`로 보고한 답은 문서 전체를 실패시키지 않고 `UNRESOLVED`로 `skippedFacts`에 옮기며, 공급하지 않은 ID가 있으면 `INVALID_SKIPPED_FACTS`로 거절한다. PDF 평면 상자는 Core `fillPdfFitting`이 최소 글자 크기로도 넘치는 답만 빼고 다시 써서 같은 미기입 목록에 담는다.
HWP 작성 계획을 모델에 요청하는 경우(저장 binding이 없거나 축소 요청)에는 저장된 선택 양식 scope에 포함된 targets만 모델에 전달하고, bindings는 현재 확정 답변이 있는 문항으로 한정한다. 검증·감사용 원본 지도는 바꾸지 않는다. 미답변 문항은 답변 배치 실패 대상으로 삼지 않으며, 선택 범위 안의 예시 정리는 별도로 판단한다. 모델이 범위 밖 위치를 반환하면 여전히 거절한다. 거절 로그에는 mode/code/고정 reason만 남기며 답변·원문·모델 응답은 기록하지 않는다.

## PDF 좌표·단계

새 입력란의 box는 **회전된 CropBox 화면의 왼쪽 위** 기준 0..1이다. PDFBox는 CropBox 원점과 0/90/180/270도 회전을 반영하여 PDF 포인트로 변환한다. 픽셀을 PDF 포인트로 취급하지 않는다. 예시 삭제는 MCP `pdf_find_text`의 실제 일치 결과를 확인한 뒤 `pdf_replace_single(replacement="", reflow=false)`로 내용 스트림을 수정한다. 흰 사각형은 쓰지 않는다. 같은 문자열이 여러 번 나타나면 잘못된 영역 삭제를 피하기 위해 명시적으로 거절한다. MCP 원시 좌표를 PDFBox 신규 필드 좌표로 재사용하지 않는다.

PDF_PAGE는 읽기 전용이다. 평면 PDF의 Core 렌더 이미지에서 로컬 FFDetr가 탐지한 TextBox만 PDF_INPUT 후보로 제공한다. 원문 표의 빈 칸과 탐지 영역이 충분히 겹치면 최종 경계는 원문에서 측정한 칸을 사용한다. 연락처 등 세부 칸도 원문 라벨로 구분하고, 원문 글자와 겹친 영역은 제외한다. ChoiceButton·Signature는 현재 자동 텍스트 입력 대상이 아니다. 탐지가 없거나 실패하면 선 기반 결과로 대신 성공시키지 않는다. 모델은 위치 ID만 선택하고(box=null), 실제 box와 page-N 변환은 서버의 nativeLocator에서 결정한다. 기존 PDF_FIELD는 Core가 검사한 원래 필드명·대체 표시명을 native `fieldLabels`로 전달해 질문 의미와 다른 필드를 거절하며 FFDetr를 호출하지 않는다. `native-map-v15-pdf-field-scope-options`에서는 AcroForm의 모델이 선택한 field binding으로 최소 편집 scope를 구성하고, 저장 binding에 대한 `set_field` range·box는 코드가 생성한다. Core는 PDF 원본의 display/export 선택지 쌍이나 위젯 caption이 유일하게 대응할 때만 사용자 값을 native 값으로 변환한다. 중복 export label의 라디오는 위젯 인덱스를 native 선택지로 사용한다. 대응 근거가 없거나 중복되어 의미를 확정할 수 없으면 `APPLICATION_DOCUMENT_UNRESOLVED_OPTION`으로 중단한다. Core는 기존 AcroForm 위젯 높이에 맞는 읽을 수 있는 글자 크기(최소 8pt)를 사용하고, 들어가지 않으면 `OVERFLOW`로 거절한다. 한국어 폰트는 기존 NanumGothic을 사용하고, Core가 값·AcroForm 필드 트리·appearance를 재열어 검사한다. 렌더 실행은 사람의 화면 확인과 다르다.

PDF 라벨과 `printedTextRegions`는 pdfminer가 내놓는 순서가 아니라 좌표(줄, 가로 위치) 순으로 정렬한다. pdfminer는 글상자를 묶을 때 객체 주소로 동점을 정해 실행마다 순서가 바뀔 수 있어, 정렬 없이는 '자 본 금'이 '자 금 본'이 되고 같은 PDF의 매핑 요청이 달라졌다. 한 줄에서 한 음절씩 떨어진 두 한글 글자 사이(띄어 쓴 '상   호')에 놓인 탐지 영역은 글자 간격으로 보고 입력 후보에서 뺀다. 표 칸 계산 전에 0.5pt 안팎으로 겹쳐 그려진 선(얇은 사각형 테두리·이중선)을 하나로 합치고, 합친 뒤에도 한 쪽의 가로선 150개·세로선 100개를 넘으면 차트·장식으로 보고 그 쪽만 표 칸 계산을 건너뛴다(문서 전체를 실패시키지 않는다). PDF 도구 확장이 내는 고정 오류 코드(`PDF_GEOMETRY_*`·`PDF_DETECTION_*`)는 사유로 전달하고 `_LIMIT` 코드는 `LIMIT_EXCEEDED`로 분류하며, 그 밖의 도구 원문은 기록하지 않는다. 입력 대상이 3,000개를 넘는 PDF는 HWPX와 같이 `LIMIT_EXCEEDED`(`PDF_TARGET_COUNT`)로 거절한다.

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

현재 편집 지원 형식은 HWP, HWPX, PDF, DOCX, XLSX이다. XLS, XLSM, ODS, CSV, PPTX, Google Forms, 일반 Web Form, Docling 편집, Upstage API, pyhwpx worker는 포함하지 않는다. 현재 `DocumentMap → native binding → WritePlan → 형식별 native editor → verification` 경계도 `ApplicationMap`으로 이름을 바꾸지 않는다.

DOCX와 XLSX의 구체 adapter는 `docx_adapter.py`와 `xlsx_adapter.py`에 있고 기존 adapter와 같은 경계를 사용한다. `document_contract.py`의 format은 실제 지원하는 다섯 형식만 포함한다. DOCX는 paragraph/table/content control 주소, XLSX는 sheet/cell 주소를 사용하고 named range는 validation의 읽기 근거로만 사용하며 기존 HWPX/PDF 주소로 변환하지 않는다. 구현 전에는 계약에 빈 형식이나 범용 provider 추상화를 미리 추가하지 않는다.

Google Forms와 일반 Web Form은 파일이 아니므로 현재 MCP의 네 번째 파일 adapter로 넣지 않는다. 후속 구현에서는 신청 준비 Service가 FILE 경로의 DocumentMap과 ONLINE_FORM 경로의 별도 form map을 선택하고, 확인된 Fact mapping과 사용자 검토 단계만 공유하는 방식이 자연스럽다. 외부 Form의 최종 제출 자동화는 별도 권한·동의·사이트 계약 검토 없이는 포함하지 않는다.

### 확인된 빈 run 최소 확장

서초구 공식 신청서(원본 SHA-256 `8d253d5c0f5af214caf28d20f108b106d7261c79334b77f167c3886b4b552c91`)의 기업체명 셀은 `<hp:run charPrIDRef="33"/>`로 되어 있어 고정 Hangeul 엔진이 `no_text_nodes`를 반환했다. `hwpx_mcp_extension.py`는 이 엔진의 in-memory 텍스트 치환 primitive에만 빈 run/t 처리를 추가한다. 원본 파일을 미리 고치거나 별도 편집기로 전환하지 않는다. 기존 charPrIDRef와 문단을 유지하며 이미지·컨트롤·중첩 표·기존 문자가 있으면 확장을 거절한다. 다문단 빈 셀은 실제 조회된 자식 문단이 하나일 때 그 주소로 배치 편집하고 엔진의 확장 문단 검증 결과를 확인한다.

### 큰 HWPX 양식의 셀 주소 조회 색인

화성시 제출서식(392 KB, 셀 2,200개)은 고정 Hangeul 엔진의 `inspect_editable_regions`가 셀마다 섹션 XML 전체를 다시 훑는(`fill._find_cell_span`) 구조 때문에 약 120초가 걸려 MCP 읽기 시한(100초)을 결정적으로 넘겼다. 재시도로 해결되는 일시 장애가 아니므로 `hwpx_mcp_extension.py`는 서버 시작 시 `fill._find_cell_span`을 섹션당 한 번 만든 `(표 순번, 행, 열) → <hp:tc> 구간` 색인으로 바꾼다. 표 순번은 중첩 표를 포함해 문서 순서로 세고, 셀은 가장 안쪽 열린 표에 속하며, 같은 주소는 먼저 나온 셀이 이기는 원래 의미를 그대로 따른다. 고정 엔진의 함수 원본 해시가 다르면 `GOVBIZ_HWPX_ENGINE_CHANGED`로 서버를 시작하지 않아 엔진을 올릴 때 색인을 다시 검증하게 한다. 주소 체계와 결과는 바뀌지 않으므로 engine version과 저장된 snapshot·binding은 유지된다. MCP 요청 시한 초과는 `TRANSPORT_TIMEOUT`, 그 밖의 전송 실패는 `TRANSPORT_CALL`로 나누어 기록한다.

PDF 세션은 페이지 수에 따라 예산을 잡는다. 로컬 FFDetr는 CPU에서 모델 적재 약 20초, 페이지당 약 2.3초(측정: 빈 페이지 4장 9.2초)가 들고 텍스트 도구가 페이지당 약 1초를 더 쓰므로, 예천군 공고문(1.6 MB, 17쪽 이상)처럼 긴 PDF는 고정 120초를 결정적으로 넘겼다. `PdfDocumentAdapter`는 `60 + 6 × 페이지 수`초를 세션 시한으로 넘기고, `document_session`은 이를 120~220초로 잘라 이 서비스의 240초·Core의 270초 HTTP 시한 아래에 둔다. 세션 단위 실패는 예외 그룹 안의 `TimeoutError`를 찾아 `pdf:session:SESSION_TIMEOUT`처럼 사유를 남기고 메시지 본문은 기록하지 않는다. 매핑 거부 로그에는 바인딩되지 않은 필수 문항 ID를 함께 남긴다.
세션 안에서 우리 쪽 후처리가 던진 예외(검출 좌표 오류 등)는 MCP 실패로 감싸지 않고 그대로 올려 `APPLICATION_DOCUMENT_VALIDATION_FAILED`(reason `PDF_DETECTION_BOX:page-N`)로 이름을 붙인다. 같은 페이지에서 라벨이 있는 검출이 이미 채택된 입력과 겹치면 예전처럼 문서 전체를 거부하지 않고 먼저 채택된(위·왼쪽) 입력만 남기고 나중 것을 버리며 `pdf_detection_overlap_dropped`로 기록한다(예천군 공고문 6쪽의 표에서 발생). 겹치는 대상은 여전히 공개하지 않는다.

색인 뒤에도 같은 양식은 native 입력 대상이 5,769개로 DocumentMap 한도(3,000개)를 넘는다. `HwpxDocumentAdapter.inspect`는 이 경우 스키마 오류 대신 `APPLICATION_DOCUMENT_LIMIT_EXCEEDED`(reason `HWPX_TARGET_COUNT`)를 명시적으로 돌려주고, 발견 API는 이를 413으로 응답한다. Core는 그 첨부만 `NATIVE_TARGET_LIMIT`로 제외하며 남는 문서가 없으면 `TOO_LARGE`로 닫는다. 한도 자체를 올리지 않는 이유는 2,000개가 넘는 셀 layout을 발견 프롬프트에 그대로 넣으면 모델 시한(210초)과 출력 한도를 넘기 때문이며, 큰 양식의 layout 압축은 별도 작업이다.

### PDF 한글 문자 매핑 보완

정상적인 PDF `/ToUnicode`가 있고 내장 TrueType subset에 선택적인 `cmap` 테이블이 없는 경우, pdf-edit-engine 0.2.0의 추가 문자 복원 함수가 KeyError를 발생시켜 기존 매핑까지 누락했다. `pdf_mcp_extension.py`는 이 선택적 복원 함수의 명시된 계약대로 추가 매핑이 없음을 반환하고 기존 `/ToUnicode`를 유지한다. 임의 문자·폰트 매핑을 만들지 않는다. 일반 텍스트까지 비어 있거나 Core가 읽은 페이지 텍스트에 대응하는 native layout이 없으면 미지원 오류로 중단한다. 여러 PDF 텍스트 연산자에 나뉜 예시는 주 MCP의 `pdf_detect_paragraphs`가 반환한 실제 문단과 원문 구간으로 묶는다. 이 엔진의 글꼴 크기/문단 bbox는 변환 행렬에 따라 시각적 크기와 다를 수 있어 `geometryVerified=false`로 기록하며, 새 입력란 좌표는 렌더 이미지와 PDFBox CropBox/회전 변환으로 검증한다.

### PDF 위치 보정 경고 처리

일부 한글 PDF의 기울어진 text matrix에서는 삭제 후 상대 위치 보정을 건너뛰었다는 경고가 발생한다. 이 경고를 무조건 통과시키지 않는다. 고정 읽기 검증 도구 `govbiz_verify_pdf_deletion`로 원본과 수정본의 모든 텍스트 이외 연산자가 동일하고, 변경된 텍스트가 전부 빈 문자열이며, 해당 BT/ET 텍스트 객체에 남는 문자가 없음을 확인한 경우에만 경고 사유와 검증 결과를 결과 메타데이터에 보존한다. 다른 degradation, 글꼴 대체, glyph 누락, overflow는 계속 실패 처리한다. 독립 렌더링 확인은 별도 검증 수준이다.


### XLSX native 셀과 보존 경계

`xlsx:s:{URL-encoded sheetName}:c:{A1-address}`를 사용한다. sheetName·cellAddress·row·column·raw value·displayValue·dataType·cellType·numberFormat·formula·mergedMaster/Range·hidden·protected·locked·editable·fieldLabels·rowLabels·columnLabels·tableHeadings·sectionPath·dataValidation을 nativeLocator에 저장한다.
`DocumentMap.workbookMetadata`에는 sheet name/state, used range, merged ranges, freeze pane, named tables, data validations, formula count와 보호 상태가 있다. 빈 지도 메타데이터는 기존 형식 모델 입력에서 제외한다.

Mapping은 label 근거와 실제 XML 셀을 가진 editable 후보만 전달한다. 병합 master는 독립적인 label 근거가 있을 때만 후보이고 child는 미지원이다. header가 확인된 반복 표는 첫 빈 슬롯만 선택하고 Excel named table은 DATA_TABLE로 읽기 전용이다. FORM_REGION/DATA_TABLE/SUMMARY_REGION/AMBIGUOUS는 필터와 문맥일 뿐 구조 변경 권한이 아니다.

수식은 `FORMULA_CELL`, hidden sheet/row/column은 `HIDDEN_CELL`, 보호된 workbook 또는 보호 sheet의 locked 셀은 `PROTECTED_CELL`로 거절한다. 보호 sheet의 명시적 unlocked 셀은 다른 후보 조건도 만족해야 작성한다. default locked라도 sheet protection이 꺼져 있으면 보호 셀로 보지 않는다.
List validation은 inline 문자열, 단일 명시 범위와 해석 가능한 named range만 처리한다. 숨긴 option source의 값은 읽을 수 있지만 그 sheet는 입력 후보가 아니다. type이 생략되고 formula1/formula2가 없는 단일 안내문 규칙은 입력 제약이 없는 `promptOnly`로 보존한다. 날짜·숫자 형식 검증은 유지한다. 수식/동적 범위/빈 option/중복 규칙·실제 non-list validation은 `UNRESOLVED_OPTION`로 중단한다. 옵션의 의미를 추정하거나 새 값을 추가하지 않는다.

native write는 기존 `input` 또는 `set_field`를 재사용하며 빈 셀에만 적용한다. delete/replace/구조 편집은 허용하지 않는다. apply가 sourceSha256·mapVersion·engineVersion·실제 재검사한 셀의 editable 상태를 다시 확인한다. 날짜 및 숫자는 명시 형식만 변환하고 식별자와 =로 시작하는 사용자 문자열은 literal text로 유지한다.
작성 후 workbook을 다시 열어 값·sheet metadata를 확인하고, 승인 셀의 값 payload만 제외한 전체 worksheet XML과 다른 ZIP 파트를 비교한다. 수식 및 cached value, 스타일, merged range, validation, conditional formatting, workbook properties, row/column dimension과 hidden state의 보존이 검증돼야 한다.

ZIP entry 512개, 압축 해제 합계 32 MiB, 전체 used grid 100,000칸, sheet 30개, native target 3,000개 제한을 적용한다. XML DTD/ENTITY, 암호 ZIP, 중복/경로 탈출 entry, macro/signature, external calculation link, embedded/ActiveX/form control, drawing/chart는 미지원으로 중단한다. 원본 binary와 작성본은 평가 자료에 저장하지 않는다.

주석만 표시하는 VML과 목록형 확장 데이터 검증은 원본 구조를 확인해 허용한다. 확장 목록의 실제 허용값은 native mapping에 전달하며, 편집 시 변경 대상 셀 XML만 교체해 주석·VML·검증 XML을 보존한다. 다른 VML 컨트롤이나 해석할 수 없는 검증 규칙은 계속 거절한다. 서식만 적용된 대규모 빈 범위는 문항 근거에서 제외하고, native inspect에서도 문항 라벨·검증 규칙이 없는 빈 셀만 대상 목록에서 생략한다.

XLSX label 근거에는 visible sheet/row/column의 텍스트만 사용합니다. 숨긴 label 옆의 visible blank도 입력 근거가 없으면 제외합니다. validation의 `sourceRange`는 적용 범위(sqref)이고 실제 option source는 `formula1`에 원문 그대로 기록합니다.

### 상위 업무 mapping과 MCP 경계

Phase 5-1의 `ApplicationFieldMapping`은 Core의 공식 문항 + 검증된 FILE binding에서 계산하는 업무 projection이다.
`DocumentMap`은 계속 FILE native map이고 두 계약은 동일하지 않다. 상위 mapping은 문항 ID/label/required,
status/writable과 targetId/box 참조만 읽으며 전체 DocumentMap/NativeTarget/nativeLocator와 편집 scope는 소유하지 않는다.
문서 생성 Service의 답변 분리에는 projection을 사용하고, 실제 MCP 생성에는 기존 snapshot bindings/scope를 전달한다.
FILE write authority와 sourceSha256/mapVersion/pipelineVersion/engineVersion/WritePlan/planHash/verification은 유지한다.
기존 migration diff와 승인 계약, 다섯 format의 JSON shape, 저장 스키마는 변경하지 않는다.

ONLINE_FORM은 Phase 5-2에서 별도 FormMap 계약을 가지며 DocumentMap/NativeTarget/WritePlan/native editor를 공유하지 않는다.
현재 외부 provider/format, Form API, OAuth, 브라우저 파싱·자동화와 제출 구현은 없다.
[상위 projection의 호출 흐름과 확장 위치](architecture.md#phase-5-1-신청-문항-상위-매핑-경계)를 참고한다.

## Phase 5-2: ONLINE_FORM 매핑 계약과 작성 능력

FILE의 DocumentMap과 ONLINE_FORM의 ApplicationOnlineFormMap은 서로 다른 계약이다.
공유하는 ApplicationFieldMapping은 공식 문항 identity, label, required, mapping 상태와 binding 참조를 투영한다.
mapped는 MAPPED 상태와 binding 존재, autoFillSupported는 현재 FILE 실행 경로의 지원 여부,
writable은 mapped && autoFillSupported다. MAPPED와 WRITABLE은 동일하지 않다.
FILE은 기존 targetId/box와 복수 binding을 유지하고 DocumentMap → bindings/scope → WritePlan →
native editor → verification의 권한 경계를 변경하지 않는다.

ApplicationOnlineFormMap(schemaVersion=1, formId, controls)은 확인된 fieldId/controlId/label/required만 담는다.
Phase 5-2의 Manifest + FormMap → ApplicationFieldMapping domain projection은 Phase 5-3에서 읽기 전용 Service에 연결했다. HTTP에는 노출하지 않는다.
공식 문항 순서·표시명·required는 Manifest를 따른다. 알 수 없는 fieldId, required 충돌, 빈 controlId,
중복 controlId 및 한 문항의 복수 control은 명시적으로 거절한다. 복수 control의 분할·선택·반복 의미는
확인되지 않았으므로 검토 후 후속 단계에서 결정한다. 누락된 필수 문항은 REQUIRED_MAPPING_MISSING,
선택 문항은 UNMAPPED다. ONLINE_FORM binding은 sourceType=ONLINE_FORM, referenceId=controlId, box=null이며
기존 FILE 호출 호환을 위해 저장 property 이름 targetId를 유지한다.

ONLINE_FORM은 source 기반 매핑 검토까지 구현됐으며 mapped=true여도 autoFillSupported=false, writable=false다.
실제 자동 작성·제출, 외부 Form API/OAuth, DOM/브라우저 자동화, persistence, DB migration,
public endpoint 및 document MCP format 확장은 없다. 사용자 Fact 값이나 사용자 검토 완료를 mapping 성공으로
추정하지 않는다. ApplicationDocumentService는 기존 FILE projection만 사용한다.
평가 fixture와 검증 범위는 [Phase 5-2 평가 보고서](../evaluation/application-map/runs/phase5-online-form-map-20260927-v1/README.md)를 참고한다.

## Phase 5-3: ONLINE_FORM Source와 읽기 전용 검토

`ApplicationPreparationService.reviewOnlineFormMapping(account, preparationId, source)`는
`repository.findOwned(account.id, preparationId)`로 소유권을 확인하고 preparation의 고정
formVersionId에 해당하는 Manifest를 조회한다. 없는 preparation과 다른 계정의 preparation은
기존 ApplicationPreparationNotFoundException으로 처리하며 Manifest 조회도 수행하지 않는다.

흐름은 `ApplicationOnlineFormSource → Manifest.reviewOnlineForm → ApplicationOnlineFormMap
→ manifest.fieldMappings(formMap) → ApplicationOnlineFormMappingReviewResult`다.
Source는 schemaVersion=1, formId, formTitle, controls[{controlId, label, required}]만 소유한다.
중복 controlId, 빈 identity/label과 미지원 schema는 거절한다. DOM·locator·인증 정보는 없다.

매칭은 앞뒤 공백 제거 및 연속 whitespace(줄바꿈·탭 포함)를 한 칸으로 치환한 label의 정확한
일치만 사용한다. case·숫자·괄호·단어를 제거하거나 fuzzy/LLM 매칭하지 않는다.
Manifest와 source 양쪽에서 label이 유일하고 required가 동일해야 confirmed control이 된다.
동일 label의 복수 source 또는 Manifest 문항은 AMBIGUOUS_CONTROL, 필수 여부 충돌은
REQUIRED_FLAG_MISMATCH로 검토하며 FormMap에 넣지 않는다.
필수 문항의 후보가 없으면 REQUIRED_CONTROL_NOT_FOUND와 REQUIRED_MAPPING_MISSING,
선택 문항의 후보가 없으면 issue 없이 UNMAPPED다. Manifest label과 무관한 source control은
UNMATCHED_SOURCE_CONTROL로 표시하며 다른 정상 매핑은 유지한다.

Service Result는 source formId/formTitle, 기존 fieldMappings, 최소 issue context만 반환한다.
mappedCount는 매핑 문항 수, unmappedCount는 필수 누락을 포함한 미매핑 문항 수,
requiredMissingCount는 REQUIRED_MAPPING_MISSING 문항 수, reviewRequiredCount는 issue 수다.
충돌 후보는 해당 issue로 표시하고 unmatched로 중복 집계하지 않는다.
confirmed ONLINE_FORM도 mapped=true, autoFillSupported=false, writable=false다.
DB write·revision/Fact/snapshot 변경·schema/Flyway 변경은 없다.
외부 source collector, public HTTP, persistence, browser automation, auto fill, submit은 아직 없다.
기존 FILE DocumentMap/NativeTarget/WritePlan 및 5-format 실행 경로, AI/MCP 계약은 유지한다.

검증 범위와 결과는 [Phase 5-3 평가 보고서](../evaluation/application-map/runs/phase5-online-form-source-review-20260927-v1/README.md)를 참고한다.

## Phase 5-4: ONLINE_FORM 외부 소스 접근 능력

도입 이전 판정은 PHASE5_EXTERNAL_SOURCE_PARTIAL이었으며 당시 지원 provider/collector는 없었다.
ApplicationOnlineFormSourceReference는 sourceUrl과 provider 문자열만 가진다.
HTTPS·host·길이·provider 형식을 검증하고 userinfo·명시적 port·fragment를 거절한다.
URL과 query는 toString 및 validation 오류에서 숨긴다. 이 검증은 SSRF 안전 판정이 아니다.

ApplicationPreparationService.checkOnlineFormSourceCapability는
findOwned → 고정 Manifest 조회 → provider/URL 계약 확인 → Capability Result로 이어진다.
이전에는 GOOGLE_FORMS의 edit/viewform 및 forms.gle 참조를 모두 REQUIRES_AUTH로 판정했다.
현재는 공개 responder viewform과 forms.gle short URL을 PUBLIC_READ_SUPPORTED 후보로,
edit URL을 REQUIRES_AUTH로, 나머지를 UNSUPPORTED_PROVIDER로 분류한다.
이 판정에는 외부 I/O가 없으므로 실제 공개 여부와 redirect destination은 inspection에서 확인한다.
responder ID를 공식 API formId로 추측하지 않는다.

Google forms.get은 OAuth scope와 접근 가능한 formId가 필요하다.
현재 Google 로그인은 openid email이며 Forms body scope, token 보관·갱신·소유권 연결이 없다.
응답자 URL만으로 공식 API 읽기 권한을 가정하지 않는다. 일반 HTML은 표준 form 계약이 있으나
이 프로젝트의 concrete target이 없어 generic scraper를 구현하지 않는다.
Capability check에는 외부 HTTP/DNS/redirect 요청이 없다. 별도 public reader의 SSRF·redirect·timeout·응답 크기 제한은 아래 읽기 경로에 적용한다.

기존 reviewOnlineFormMapping(account, preparationId, source)는 그대로 유지한다.
당시에는 외부 참조에서 Source로 이어지는 성공 경로가 없었다. DB write·Fact/revision/snapshot 변경,
public HTTP API·Frontend·자동 입력·제출·응답 조회·FILE/DB schema 변경은 없다.

[Phase 5-4 평가 기록](../evaluation/application-map/runs/phase5-online-form-source-acquisition-20260928-v1/README.md)을 참고한다.


## 공개 Google Form 질문 조회 (`skn-31`)

이미 확보된 공개 Google Forms responder URL의 읽기 전용 검사 경로는 `ApplicationPreparationService.inspectPublicOnlineForm → ApplicationOnlineFormMcpClient → AI Service /internal/v1/application-preparations/online-form/inspect → 별도 단기 stdio Google Public Form Reader MCP → 익명 GET → ApplicationOnlineFormSource → 기존 reviewOnlineForm`이다. 이 Manifest 매핑 경로에는 공개 Controller를 두지 않고, 구글 설문 답변 미리 채우기는 `ApplicationGoogleFormController`가 같은 reader를 쓴다. Document MCP와 FILE 형식은 그대로다. `DOCUMENT_INTERNAL_TOKEN`으로 기존 Core ↔ AI 내부 인증을 재사용한다. Form 검사 과정에서 OpenAI를 호출하거나 DB에 snapshot을 쓰지 않는다.

Reader는 `docs.google.com/forms/.../viewform`과 `forms.gle`만 허용하고 각 redirect와 DNS 결과를 검사한다. TLS 검증을 유지한 채 확인한 공인 IP로 연결하며 GET만 보낸다. Cookie, OAuth, 사용자 브라우저 세션은 전달하지 않는다. HTML 응답은 4 MiB, redirect는 최대 3회다. 질문은 공개 HTML의 `role=listitem`, `role=heading`, 입력 요소, `aria-required`, radio/checkbox/listbox의 접근성 표시에서만 읽는다. 복수 페이지는 현재 화면에 없는 질문을 완전한 양식으로 오인하지 않도록 거절한다.

Capability의 `PUBLIC_READ_SUPPORTED`는 URL/provider가 공개 reader 시도 대상이라는 뜻이며 실제 조회 성공을 보장하지 않는다. `/edit`는 `REQUIRES_AUTH`, Google 외 URL은 `UNSUPPORTED_PROVIDER`다. `forms.gle` redirect의 최종 목적지는 MCP inspection에서 검증한다.

`controlId`는 질문 순서와 정규화한 label/type/options의 hash로 만든 snapshot 내부 식별자다. Google 발급 questionId나 제출용 entry ID가 아니다. `semanticFingerprint`는 제목과 질문 순서·label·required·type·options를 정규화한 값이며 HTML nonce와 무관하다. 지원 근거가 없는 질문은 `UNKNOWN`으로 반환하고 Core 매핑 경로는 실패시켜 부분 매핑을 막는다. 이 HTML은 공식 Forms API 계약이 아니므로 Google의 DOM 변경 시 명시적 오류가 발생할 수 있다. 로그인 필요, 조건부 분기, 자동입력·제출은 지원하지 않는다.
