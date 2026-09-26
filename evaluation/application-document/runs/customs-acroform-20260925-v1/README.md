# 관세청 제공 공식 AcroForm PDF 실파일 평가

평가일: 2026-09-25~26. 분류: `TECHNICAL_AUX_SAMPLE`. 출처는 [관세청 해외통관지원센터 공지](https://www.customs.go.kr/foreign/na/ntt/selectNttInfo.do?bbsId=1424&mi=3174&nttSn=10136414&nttSnUrl=d39be01eee57f928b9050604f81caf55)의 첨부 3번 `Producer Exporter Certificate Fillable Form.pdf`다. 한국 공공기관이 공식 제공하는 PDF이지만 서식 작성·발행 기관은 튀르키예 무역부다. 따라서 한국 공식 제공 경로의 AcroForm 사례이며 한국 기관이 제작한 지원사업 신청서의 일반화 근거는 아니다. 원본과 출력본은 저장소 밖 임시 폴더에만 두었다.

## 원본과 Ground Truth

원본 177,140 B, SHA-256 `dceb9ad371a121dcde82c408f511a23c14518a81af334be15965bd53829d52cf`, 1페이지다. 독립 pypdf와 production Core PDFBox inspect에서 필드 42개(텍스트 41, 라디오 1), 위젯 46개, XFA 없음이 확인됐다. production PDF MCP는 `PDF_FIELD` 42개와 읽기 전용 `PDF_TEXT` 68개를 만들었다. [필드 메타데이터](field-inspection.json)에 targetId, fieldType, editable, options, widgets, page, native label을 기록했다. 원본 라디오는 YES가 선택된 상태이며 `/0`은 YES, `/1`은 NO 위젯이다. `/Opt`에는 두 선택지 모두 `Evet`로 들어 있어 PDFBox가 export label을 하나로 합쳤다. `native-map-v14-pdf-radio-index`에서는 이 중복을 인덱스 `0`, `1`로 노출한다. 화면의 YES/NO 의미는 사람의 원본 렌더와 위젯 좌표로 대조했다.

Poppler 원본 렌더와 필드 좌표로 B 생산자·C 판매자·D 수입자·G 담당자 텍스트 필드 4개 및 C YES/NO 라디오 1개를 [Ground Truth](../../expected/customs-certificate-acroform-2026-v1.json)로 고정했다. 모델 입력은 [blind 질문](../../blind-customs-certificate-acroform-2026-v1.json)만 사용했으며 Ground Truth target ID와 가상값은 주지 않았다. 반복 회사명 3개에는 각각 native 후보가 3개였다.

## OpenAI Mapping 1회

production 문맥 `gpt-5.6-luna`, `store=false`, 재시도 0, 유료 호출 1회다. [채점 결과](mapping.json)는 **Correct 5/5, Wrong 0, Unmapped 0, Wrong Target Rate 0%**다. 그러나 모델의 scope와 binding이 일치하지 않아 production `validate_mapping`이 `MAPPING_TARGET_NOT_EDITABLE_OR_OUT_OF_SCOPE`로 **FAIL**했다. 따라서 이 결과를 production Mapping 성공으로 보지 않는다. 모델 호출은 반복하지 않았다. 해당 호출은 변경 전 `native-map-v13-pdf-field-labels`에서 수행됐으며 라디오 인덱스를 반영한 v14에 대한 유료 Mapping 재평가는 수행하지 않았다.

[실패 진단 데이터](validator-diagnosis.json)는 저장된 원래 모델의 target ID 5개와 v13 inspect 지도에서 각 target이 모두 편집 가능한 `PDF_FIELD`였음을 대조한다. 원래 `scopeTargetIds` 원시 응답은 저장되지 않아 어느 ID가 누락됐는지는 복원할 수 없다. 위 reason의 나머지 조건을 배제해 적어도 한 binding target이 모델 scope에 없었다고 추론한다. `operation`, `expectedText`, `start`, `end`는 Mapping 응답의 필드가 아니며 별도의 사람이 구성한 WritePlan 값으로 구분해 기록했다.

후속 [무과금 validator 재현](validator-replay-v15.json)은 보존된 5개 target 선택에 빈 scope를 적용할 때 같은 reason이 발생하고, binding 자체로 최소 scope를 구성하면 validator가 통과함을 확인했다. 이는 원래 모델의 저장되지 않은 scope를 복원하거나 v15에서 새 OpenAI Mapping을 실행한 결과가 아니다.

## 사람이 확인한 위치의 downstream Write

Mapping 대상 5개가 Ground Truth와 모두 일치한 뒤, 평가자가 그 위치만으로 가상값 WritePlan을 만들었다. 이는 validator 실패를 우회한 production Mapping 성공이 아니다. production PDF MCP stage는 기존 `PDF_FIELD` 5개, `box=null`, `PDFBOX_REQUIRED`를 반환했다. [stage 요약](stage-summary.json)에는 base64 원본·결과를 제외했다.

최초 Core PDFBox 작성은 약 11pt 높이의 공식 텍스트 위젯이 기존 세로 여백 기준에 걸려 `OVERFLOW`로 중단됐다. 최소 8pt 기준을 유지하며 기존 AcroForm 텍스트 필드의 세로 여백·줄 높이 검사만 조정했다. 중복 라디오 export label은 위젯 인덱스 1을 사용해 NO를 선택하도록 했다. 수정 후 복사본 작성·재열기에서 텍스트 4/4, 라디오 1/1, 총 지정 값 5/5, 라디오 상태 `[Off, 1]`을 확인했다. 다른 라디오 옵션은 자동 해제됐다. 다른 필드 값 변경 0, 필드 42/42, 위젯 46/46, 페이지 1/1을 독립 pypdf로 확인했다. 지정 필드 5개의 appearance가 존재했다. 수정 대상 밖 위젯 39개의 이름·좌표·appearance 선택지·상태가 모두 유지됐다. 100dpi 원본·출력 렌더의 변경 픽셀 2,171개는 모두 지정 위젯 영역에 있었고 외부 변경은 0이었다.

원본이 생산자 회사명 한 필드를 표와 선언문 점선에 중복 위젯으로 배치해 출력 가상값이 두 곳에 표시된다. 선언문 쪽 값은 원래 인쇄된 점선과 겹쳐 보인다. 기존 PDF의 구조에 따른 화면 품질 한계이며 Reader UI에서 재편집은 확인하지 않았다. 이 문서에는 checkbox·choice가 없으므로 해당 유형의 한국 공식 제공 표본은 `OFFICIAL_SAMPLE_NOT_FOUND`, 실제 작성 검증은 `NOT_RUN`이다.

## 판정

라디오 native 저장과 재열기는 통과했지만, production Mapping validator 실패와 의미값 `YES`/`NO`를 내부 인덱스 `0`/`1`로 안전하게 연결하는 사용자 흐름은 미검증이다. 이 문서만으로 AcroForm 선택형을 `STABLE`로 선언할 수 없다. 실제 한국 기관 제작 신청서, checkbox·choice, Reader UI 재편집, 최신 v14 OpenAI Mapping, 원격 CI·배포 검증도 수행하지 않았다.
