# EPA 공식 AcroForm PDF 실파일 검증

실행일: 2026-09-25. 표본은 [미국 EPA의 보조금 신청용 Key Contacts Form](https://www.epa.gov/grants/epa-applicant-and-recipient-forms)에 등록된 [공식 PDF](https://www.epa.gov/system/files/documents/2021-08/epa_form_5700_54.pdf)다. 원본 250,983 B, 2페이지, SHA-256 `0cb27836b74d5f469e4ddac81fd294555516ed529b9a8d7b49ee816fa7d9a89c`. 원본·수정본과 Core 요청 base64는 저장소에 넣지 않았다. 이 표본은 형식별 AcroForm 엔진 검증이며 SKN34의 한국 제공처 수집 경로를 검증한 것은 아니다.

## Inspect와 Ground Truth

Core PDFBox와 독립 pypdf 모두 원본에서 AcroForm 필드 60개·위젯 60개·XFA 없음·기존 값 없음으로 읽었다. 실제 필드 유형은 모두 텍스트다. 현재 AI PDF MCP `inspect_document`는 `PDF_FIELD` 60개와 `PDF_TEXT` 79개를 만들고 원본 SHA를 보존했다. 각 필드의 targetId, fieldType, editable, options, widget 페이지·좌표 및 native field label은 [field-inspection.json](field-inspection.json)에 기록했다.

Poppler 렌더의 1페이지 `Authorized Representative` 구역에서 First Name, Last Name, Title, Street1, City, Phone Number, E-mail Address의 7개 위치를 사람이 대조했다. [Ground Truth](../../expected/epa-key-contacts-acroform-2026-v1.json)의 expected target ID는 모델 입력에 넣지 않았다. 실제 입력은 별도 [blind 질문](../../blind-epa-key-contacts-acroform-2026-v1.json)이다. 같은 이름의 필드가 Payee·Administrative Contact·Project Manager에 반복되어 각 질문에는 4개씩 native 라벨 후보가 있었다.

## Mapping → WritePlan → PDFBox

`mapVersion=native-map-v13-pdf-field-labels`에서 Core가 제공한 실제 필드 이름을 AI 지도 `fieldLabels`로 전달한다. 라벨이 다른 `PDF_FIELD`는 validator가 거절한다. production 문맥 `gpt-5.6-luna` Mapping **1회** 결과는 [mapping.json](mapping.json)에 있으며 **Correct 7/7, Wrong 0, Unmapped 0, validator PASS**다.

실제 모델이 선택한 7개 주소를 Ground Truth와 대조한 후, 그중 5개에 가상값을 쓰는 `set_field` WritePlan을 평가자가 구성했다. `validate_plan`과 PDF MCP stage는 [stage-summary.json](stage-summary.json)의 5개 기존 `PDF_FIELD`, `box=null`, `PDFBOX_REQUIRED`를 확인했다. WritePlan 모델 호출은 하지 않았다.

첫 Core PDFBox 작성은 공식 위젯 높이 약 12.7pt에 기존 고정 여백·10pt 크기 검사를 적용해 `OVERFLOW`로 중단됐다. 실제 위젯 크기에서 최소 8pt와 세로 여백 2pt를 만족할 때만 크기를 조정하도록 수정했다. 너무 낮은 위젯은 계속 `OVERFLOW`다. 수정 후 작성본의 재열기에서 **값 5/5, 필드 60개, 위젯 60개, 선택 필드의 appearance 5개, 다른 필드 값 55개 보존**을 확인했다. Core 출력 재inspect도 2페이지·`PDF_FIELD` 60개를 읽었다.

Poppler 원본·출력 두 페이지의 같은 해상도 렌더 비교에서 변경 픽셀은 1페이지의 선택된 5개 위젯 안에만 있었고 2페이지 변경은 0이었다. 화면에서 값 잘림·라벨 겹침은 관찰되지 않았다. 원본 SHA는 유지됐다. 체크박스·라디오·choice는 이 공식 문서에 없으므로 `NOT_RUN`이며 다른 AcroForm PDF나 실제 Reader UI 재편집의 일반화는 입증하지 않는다.
