# 공식 신청 양식 5종 검증

2026-10-06, `skn-261-official-20261006-v1`. 기준 main은
`a0c3e2b9289126f87b004df793bdab29eb12e8e7`이다. 평가 당시 작업 트리의 코드를 사용했다.

커밋·푸시 준비 때 로컬 main에 원본 최신 main
`ab7230b41d8922bd77ecadc308fc6292e24f04b8`을 `pull --rebase`로 반영하고 작업 브랜치에 변경을
충돌 없이 복원했다. 추가 병합은 Argo 설정 검사와 Bizno 경계 정리이며 신청 문서·AI 프롬프트·잠금 파일은
변경되지 않았다. 기존 5회 유료 평가를 다시 호출하지 않았다.

공개 빈 양식 5건에서 현재 생산 매핑 Agent를 실제 OpenAI로 각 1회 실행했다.
41개 문항 모두 저장된 기준 위치와 일치했고 생산 `validate_mapping`도 통과했다.
이 결과는 선정한 5개 파일의 자동 대조 결과다. 별도의 사람 검수·기관 확인이나 다른 양식으로의
일반화, 질문 추출 정확도, 실사용자 답변 품질을 확인한 결과는 아니다.

## 표본과 결과

| 형식 | 공식 표본 | 매핑 일치 | 가상 답변 기입 | 렌더 확인 |
|---|---|---:|---:|---|
| HWP | 의료기기 기업 해외진출 지원사업 신청서 | 8/8 | 3, Core hwplib 적용·재열기 | Hancom 미실행 |
| HWPX | 서초구 중소기업육성기금 융자신청서 | 10/10 | 6, 크기 검사·기입·재열기 | Hancom 미실행 |
| PDF | 부산 항공부품산업 기술고도화 사업계획서 | 5/5 | 5, PDF MCP·Core PDFBox | Poppler 11페이지 비교 |
| DOCX | KOTRA 해외공공조달 선도기업 참가신청서 | 10/10 | 5, OOXML·스타일·재열기 | LibreOffice 미설치로 미실행 |
| XLSX | 찾아가는 공공구매 상담회 희망 기업목록 | 8/8 | 5, 셀·수식·검증·스타일·재열기 | Artifact Tool A1:I6 미리보기 |

매핑은 [mapping-results.json](mapping-results.json), 기입과 보존은
[native-results.json](native-results.json), 실행 환경·한계는
[verification-summary.json](verification-summary.json)에 기록한다.

공식 원본은 내려받은 뒤 각각 아래 기준 SHA-256과 일치함을 확인했다. 원본 바이너리,
기입한 예제 문서, 페이지 이미지, API 키와 실사용자 답변은 Git에 포함하지 않았다.

- [HWP 기준·공식 URL](../../expected/medical-export-hwp-2026-v1.json)
- [HWPX 기준·공식 URL](../../expected/seocho-2026-v1.json)
- [PDF 기준·공식 URL](../../expected/busan-flat-pdf-2026-v1.json)
- [DOCX 기준·공식 URL](../../expected/docx-kotra-procurement-2026-v1.json)
- [XLSX 기준·공식 URL](../../expected/xlsx-purchase-v1.json)

## 유료 평가와 경계

사용자가 공개 양식 텍스트·입력 영역 정보·PDF 11페이지 이미지 전송과
`gpt-5.6-luna` 최대 5회 호출을 승인했다. 오류도 횟수에 포함하도록 시도 전 기록하며
SDK `max_retries=0`, 호출당 출력 최대 32,000토큰을 사용했다. 실제 시도는 5회,
SDK가 보고한 입력은 491,535토큰, 출력은 5,623토큰, 합계는 497,158토큰이다.
요금 청구 금액은 확인하지 않았다.

기준 주소는 모델 응답 후 채점에만 읽었다. 모델에 평가용 정답·보조 힌트를 추가하지 않았다.
현재 `ApplicationPreparationAgent`의 프롬프트와 구조화 출력 경로를 사용했고, `store=False`로 요청했다.
로컬 SDK의 주요 패키지 버전도 `backend/ai-service/uv.lock`과 대조했다.

기입 검증은 실제 매핑 응답의 위치를 재사용했다. HWP·HWPX·DOCX·XLSX는 현재 저장 답변 기반
계획 경로를 사용했고 추가 모델 호출이 없었다. HWP의 생성 단계는 편집 계획을 Core로 넘긴 뒤
실제 `ApplicationDocumentEditor.applyHwpPlan`으로 마무리했다.
PDF는 검출한 입력 지도와 실제 매핑 응답에 검증용 고정 계획을 적용하고 Core PDFBox로 마무리했다.
PDF의 LLM 작성 계획·예시 삭제 판단은 평가하지 않았다. 실제 Core↔AI HTTP 호출은 이 평가에서 실행하지 않았다.

HWP는 전체 입력 대상의 ID·텍스트 보존, PDF는 페이지 수·필드 값·단일 위젯·appearance를
확인했다. 원본 SHA-256은 모든 기입 전후 동일했다. HWPX는 기입 6개가 모두 검증됐고
미기입 답변은 없었으며, 작성 예시가 남은 칸 1개를 별도로 보고했다.

