# 공식 신청서 3포맷 실파일 검증

실행일: 2026-09-25. 실행 ID: `three-format-20260925-v1`. 원본 파일과 수정본은 저장소에 넣지 않았다. 가상값만 사용했다. 아래 수치는 이번 실행 결과이며 과거 서초구 모델 평가와 구분한다.

## 표본과 원본 식별

| ID | 공식 출처 | 크기 | SHA-256 | 구조 |
|---|---|---:|---|---|
| HWPX-B | [경기 디자인상용화 신청서](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000120050), 첨부 `FILE_000000000748788/1` | 166,147 B | `18c8bf9978731bbca37fe88df4d2548138a854ba0467161a6db54bf27baea420` | 여러 신청·계획 표, 체크 표시, 반복 항목, 2,564 targets |
| HWPX-C | [KISA 신속확인 지원 신청서·설문지](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000119910), 첨부 `FILE_000000000748295/0` | 54,300 B | `a246a99543cd91f4161bede03a01a840c957308a091b52d83ccde881da7e1747` | 단순 신청 표와 별도 설문·반복 표, 202 targets |
| HWPX-D | [한국장애인고용공단 직무개발 참여 신청서](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000123363), 첨부 `FILE_000000000760589/0` | 49,032 B | `c12d7e9f25515eda5b4d4f0c756c5c58e771e25d189053129d7da20ee3c30a87` | 병합 셀, 기업 규모·직무개발 선택 항목, 199 targets |
| HWP | [경기 의료기기 기업 해외진출 신청서](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000119214), 첨부 `FILE_000000000745786/2` | 75,264 B | `8a90cf4d5d8bcb54d48203847d9f54c47efad7935e31ced4a8bd08e090f2a465` | 신청 표, 계획 표, 인쇄된 체크 표시, 388 Core targets |
| PDF | [부산 항공부품산업 지원 신청서](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000122391), 첨부 `FILE_000000000756959/1` | 324,743 B | `4c90df4a5282dd62ae550bb1676766a550089dce7509192008feee988b24bde3` | 11페이지 flat PDF, 기존 AcroForm 필드·위젯 0개 |

이전 기준 HWPX-A는 [서초구 Ground Truth 평가](../mapping-groundtruth-20260923-v1/README.md)의 10/10 Correct, Wrong 0이다. 같은 파일을 신규 일반화 표본으로 세지 않았다.

## HWPX-B/C/D Ground Truth와 후보

세 [Ground Truth 파일](../../expected)은 사람이 공식 표의 인쇄 라벨, 인접 빈 셀, 실제 native paragraph 주소를 대조해 각각 10개 항목을 고정했다. `expectedTargetId`와 쓰기용 값은 모델 입력에 포함하지 않는다. [디자인 결과](design-local.json), [KISA 결과](kisa-local.json), [직무개발 결과](kead-local.json)는 production `HwpxDocumentAdapter.inspect`와 `mapping_label_matches`를 사용한 로컬 후보 평가 및 복사본 native write 검증이다.

| 문서 | Ground Truth | 정답 후보 포함 | 유일 정답 후보 | Ambiguous | Wrong | Unmapped | 가상값 write/verify |
|---|---:|---:|---:|---:|---:|---:|---:|
| HWPX-B | 10 | 10 | 3 | 7 | 0 | 0 | 3/3 |
| HWPX-C | 10 | 10 | 8 | 2 | 0 | 0 | 3/3 |
| HWPX-D | 10 | 10 | 5 | 5 | 0 | 0 | 3/3 |

표의 `Wrong 0`은 로컬 후보 결과에서 정답을 빠뜨린 채 다른 후보만 제시한 항목이 0이라는 뜻이다. 후보 목록에는 여전히 다른 위치가 섞여 있다. HWPX-B의 반복 표가 대표자·주생산품 등의 후보를 늘린다. HWPX-C의 제품명·모델명, HWPX-D의 대표자·주소 등도 후보가 여러 개다. 공식 원본의 읽기 가능한 텍스트·표 문맥은 충분했고, 새 parser가 필요한 구조 누락은 관찰하지 못했다.

