# 공식 flat PDF FFDetr → Mapping → PDFBox 실파일 검증

실행일: 2026-09-25. 공식 원본은 [기업마당 부산 항공부품산업 기술고도화 지원사업 신청서](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000122391)의 PDF 첨부 `FILE_000000000756959/1`이다. 원본 324,743 B, 11페이지, SHA-256 `4c90df4a5282dd62ae550bb1676766a550089dce7509192008feee988b24bde3`. 기존 AcroForm 필드와 위젯은 0개이며 표와 인쇄 라벨, 빈 칸이 있는 flat PDF다. 원본·수정본과 Core 요청의 base64는 저장소에 넣지 않았다.

## FFDetr 및 native evidence

기존 AI 이미지의 고정 FFDetr 가중치 SHA-256 `f852e1bac18c8f435b82270fc8ff8e2ca4a2cd8869c411fa8f473f16e69585ef`와 PDF MCP를 네트워크 차단 컨테이너에서 실행했다. Core PDFBox가 원본을 inspect하여 11페이지의 페이지 이미지와 text target을 제공했고, production `PdfDocumentAdapter.inspect`가 FFDetr 탐지와 PDF 글자·표 좌표를 결합했다. 원본 detector 제안은 페이지별 `5, 2, 1, 3, 89, 14, 15, 2, 2, 4, 0`개, 최종 `PDF_INPUT`은 106개다. 문서 map은 `PDF_PAGE` 11개, `PDF_TEXT` 207개를 포함한다. 페이지별 `printedTextRegions`·`blankRegions`, 각 입력 후보의 confidence·label·box는 [detector-inspection.json](detector-inspection.json)에 기록했다.

첫 production inspect는 5페이지의 빽빽한 일정 격자에서 라벨 없는 중복 FFDetr 영역이 이미 채택한 영역과 겹쳐 `PDF_DETECTION_OVERLAP`으로 중단됐다. 겹친 새 후보의 `fieldLabels=[]`인 경우에만 그 후보를 폐기했다. 라벨이 있는 영역의 겹침은 계속 오류다. 수정 후 전체 11페이지 inspect가 통과하고 원본 SHA가 유지됐다. 이 변경은 겹친 영역을 출력하지 않으며, 모델에 라벨 없는 중복 후보를 추가하지 않는다.

## 사람 검토 Ground Truth와 Mapping

Poppler 렌더의 2페이지 기업 소개 표와 6페이지 성장 계획 표에서 5개 빈 칸을 직접 확인했다. [Ground Truth](../../expected/busan-flat-pdf-2026-v1.json)는 field ID, expected page, native target ID와 가상값을 보관하며 모델 입력에는 넣지 않았다. 모델 입력은 별도 [blind 질문](../../blind-busan-flat-pdf-2026-v1.json), Core 요청 및 production DocumentMap이다.

| Field | 기대 페이지 | 기대 PDF_INPUT | detector confidence | production 라벨 후보 수 |
|---|---:|---|---:|---:|
| 기업명 | 2 | `pdf-blank:1:ffdetr-0` | 0.422 | 2 |
| 대표자명 | 2 | `pdf-blank:1:ffdetr-1` | 0.400 | 3 |
| 2026 지원사업 매출액 | 6 | `pdf-blank:5:ffdetr-3` | 0.406 | 1 |
| 2026 기업 총 고용인원 | 6 | `pdf-blank:5:ffdetr-7` | 0.524 | 1 |
| 2026 신규고용 | 6 | `pdf-blank:5:ffdetr-8` | 0.453 | 1 |

Ground Truth 5개 모두 production의 라벨 후보에 포함됐다. 각 box는 정규화된 페이지 범위 안에 있고 `printedTextRegions`와 교차하지 않았다. 1페이지 신청서 서명부에도 기업명·대표자 라벨 후보가 있어 다른 section 선택은 실제 위험이었다. [실제 OpenAI Mapping 결과](mapping.json)는 `gpt-5.6-luna` 1회, **Correct 5/5, Wrong 0, Unmapped 0, Wrong Target Rate 0%, production validator PASS**다. 기대 target ID는 모델 응답 뒤에만 읽어 채점했다. 자동 재시도는 없었다.

## WritePlan → PDF MCP → Core PDFBox → Verify

추가 유료 호출 없이, 모델이 고른 5개 target과 사람이 정한 가상값으로 `set_field` WritePlan을 구성했다. `validate_plan`이 saved binding과 값 참조·scope·target kind·box=null을 검사했다. production `PdfDocumentAdapter.apply`는 5개 `PDF_INPUT`을 원본에서 측정된 box로 변환해 `PDFBOX_REQUIRED` stage와 placement 5개를 반환했다. [stage-summary.json](stage-summary.json)에 plan hash와 placement를 기록했다. PDF MCP 삭제 연산은 없으며 원본 출력 SHA는 입력과 같았다.

Core `ApplicationDocumentEditor.fill`에 이 5개 placement를 그대로 전달했다. 출력 PDF를 PDFBox와 독립 pypdf로 재열어 **11페이지, AcroForm 필드 5개, 위젯 5개, 값 5/5, 각 `/AP/N` 존재**를 확인했다. Core의 출력 PDF 재inspect도 11페이지와 `PDF_FIELD` 5개를 확인했다. Poppler로 원본·출력 11페이지 전부를 같은 100dpi로 렌더 비교한 결과, 변경 픽셀은 2·6페이지에서만 발견됐고 모두 해당 5개 box 안에 있었다. 화면 검사에서 라벨 겹침, 표 경계 침범, 값 잘림은 관찰되지 않았다. 원본 SHA는 전후 동일했다.

이 검증에서 **Mapping Agent는 실제 호출**, **WritePlan 연산 선택은 사람이 지정**했다. 따라서 OpenAI가 실제 답변에서 WritePlan을 선택하는 품질, 다른 공식 PDF에 대한 탐지 일반화, Reader에서의 직접 재편집 UI는 `NOT_RUN`이다. 선택한 칸에는 제거할 기존 예시가 없어 `pdf_replace_single` 삭제 경로는 실행하지 않았다.