PDF의 기입 페이지 2·6은 칸 내부 표시를 전후 이미지로 확인했다. 나머지 9페이지는 Poppler
100 DPI PNG 해시가 원본과 같았다. XLSX는 원본과 기입 결과의 전체 사용 범위 A1:I6을
미리보기로 확인했다. 실제 Excel 실행 검증은 아니다. DOCX·XLSX의 실제 매핑으로 만든 결과는
앞서 검사한 기준 위치 결과와 파일 SHA-256도 같았다.

## 비동기 신청 문서 테스트 복구

기존 `ApplicationPreparationApiIntegrationTest` 전체의 작업 실행기 비활성 설정을 제거했다.
QUEUED 삭제 보호 테스트는 실행기를 끈 별도 `ApplicationPreparationDeletionApiIntegrationTest`로
옮겨, 다른 비동기 생성 테스트가 실제 실행기를 사용하도록 했다. 최초 매핑 실패 기록 테스트도
작업을 수동 실행하는 대신 실제 실행기가 처리한 UNKNOWN 결과를 기다린다.

JDK 21에서 API·작업 기록 관련 56개를 실행했다. 첫 실행에서 기존 55개는 통과했고 새 삭제
픽스처 1개가 실패했다. DB prompt 제약과 허용 Origin을 수정한 뒤 실패 항목만 재실행해 통과했다.
MySQL 8.4·Redis는 실제 Testcontainers이며 AI 클라이언트는 테스트 대역이다.
Windows AF_UNIX 문제는 검증 JVM에 존재하지 않는 `jdk.net.unixdomain.tmpdir`을 지정해
TCP fallback으로 처리했다. production 설정은 바꾸지 않았다.

최신 main 반영 후 전체 Core 테스트 소스를 다시 컴파일하고
`ApplicationDocumentGenerationJobServiceTest` 11개를 재실행해 모두 통과했다.
이 단계에서는 Docker 제어 API 오류 때문에 MySQL 통합 테스트를 반복하지 않았으며,
최신 커밋의 전체 통합 검증은 CI에서 확인한다. 앞의 56개 결과와 실행 기준을 구분해 기록했다.

## 재현과 미검증 범위

- 무료 기입: `run_official_format_regression.py --sources <원본 폴더> --output <새 결과 폴더>`.
  `--formats`로 실패 형식만 선택하고 `--mapping-run`으로 이미 승인된 응답을 재사용할 수 있다.
  모델 호출을 하지 않으며 각 결과 폴더를 덮어쓰지 않는다.
- 실제 매핑: `run_official_mapping_evaluation.py --sources <원본 폴더> --native-run <inspect 결과>
  --output <새 결과 폴더> --key-env <인증 설정> --model gpt-5.6-luna`.
  유료 요청이므로 별도 전송 데이터·호출 예산 승인이 필요하다. 이번 5회 응답은 재호출하지 않는다.
- Core 출력: `HwpTargetExport`, `OfficialPdfInspection`, `OfficialNativeCompletion`을 현재 Core
  런타임 classpath로 실행한다. PDF 검증용 계획은 기존 `stage_pdf_e2e.py`를 사용한다.
- HWPX는 저장소의 `hwpx.lock`, Kordoc은 고정 `f715573df1712d415604ac949603a00e387cd3d7`을
  검증 임시 환경에 설치했다. PDF 편집 환경은 `pdf.lock`으로 버전을 제한한 편집 의존성만 설치했고,
  FFDetr 지도는 앞서 Linux MCP에서 검사한 결과를 재사용했다.

기존 개발 이미지는 HWPX 크기 검사 의존성이 누락되어 검증에 사용할 수 없었다.
현재 Dockerfile로 새 이미지를 만드는 과정은 이미지 저장 단계에서 Docker Desktop API 500이
발생해 중단했다. 해당 컨테이너들은 시작하지 못했고 이 경로의 유료 호출은 0회였다.
로컬 고정 환경으로 전환했으며 기존 개발 서비스를 재시작하지 않았다. Docker 전체 이미지·기동 검증은 미완료다.
마지막 읽기 전용 점검에서도 Docker API 500이 남았고 개발 Core·Web HTTP는 3초 안에 응답하지 않았다.
개발 환경의 정상 상태는 확인하지 못했으며, 다른 프롬프트의 작업에 영향을 줄 수 있는 Docker Desktop
재시작은 사용자 승인을 요청한 상태다. 데이터·볼륨 삭제는 수행하지 않았다.

Hancom·Word 화면 검수, 실제 기기·브라우저 흐름, 운영 API와 배포는 미실행이다.
이번 작업의 최신 커밋 CI는 미실행이며 전체 검증 통과로 선언하지 않는다. CI의 Core `clean build`는
선택 테스트 외 전체 테스트를 담당한다. 앞선 다른 커밋의 중복 검토 테스트 실패는 별도 영역으로 남아 있고
이번 변경으로 수정하거나 재검증하지 않았다.