KISA 표의 `사업자등록번호`, `담당자성명` 등 인쇄 라벨이 여러 문단으로 나뉘면 자식 문단이 다른 질문의 후보에 남는 문제를 재현했다. 부모 셀의 전체 텍스트가 질문 라벨과 일치할 때 자식 문단을 보호하도록 수정했다. KISA의 유일 정답 후보는 수정 전 5/10에서 8/10으로 늘었고 정답 후보 포함 10/10을 유지했다. `mapVersion`은 `native-map-v11-hwpx-split-label-exclusion`로 갱신했다.

세 문서의 HWPX 쓰기는 각 3개 가상값을 복사본의 빈 native leaf에 기록했다. 문서별 `requested=resolved=applied=verified=3`, `unresolved=0`, XML 파싱 통과, 변경 대상 외 텍스트·target ID·물리 주소 변화 0, 원본 SHA 보존을 확인했다. Hangeul 화면 렌더링은 `NOT_RUN`이다.

### 실제 OpenAI Mapping

로컬 `.env`의 키를 평가 프로세스에서만 읽고 값은 출력·저장하지 않았다. `gpt-5.6-luna`, production `ApplicationPreparationAgent.map_document` 입력, 문서당 1회, API 자동 재시도 0으로 실행했다. 별도 blind JSON에는 field ID·label·scope만 있고 정답 target ID는 없다. [KISA 모델 결과](kisa/mapping.json)와 [직무개발 모델 결과](kead/mapping.json)의 정답 파일은 모델 응답 이후에만 읽었다. 두 실행 모두 `validate_mapping` PASS다.

| 문서 | 모델 호출 | Correct | Wrong | Unmapped | Ambiguous | Wrong Target Rate |
|---|---:|---:|---:|---:|---:|---:|
| 기존 서초구 HWPX-A | 과거 1회 | 10/10 | 0 | 0 | 0 | 0% |
| KISA HWPX-C | 이번 1회 | 10/10 | 0 | 0 | 0 | 0% |
| 직무개발 HWPX-D | 이번 1회 | 10/10 | 0 | 0 | 0 | 0% |
| 디자인 HWPX-B | 0회 | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` |

HWPX-B는 Hangeul MCP의 개별 `inspect`와 로컬 후보·write는 통과했지만 production `inspect_document`의 텍스트·문맥 합계 400,000자 제한에서 `LIMIT_EXCEEDED`가 발생했다. 모델 호출 전에 실패하므로 잘못된 입력은 발생하지 않았지만, 이 공식 양식은 현재 production Mapping을 사용할 수 없다. 제한을 임의로 높이지 않았다. 이 크기 문제는 새 parser 부족으로 확인된 것이 아니라 현재 전달 문맥량·제품 한도 문제다.

두 신규 모델 실행의 20/20 Correct는 서로 다른 신청서에서 개선이 유지된 1차 근거다. 문서당 한 번만 호출했고 대형 디자인 양식은 제외되므로 모든 HWPX의 반복 안정성이나 전체 포맷 지원을 입증하지 않는다.

## HWP 실제 Core hwplib

[HwpSmoke.java](../../HwpSmoke.java)는 공식 HWP 첫 신청 표에서 라벨과 인접 빈 target 8쌍을 고정한다. Core `ApplicationDocumentEditor.inspect → applyHwpPlan → reopen/inspect`를 실행했다. 원본 388 targets, 8개 요청·적용·재열기 값 확인, 예상 밖 target 텍스트 변경 0이었다. Core 편집기 내부의 문단·체크값·셀 구조·임베디드 데이터 보존 검사도 통과했다. 원본 SHA는 실행 전후 동일했다.

[HwpTargetExport.java](../../HwpTargetExport.java)로 Core의 실제 hwplib target 계약을 임시 JSON으로 내보내고, blind 질문 8개로 production 문맥 OpenAI Mapping을 1회 실행했다. [모델 결과](hwp/mapping.json)는 8/8 Correct, Wrong 0, Unmapped 0, validator PASS다. 모델이 선택한 8개 주소는 위 HWP native write의 사람이 확인한 주소와 모두 일치한다. Ground Truth ID는 응답 후 채점에만 사용했다.

입력값을 넣는 WritePlan은 사람이 만들었다. 따라서 OpenAI WritePlan 생성, 인쇄된 체크 표시의 native 체크 컨트롤 동작, Hangeul 시각 렌더링은 `NOT_RUN`이다.

## PDF 실제 flat 문서

Core PDFBox `inspect`는 11페이지 이미지와 원문 위치를 읽었다. 독립 pypdf 확인에서 기존 `/AcroForm/Fields`와 `/Widget`은 모두 0개였다. 1페이지를 Poppler로 렌더하고 기업명 빈 칸과 인쇄 라벨·표 경계를 확인했다. [PdfCoreSmoke.java](../../PdfCoreSmoke.java)의 사람이 측정한 한 칸에 `TEST-COMPANY`를 Core `fill`로 작성했다. 재열기 결과 11페이지, `/AcroForm/Fields` 1개, `/Widget` 1개, `/V=TEST-COMPANY`, `/AP/N` 존재를 확인했다. 원본 SHA는 유지됐고 같은 크기의 원본·출력 렌더 이미지에서 달라진 픽셀의 bounding box는 첫 페이지 `(271,181)-(374,193)`으로 기업명 칸 내부였다. 이 한 칸의 글자 겹침·잘림은 관찰되지 않았다.

이 문서는 flat PDF이므로 `PDF_FIELD` 경로가 없다. 현재 로컬 환경에는 PDF MCP/FFDetr 가중치와 실행 중인 Docker 엔진이 없어 `PDF_INPUT` 탐지, `printedTextRegions`와 탐지 박스의 자동 교차 확인, OpenAI Mapping, MCP 삭제 후 PDFBox 연결은 `NOT_RUN`이다. 기존 인쇄 예시 제거도 실행하지 않았다. Core 수동 배치 성공을 production 자동 PDF E2E 성공으로 보지 않는다. Reader에서 직접 수정·저장하는 UI 검증도 `NOT_RUN`이다.

## 3포맷 판단

| Format | Sample Count | Mapping | Write | Verify | Wrong Target | Result |
|---|---:|---|---|---|---|---|
| HWP | 1 | OpenAI 8/8, 사람 지정 주소와 일치 | Core 8/8 | 재열기·보존 8/8 | 모델 Wrong 0/8 | `PARTIAL` |
| HWPX | 신규 3 + 기존 서초구 1 | 신규 후보 30/30 포함, 신규 모델 20/20, 디자인 `LIMIT_EXCEEDED`; 서초구 과거 10/10 | 신규 9/9 | MCP·XML·원본 보존 9/9 | 신규 모델 Wrong 0/20 | `PARTIAL` |
| PDF | 1 | flat 수동 1칸, FFDetr/OpenAI `NOT_RUN` | Core PDFBox 1/1 | 재열기·렌더 1/1 | 자동 매핑 미측정 | `NOT_FULLY_TESTED` |

두 신규 HWPX의 모델 Mapping은 Wrong 0으로 개선이 일반화되는 1차 근거를 제공한다. 다만 디자인 양식은 production 한도에 걸리고 문서별 모델 반복성은 평가하지 않았으므로 HWPX 전체를 `STABLE`로 선언하지 않는다. PDF 자동 감지·배치 경로는 가장 큰 검증 공백이다.

## mapVersion, 저장 지도와 배포 위험

`MAP_VERSION`은 `PIPELINE_VERSION` hash 입력이다. Core `ApplicationDocumentMappingService.ensure`는 pipelineVersion·sourceSha256이 모두 일치할 때만 저장 지도를 재사용하고, 불일치하면 새 Mapping을 호출해 같은 form version의 `documentMapSnapshot`을 `JSON_SET`으로 갱신한다. 같은 pipeline의 이미 검증된 지도는 SQL 조건으로 덮어쓰지 않는다. 생성 파일의 fingerprint에도 pipelineVersion이 포함되어 과거 결과가 새 결과 캐시로 반환되지 않는다. 기존 답변과 과거 생성 파일 자체를 지우는 경로는 이 변경에 없다.

따라서 배포 후 **기존 양식의 첫 재생성에서 유료 재매핑과 지연이 발생할 수 있다**. 새 매핑이 실패하면 생성은 오류로 끝나고 이전 바인딩으로 조용히 작성하지 않는다. 예전 binding이 남은 요청과 새 `mapVersion`의 WritePlan이 섞이면 Core의 plan/mapVersion 검사 및 AI `SAVED_BINDING_CHANGED` 검사에서 거절된다. 새 지도 저장의 실제 MySQL·동시 요청·사용자 상태 보존은 이번 로컬에서 확인하지 못했고, 배포 전 CI/격리 DB에서 확인해야 한다. DB migration은 없다.

## 실행 범위

- 로컬: Hangeul MCP 세 공식 HWPX `inspect`·후보·native write/verify, 두 HWPX와 HWP 각 1회 실제 OpenAI Mapping, Core hwplib HWP 8칸, Core PDFBox PDF 1칸, Poppler 렌더 및 pypdf 필드 검사.
- 미실행: 디자인 HWPX의 production Mapping(사전 검사 실패), HWP OpenAI WritePlan 생성, PDF OpenAI 위치 선정, FFDetr, PDF MCP 삭제 경로, Hangeul/Reader UI, 실제 MySQL 및 원격 CI·배포.

재현 명령은 AI 서비스의 잠금 환경에서 `uv run --locked --extra dev python ../../evaluation/application-document/validate_mapping.py --source <원본> --expected <Ground Truth>`이다. 모델 평가는 `run_generalization_mapping.py --source <원본> --blind <blind JSON> --expected <Ground Truth> --output <새 디렉터리>`로 문서당 한 번만 실행한다. HWP는 추가로 `--targets <Core export JSON>`을 준다. 기존 결과 디렉터리를 재사용하면 호출을 거절한다. HWP/PDF 스모크는 JDK 21과 Core `sourceSets.main.runtimeClasspath`로 각 Java 파일을 `javac` 컴파일한 뒤 `java HwpSmoke <원본> <새 결과 경로>` 및 `java PdfCoreSmoke <원본> <새 결과 경로>`로 실행했다. PDF는 Poppler `pdftoppm -f 1 -l 1 -singlefile -r 120 -png`와 pypdf로 독립 검사했다.

AI 관련 `uv run --locked --extra dev python -m pytest tests/test_document_mcp_contract.py tests/application_preparation`의 첫 실행은 기존 210개 통과, 새 fixture의 필수 `nativeLocator` 누락으로 1개 실패했다. fixture 수정 후 해당 실패 테스트를 재실행해 1개 통과했다. Core `./gradlew test --tests '*ApplicationDocumentMappingServiceTest' --tests '*ApplicationHwpPlanTest' --no-daemon --max-workers=2 '-Pkotlin.incremental=false'` 첫 실행은 HWP 관련 5개 통과, 새 Mockito fixture 1개 실패와 그 여파 1개 실패였다. fixture 수정 후 `ApplicationDocumentMappingServiceTest` 3개가 통과했다. 따라서 수정 후 관련 테스트는 AI 210개 기존 통과 + 새 테스트 재실행 통과, Core HWP 5개 + 지도 서비스 3개 통과로 구분한다. 실제 MySQL·원격 CI 전체 검증은 수행하지 않았다. 최종 `git diff --check` 통과.
