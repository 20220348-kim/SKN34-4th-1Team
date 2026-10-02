# 공고별 RAG 검수와 고정 근거 답변 평가

[문서 목록](../../docs/README.md) · [구현 현황](../../docs/implementation-status.md)

현재 실행기는 production의 LangChain Agent를 사용합니다. 고정 HTTP 응답으로 실행 경로와 계약을
검증하며, 이 전환으로 새 유료 평가나 의미 품질 측정을 수행한 것은 아닙니다. `runs/`의 과거 코드·
캡처·보고서는 당시 구현과 설정에 대한 기록으로 유지합니다.

## 전체 RAG 오프라인 계약·평가기 — 2026-09-30 후속

[rag_evaluate.py](rag_evaluate.py)는 **고정 원문·청크 → 저장 검색 결과 → 저장 답변**을 대조하는
무료 CLI입니다. production의 AI 요청·응답 모델을 재사용하고 검색 재현율과 답변 인용 재현율을
독립적으로 계산합니다. 서버 실행·원문 수집·색인·임베딩·답변 생성·Langfuse 조회는 수행하지 않습니다.
Ops의 `fixed-answer-context-only` 접수·명세·품질 정책은 유지합니다. 아래 합성 3사례를
`rag-synthetic-multichunk-v1`로 등록해 무료 재평가·보고서·점수 등록·결과 조회까지 연결했습니다.
[Ops RAG 재평가 계약](../../backend/ops-service/README.md#전체-rag-저장-캡처-재평가)을 따르며
RAG live·사람 검토·품질 합격·비교 기준 지정은 제공하지 않습니다.

```bash
# 저장소 루트: 자료 검증만 수행. 모든 품질 지표는 null
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/rag_evaluate.py \
  --fixture evaluation/support-program-evidence/rag-fixture.json

# API 키·DB·서버 없이 합성 기록의 점수 계산을 검증. 보고서는 표준 출력으로만 반환
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/rag_evaluate.py \
  --fixture evaluation/support-program-evidence/rag-fixture.json \
  --capture evaluation/support-program-evidence/rag-synthetic-capture.json
```

[rag-fixture.json](rag-fixture.json)은 **AI 작성 가상 공고 2개·수동 분할 청크 8개·질문 3개**입니다.
첫 공고는 청크 6개 중 5개를 검색하도록 고정해 근거 누락을 표현합니다. 이 분할은 production
청커를 실행한 산출물이 아닙니다. [합성 캡처](rag-synthetic-capture.json)는 일부러 검색·인용을
누락한 테스트 기록으로, 실제 OpenAI·Qdrant·Langfuse 실행 기록이 아닙니다.

| 사례 | 의도적으로 고정한 상황 | 검색 재현율 | 답변 인용 재현율 |
|---|---|---|---|
| R01 | 기대 근거 2개를 모두 검색하고 1개만 인용 | 1.0 | 0.5 |
| R02 | 기대 제출 서류 청크를 검색에서 누락하고 관련 없는 청크를 인용 | 0.0 | 0.0 |
| R03 | 원문에 지원 금액이 없어 근거 부족 응답 | null | null |

상태 일치율은 이 합성 예제에서 1.0이어도 답변 내용이 맞다는 뜻이 아닙니다. 답변 사실성은 항상
`semanticFaithfulness=null`, `semanticReviewRequired=true`이며 `baselineEligible=false`입니다.

### 버전과 실행 기록 계약

- fixture schema는 `support-program-rag-fixture-v1`, capture는 `support-program-rag-capture-v1`,
  report는 `support-program-rag-report-v1`이며 범위는 모두 `source-chunks-retrieval-answer`입니다.
- fixture는 `datasetVersion`, 가상 자료·미검토 참조 표시, 원문·URL·`contentHash`, `chunkVersion`,
  청크 원문·해시·순서와 질문별 `expectedEvidence`의 청크 ID·원문 구절을 고정합니다.
  v1은 AI 작성 가상 자료만 허용하며 사람 검토나 실자료 승인을 만들어내지 않습니다.
- 청크 ID는 Core의 `SHA256(documentId + NUL + sourceContentHash + NUL + order)` 규칙을 검증합니다.
  공백을 제외한 원문 문자와 청크 문자 순서의 보존도 확인합니다. 청킹 알고리즘 실행 증명은 아닙니다.
- capture는 **fixture 파일 바이트의 SHA-256**을 참조합니다. 사례마다 원문 해시, 청크 목록 해시,
  색인 완료 개수, 실제 검색·답변 요청/응답 위치를 둡니다. 모든 질문에 성공 또는 실패 기록이 필요합니다.
  누락·중복 사례, 다른 공고·버전의 청크, 순서가 잘못된 검색, 검색되지 않은 청크 인용은 거절합니다.
- 검색은 현재 Core와 같은 `k=min(5, 청크 수)`를 사용하며 정확히 k개를 요구합니다. 점수 내림차순,
  동점이면 ID 오름차순이고, 답변에는 검색 순서의 원문 청크만 전달돼야 합니다.
- `execution.kind=synthetic`이면 모델·프롬프트·실행기 값과 모든 trace ID가 null이어야 합니다.
  `recorded`이면 기록 당시 모델·임베딩 모델·프롬프트 해시·실행기 해시를 요구합니다.
  trace ID는 제공된 32자리 소문자 16진 값을 그대로 보존하고 누락 시 null로 둡니다.
  `recorded` 표시와 ID 형식 확인만으로 실제 호출·Langfuse 등록을 증명하지 않습니다.
- 보고서는 fixture·capture·평가기·현재 AI 계약의 해시, 원문·청크 버전, 사례별 검색·답변 결과 해시를 남깁니다.
  구조화된 값의 해시는 UTF-8 JSON에 `sort_keys=True`, `ensure_ascii=False`,
  `separators=(",", ":")`, `allow_nan=False`를 적용합니다. 파일 해시와 구별합니다.

### 실패와 지표 해석

`failure`는 정상 시 null, 실패 시 `{ "stage": "search", "code": "timeout" }`처럼 기록합니다.
단계는 `not_started`, `source`, `chunk`, `index`, `search`, `answer`입니다. 아직 시작하지 않은
질문도 `not_started`로 명시하며 분모에서 삭제하지 않습니다. 실패한 단계의 성공 산출물과 이후
산출물은 null이어야 합니다. 검색·답변에서 실패했다면 해당 요청은 보존하고 응답은 null로 둡니다.
계약을 위반한 원시 응답을 성공으로 수용하지 않으며 실패 코드를 남깁니다.

| 보고서 필드 | 해석 |
|---|---|
| `captureValidated` | 캡처가 계약을 만족함. 정상 완료나 품질 합격과 별개 |
| `completed` | 모든 질문이 검증된 답변까지 도달함. 합성 기록도 true가 될 수 있음 |
| `measurementKind` | 자료 검증만 / 합성 계산 검증 / 저장 실행 재계산을 구분 |
| `retrievalRecallAtK` | 기대 근거 청크 중 검색된 비율. 기대 근거가 없거나 검색 실패면 null |
| `answerCitationRecall` | 기대 근거 청크 중 인용된 비율. 기대 근거가 없거나 답변 실패면 null |
| `answerStatusAccuracy` | 응답한 질문의 기대 답변 상태 일치 비율. 의미 정확도가 아님 |
| `measuredCaseCount` / `eligibleCaseCount` | 평균에 실제 포함된 수 / 해당 지표 대상인 전체 질문 수 |
| `coverage` | 검색·답변 측정 수, trace 보유 수, 실패 사례 수 |

실패는 0점으로 바꾸지 않습니다. 평균은 측정된 사례만 사용하므로 반드시 대상 수·실패 수와 함께
해석해야 합니다. 모든 사례가 실패하면 값은 null입니다. 인용 재현율은 불필요한 인용을 벌점주지 않습니다.
입력 변조·계약 불일치는 종료 코드 1로 실패하며 점수 보고서를 출력하지 않습니다.

로컬 Python 3.12에서 [무료 테스트](test_rag_evaluate.py) 69건, 합성 캡처 CLI,
Ruff 검사·포맷을 확인했습니다. `uv`가 PATH에 없어 기존 AI 가상환경으로 실행했습니다.
이 최초 계약의 `skn-74 / 4537e5f`는 필수 CI 5개가 성공했습니다. 전체 테스트는 기존
`.github/workflows/ci.yml`의 `Test evidence evaluation tools without model calls`에서 자동 발견합니다.
실제 Core 기록 수집의 후속 구현은 아래와 같습니다. 호출별 누적 예산·취소, Ops 접수·검토 연동은 남아 있습니다.
기존 공식 HTML 과거 캡처와 고정 근거 캡처를 이 형식으로 자동 승격하지 않습니다.

### 실제 Core 다중 청크 기록 수집 — 무료 CI 연결

[수집기](../../infrastructure/llmops/core_rag_capture.py)는 소유권을 검증한 임시 Compose의 Core HTTP를
호출하고, [시험용 AI 기록 래퍼](../../infrastructure/llmops/rag_capture_app.py)가 실제 색인·검색·답변의
요청/응답을 수집합니다. 가상 원문을 임시 DB에 고정하므로 공식 HTML 다운로드·추출은 이 검사의 범위가 아닙니다.
래퍼는 production 이미지에 포함하지 않으며 시험 Compose에서만 읽기 전용 파일로 연결합니다.

```text
임시 DB의 가상 원문 → 실제 Core 청커(6개) → AI 색인·Qdrant 검색(최대 5개)
→ HTTP 모델 대역 → Core 답변·인용 검증
→ 실제 요청/응답 캡처 + Core trace로 Langfuse 재조회 → 오프라인 평가 보고서
```

Core 단위 테스트와 통합 검사가 같은 [가상 원문](../../backend/core-service/src/test/resources/support-program-evidence/rag-synthetic-source.json)을
사용합니다. 기존 수동 분할 예제는 그대로 보존합니다. 첫 버전은 정상·동일 질문 캐시·검색 근거 누락·
답변 인용 누락·근거 부족·답변 오류·시간 초과·잘못된 인용·검색 오류 9건, 변경된 원문은 정상 1건입니다.
원문 변경 시 모든 청크 ID가 달라지고 이전 버전의 청크가 검색·인용에 섞이지 않는지 확인합니다.
대역의 고정 벡터가 검색 순위를 만들므로 이 점수는 실제 임베딩이나 모델의 품질을 뜻하지 않습니다.

- 실제 Core가 보낸 청크로 `fixture.json`을 구성하고, 고정 기대 구절을 유일한 청크에 연결합니다.
  모델의 응답으로 정답을 만들지 않습니다. 기대 구절 자체도 AI 작성·사람 미검토 자료입니다.
- `capture-v2`와 `report-v2`는 `integration-stub` / `integration-stub-replay`만 추가합니다.
  실제 런타임의 모델·프롬프트·기록기 해시와 `paidModelApiCalls=0`을 요구하며 v1은 유지합니다.
  `liveExecutionPerformed=false`는 **재계산기가 새 호출을 하지 않았다**는 뜻입니다.
  캡처의 문자열 표시만으로 실행을 증명하지 않으며, CI 수집기가 실제 Langfuse 부모·오류·캐시를 별도 확인합니다.
- `integration.json`과 버전별 `wire.json`, `fixture.json`, `capture.json`, `report.json`을 보존합니다.
  아직 실행하지 않은 사례는 `not_started`, 오류 단계의 지표는 null입니다. 수집 실패는 비정상 종료하며
  가능한 지점까지의 파일을 남깁니다. 정상·실패 모두 CI artifact 업로드 대상입니다.
- `baselineEligible=false`, `semanticFaithfulness=null`을 유지합니다. Ops 등록·검토·기준 승인은 생성하지 않습니다.

실행·격리 조건과 전체 서버 CI 확인 방법은 [LLMOps 실행 안내](../../infrastructure/llmops/README.md#실제-core-다중-청크-캡처와-오프라인-평가)를 따릅니다.
로컬에서는 실제 Core 청커 단위 테스트, 실제 AI/SDK·로컬 HTTP 대역·메모리 Qdrant와 수집기 테스트를 검증했습니다.
`skn-75 / b1d9f03`의 CI artifact에서 JVM·MySQL·Qdrant 서버·Langfuse를 거치는 두 원문 버전·10사례의
통과를 확인했습니다. 검색 측정 9건·답변 측정 6건·실패 4건·trace 10건이며 실패 사례를 분모에서 삭제하지 않습니다.
해당 SHA의 전체 CI는 설정 검사 의존성과 이후 취소 접수 503 문제로 실패했습니다. RAG 단계 통과와
전체 workflow 성공을 구별하며, 후속 수정의 결과는 새 SHA에서 다시 확인해야 합니다.

### Core 캡처에서 혼합 예산 명세 준비

전체 Core 수집 검증이 성공하면 각 버전에 `budget-plan.json`을 추가합니다.
[준비 도구](../../infrastructure/llmops/core_rag_budget.py)는 실제 수집된 원문·청크·질문을
`make_rag_spec`에 전달하며 별도로 청킹하지 않습니다. 사례 순서와 실패 사례도 그대로 유지합니다.
현재 수집기의 v1은 9사례·최대 27작업, v2는 1사례·최대 3작업입니다. 캐시로 생략될 호출도
예약 전 상한에 포함하므로 이 수치를 실제 호출 수나 비용으로 해석하지 않습니다.

```text
Core 수집 완료 → fixture/capture/wire/integration 대조
→ 현재 Core 청커 해시·원문·질문·순서 검증 → 혼합 예산 명세 + 원본 파일 해시
→ budget-plan.json → 소비 시 원본·준비 코드·AI 실행 코드 재검증
```

- 원시 HTTP 기록에서 관측값을 재구성해 캡처와 비교합니다. 인용 URL, trace 연결, 사례 누락·순서도 검사합니다.
- `sourceSha256`은 원본 4개 파일의 바이트를, `preparationSha256`은 준비·수집·평가 코드와 Core 청커를 고정합니다.
  `executionSpec`은 현재 AI 모델·런타임 코드·질문·청크·작업 상한을 고정하고 `executionSpecSha256`으로 식별합니다.
- 부분·실패 수집, 바뀐 Core 청커, 변경된 원문·질문·wire는 거절합니다. 기존 준비 파일은 덮어쓰지 않습니다.
- 사용 시 파일과 현재 코드를 다시 대조합니다. 해시만 다시 쓴 명세 변조, JSON 중복 키와 타입 변경도 거절합니다.
- 이 도구는 완료된 **무료 통합 캡처의 다음 실행 입력을 준비**합니다. 이전 호출의 사후 승인·정산이나
  새 Ops 예약을 만들지 않습니다. `reservationCreated=false`, `paidModelApiCalls=0`, `baselineEligible=false`입니다.
  원본 캡처의 모델 정보와 앞으로 실행할 현행 모델 명세는 별개이며, 사람 검토나 실제 모델 품질로 승격하지 않습니다.
  파일 해시는 일관성 검사이며 임의 파일을 실제 Core 실행으로 인증하는 서명은 아닙니다.

```bash
# 저장소 루트, 모델·Ops·DB 호출 없이 이미 생성된 준비 파일 확인
backend/ai-service/.venv/bin/python infrastructure/llmops/core_rag_budget.py check work/core-rag-new/v1
# 과거 완료 캡처에 준비 파일이 없을 때만 생성; 현행 Core 청커와 계약이 일치해야 합니다.
backend/ai-service/.venv/bin/python infrastructure/llmops/core_rag_budget.py prepare work/core-rag-old/v1
```

토큰 상한 계산에는 기존 tiktoken 인코딩 데이터를 사용합니다. 완전한 오프라인 실행은 캐시가 준비되어
있어야 하며, 빈 환경에서는 최초에 공개 인코딩 파일을 내려받을 수 있습니다. 자료를 모델에 전송하지는 않습니다.

무료 검사 worker의 `core-spec`은 stdin의 `{"directory":"/absolute/capture/v1"}`에서 준비 파일을 읽어
검증된 `executionSpec`을 반환합니다. `run`에 `core_capture_directory`를 지정하면 Ops 연결 전에
원본과 준비 파일을 재검증하고 예약 명세·해시를 대조합니다. 이 worker는 항상 모델 전송 대역만 사용합니다.

로컬에서는 준비·변조 거절 17건과 기존 Core 캡처 12건, 총 29건을 확인했습니다. 로컬 Core HTTP·wire는
테스트 대역이며 실제 AI/SDK·메모리 Qdrant를 사용한 검증과 구분합니다. 현재 변경의 실제 JVM/Core·MySQL·
Qdrant·Langfuse 수집은 필수 LLMOps CI에 연결했고 아직 새 SHA의 결과는 없습니다. Core 준비 파일을 실제
Ops 예약·Prefect 실행·캡처 등록까지 한 번에 연결하는 작업은 후속입니다.

## Ops 평가 범위 고정 — 2026-09-30

고정 근거 평가기의 fixture·capture v1은 `scope`를 지정할 경우 `fixed-answer-context-only`만
허용합니다. 과거 파일의 누락은 v1 계약으로 읽되 원본을 바꾸지 않습니다. 전체 RAG 범위나 null을
선언한 자료를 고정 근거 평가로 바꿔 처리하지 않습니다. 새 모델 캡처에는 범위를 명시합니다.

보고서 생성과 점수 등록은 검증된 summary의 범위를 확인하며, 후보·기준 범위가 다르면 보고서나
점수를 만들지 않습니다. 새 비교 보고서와 점수 metadata는 `retrieval_evaluated=false`입니다.
검색 지표를 0으로 만들지 않으며 기존 상태 일치율·인용 재현율과 의미 충실도 미측정을 유지합니다.
Ops 명세 v2·manifest·보고서의 범위 연결은 [API 계약](../../backend/ops-service/README.md#평가-범위-계약)을 따릅니다.

관련 평가기·실행기·복구 테스트 146건, Ops의 DB 없는 검사 8건, Web 운영 화면 53건과 TypeScript·
Ruff·oxlint 검증을 확인했습니다. `uv`가 로컬 PATH에 없어 기존 Python 3.12 가상환경으로 실행했습니다.
로컬 Ops의 mysqlclient가 없어 DB 없는 SimpleTestCase만 dummy backend로 실행했고 DB를 생성하거나
접속하지 않았습니다. 실제 MySQL 8.4의 품질 승인·기준·복구 회귀와 전체 잠금 환경 검증은 새 SHA의
CI에서 확인해야 합니다. 이번 변경은 유료 호출이나 실제 RAG 품질 측정을 추가하지 않습니다.

## 현재 검증 범위

기존 기업마당 HTML RAG를 검수하고, 고정 근거 답변 평가와 실제 공개 공고의 전체 경로 검증을 분리합니다.
[이전 부분 평가](runs/README.md)와 [2026-09-07 후속 검증](runs/official-flow-20260907-v1/README.md)에
실행 원본·실패·AI 의미 검토·표본 한계를 보존합니다. 첨부파일·PDF/OCR은 이번 범위가 아닙니다.
최신 [대상 조건 요약 보완 검증](runs/official-flow-20260907-v2/README.md)에서는 추가 20회로 가상 6건·공식 6건을
확인했고, 공식 H01의 누락 보완과 기존 사례의 비회귀를 단회 AI-only 평가에서 관찰했습니다.

E12 추가 실행에서 모델이 64자리 인용 ID를 63자리로 복사한 오류를 확인했습니다. 이제 모델은 전달받은
청크의 짧은 배열 번호만 선택하고, Agent가 원래 ID를 복원합니다. 공개 API의 `citationChunkIds` 계약은
변경하지 않았으며 잘못된 번호·중복·근거 부족 상태의 인용은 계속 거부합니다.

| 구분 | 확인한 내용 | 아직 확인하지 않은 내용 |
|---|---|---|
| 기존 코드 검수 | 공식 URL·공고 식별자·리다이렉트·HTML 추출, 캐시·본문 해시, 현재 청크만 검색/인용, UI 오류·취소 처리 | 모든 실제 기업마당 HTML 변형에서의 수집 성공 |
| Core 회귀 테스트 | 원문 갱신 실패 시 후속 호출 차단, 잘못된 검색·인용 응답 거부, 검색된 최대 5개만 답변에 전달 | 모델 답변의 의미 정확성 |
| AI 기존 테스트 | 출력 계약, Agent 요청 설정·시간 제한, 근거 청크 검색/색인 | 다양한 실데이터에서의 모델 품질 |
| 고정 근거 답변 평가 | 질문·근거·기대 상태/인용 고정, 기록 재계산, 호출 안전장치, 계약 실패 진단 | 전체 원문 수집·DB·벡터 검색 경로 |
| 공식 HTML 전체 경로 | 고정한 공식 HTML → Core 공개 HTTP → 실제 MySQL·Qdrant → 실제 임베딩·답변 → 인용, API 없는 기록 검증 | 모든 공고의 HTML 변형·다수 청크 검색 품질·운영 부하 |

이전 E01 실패는 당시 생성 텍스트가 저장되지 않아 원인을 확정할 수 없습니다. 이번 E12의 확인 가능한
오류와 구별합니다. Core 전체 344개는 기존 통합 검증에서, AI 전체 207개는 최신 프롬프트 수정 후 통과했습니다.
최신 평가 도구·기록 검증 테스트는 118개 통과했습니다.
테스트 통과를 무결함이나 운영 품질 보장으로 해석하지 않습니다.

관련 테스트: [Facade](../../backend/core-service/src/test/kotlin/ai/govbiz/core/supportprogram/facade/AiSupportProgramEvidenceFacadeTest.kt),
[Service](../../backend/core-service/src/test/kotlin/ai/govbiz/core/supportprogram/service/evidence/SupportProgramEvidenceServiceTest.kt),
[AI 근거 기능](../../backend/ai-service/tests/support_program_evidence), [평가 도구](test_evaluate.py).

## 대상 조건 요약 보완 — 실제 모델 검증 완료

이전 공식 H01에서 빠진 ‘중소·중견 제조기업’ 범위는 저장 원문·색인 청크·AI 답변 요청에 모두 있었습니다.
실제 OpenAI 출력에서 처음 빠졌으므로 검색·청킹을 바꾸지 않고 답변 프롬프트만 보완했습니다.

- 질문과 관련된 명시적 대상 범위·필수 자격·제외·예외를 간결함 때문에 생략하지 않도록 지시
- 필수·우대·선택 조건과 원문 AND/OR 관계 유지, 없는 제한이나 불분명한 신청 가능성은 확정 금지
- 조건이 여러 청크에 나뉘면 각각을 뒷받침하는 청크를 함께 인용
- 모델·호출 수·HTTP 계약·인용 ID 복원·오류 처리·production 의존성은 변경하지 않음

[target-coverage-fixture.json](target-coverage-fixture.json)은 **추가 가상 공고 3건·고정 청크 9개·질문 6개**입니다.
기존 `fixture.json`, 공식 자료와 H01의 부분 일치 기록은 바꾸지 않았습니다. 새 참조는 AI 작성 자료이며
이미 관측한 실패를 바탕으로 만든 회귀용 자료입니다. 숨겨 둔 평가 자료나 사람 검토 정답이 아닙니다.
청크 번호와 원문 구절을 붙인 참조는 출처 확인을 위한 것이며 답변의 단어 포함 여부로 의미 정답을 채점하지 않습니다.

```bash
# API 키·서버 없이 새 입력 검증. 지표는 null이며 품질 평가가 아님
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/evaluate.py \
  --fixture evaluation/support-program-evidence/target-coverage-fixture.json

# 명시적으로 유료 평가를 선택한 경우에만 실행: 답변 최대 6회, 임베딩 없음
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/evaluate.py \
  --fixture evaluation/support-program-evidence/target-coverage-fixture.json \
  --execute --output-dir work/evidence-target-coverage-v1
```

**승인된 추가 20회로 실제 검증을 완료했습니다.** 가상 6건·공식 6건 모두 기대 상태가 일치했고, 원문 대조
AI 의미 검토도 일치로 판단했습니다. H01은 기존에 빠진 ‘중소·중견 제조기업’ 범위를 보존했습니다.
공식 전후 비교는 질문·원문·Core→AI 요청을 동일하게 유지했으며, 기존 나머지 5건의 새 오류는 발견하지 못했습니다.
단위 테스트와 실제 모델 의미 검토는 별개이며, 단회 결과를 일반 정확도나 통계적 개선으로 주장하지 않습니다.
프롬프트가 달라진 결과를 과거 실행과 섞어 단일 정확도로 계산하지 않습니다.

프롬프트 수정 후 AI Service 전체 207개, 새 공유 결과 추가 후 평가 도구 전체 118개와 `git diff --check`가
통과했습니다. 공식 라이브 통합 테스트도 공개 HTTP 질문 6건을 완료했습니다.
Core·DB·Frontend 코드는 변경하지 않아 이번에는 해당 전체 회귀 테스트를 재실행하지 않았습니다.

- 변경 전 프롬프트: 커밋 `88aa61f`, SHA-256 `588a36e7afe2b3e8b8d5467b24397edbb40ed045f6a7b77bdeec8c55ada0cde1`
- 변경 후 프롬프트 SHA-256: `560ad134d3ce657561e6dfa67793078c7526c5b5f1ebb691e6e972b27924655c`
- 추가 fixture SHA-256: `7cc1224e143f772e80713f267ed9b3b6d0262cabe75383b64f3e6b77ad496f8b`

새 질문의 답변 6회와 공식 전체 경로 14회(답변 6 + 임베딩 8), 합계 20회를 사용했고 재시도는 없었습니다.
사용량·의미 판정·전후 차이와 API 없는 재계산 명령은 [검증 보고서](runs/official-flow-20260907-v2/README.md)에 있습니다.
기존 캡처는 덮지 않았으며, 이번 검증이 끝난 뒤 평가용 서버와 임시 Qdrant를 종료했습니다.

관측 오류에 맞춘 명확한 지침과 별도 실제 모델 평가를 사용하는 방식은
[공식 OpenAI 프롬프트 안내](https://developers.openai.com/api/docs/guides/prompt-engineering)와
[평가 안내](https://developers.openai.com/api/docs/guides/evaluation-best-practices)를 참고했습니다.

## 자료와 해석 범위

평가 JSON은 UTF-8·LF로 기록하고 UTF-8로 읽습니다. `.gitattributes`는 해시 대상 fixture·실행 기록의
자동 줄바꿈 변환을 막으며, Core의 공식 HTML/manifest 표본도 원본 바이트로 보존합니다.
Windows 체크아웃에서도 같은 원본을 재검증하기 위한 규칙이며 기존 캡처의 해시나 측정 결과를 바꾸지 않습니다.
관련 검수 결과는 [추가 프로젝트 검수](../../docs/project-review-20260907.md)에 기록합니다.

[fixture.json](fixture.json)은 **AI가 작성한 가상 공고 3개·10개 청크·12개 질문**입니다.
실제 기업마당 공고나 사람 검토 정답으로 소개하면 안 됩니다.

- 신청 대상 2개, 제출 서류 3개, 없는 정보 3개, 다른 공고 정보 혼입 2개, 지시문 공격 2개
- 기대 상태: `ANSWERED` 7개 / `INSUFFICIENT_EVIDENCE` 5개
- 별첨에만 서류가 있고 별첨 본문은 없는 경우, 미기재 금액·기간을 지어내면 안 되는 경우 포함
- 지시문 공격은 기초적인 사례이며 광범위한 공격 내성 평가가 아님

각 질문에는 선택한 공고의 고정 청크만 전달합니다. 다른 공고 혼입 사례는 질문에 섞인 다른 공고의 정보를
선택한 공고의 조건으로 받아들이는지 확인합니다. 검색기가 다른 공고를 반환하는 상황은 이 도구의 평가 대상이 아닙니다.
`referenceFacts`·`forbiddenClaims`는 답변의 의미를 검토할 때 쓰는 참조입니다. 단어가 등장하는지만으로
정오를 채점하면 부정문과 긍정문을 혼동하므로 자동 문자열 점수에 사용하지 않습니다.

| 출력 | 뜻과 제한 |
|---|---|
| `measured` / `completed` | 모델 실행 기록 유무 / 선택한 사례 모두 오류 없이 응답했는지. 품질 합격 여부가 아님 |
| `caseCount` / `fixtureCaseCount` | 이번 선택 사례 수 / 전체 고정 질문 수. 일부 질문만 실행한 결과를 전체로 오인하지 않도록 분리 |
| `statusAccuracy` | 기대 `ANSWERED`·`INSUFFICIENT_EVIDENCE` 상태 일치 비율 |
| `referenceCitationRecall` | 답변 가능한 질문에서 기대 청크를 인용에 포함한 비율의 평균. 불필요한 인용을 벌점주지 않으므로 전체 청크를 인용해도 1.0일 수 있음 |
| `semanticFaithfulness` | 항상 `null`. 위 두 지표가 높아도 답변 내용의 사실성은 입증되지 않음 |
| `semanticReviewRequired` | 의미 검토가 별도로 필요함. 사람 검토를 강제하는 필드가 아님 |

구조 검증과 의미 평가를 구분하고 일반·경계·공격 사례를 고정하는 방식은
[OpenAI의 평가 안내](https://developers.openai.com/api/docs/guides/evaluation-best-practices)를 참고했습니다.
이번 참조는 AI 작성 가상 자료이고 별도 사람 검증이 없어 실제 공고의 일반화 성능을 주장할 수 없습니다.

## 실행 방법

### Langfuse·Prefect·Pandera·Evidently·pandas 평가 배치

[llmops.py](llmops.py)는 기존 캡처의 점수를 재계산하고 검증된 결과를 Langfuse와 Evidently에 연결합니다.
새 모델 호출 없이 Prefect로 실행하며, 원본 캡처를 덮어쓰지 않습니다.
AI Service와 같은 Python 3.12를 사용하며, 평가 의존성은
`uv sync --locked --extra dev --group evaluation`으로 설치합니다.
이 디렉터리의 전체 테스트에도 `--group evaluation`을 포함해야 합니다.
[개발 서버·무료 검증·실행 명령](../../infrastructure/llmops/README.md)에 구성과 제한 사항을 정리했습니다.

기존 `--execute`는 Langfuse를 명시적으로 활성화한 경우 실제 사례의 `traceId`와
`apiResponseIndexes`를 새 캡처에 남깁니다. 과거 캡처의 원본·해시·보고서는 변경하지 않습니다.

### Ops 실행 명세 검증

`ops_flow.py`는 Django가 접수한 명세와 실행기의 실제 소스·잠금 파일·입력 바이트를 대조합니다.
명세 생성기는 [execution_spec.py](../../backend/ops-service/apps/evaluations/execution_spec.py)이며
명시적인 파일 목록으로 생성·평가 경로를 구분합니다. `execution_release.json`은 빌드 입력이고
실행 중 실제 파일 재검증을 대신하지 않습니다.

새 유료 응답은 명세 없이는 시작할 수 없습니다. 호출 전 실패는 `preflight.json`에 남기고
`execute()` 이후 오류는 이 기록으로 0회 처리하지 않습니다. 기존 CLI `evaluate.py --execute`는
별도의 수동 실행 경로이며 Ops 접수 명세를 대신하지 않습니다.

`EVALUATOR_VERSION`은 평가 코드·입력 모델·식별자 규칙·AI 잠금 의존성의 해시입니다.
의존성 변경도 새로운 점수 ID로 구분합니다. 저장 응답의 과거 프롬프트는 현재 생성 프롬프트와
다를 수 있으며 그대로 보존합니다. 후처리 복구는 원본 평가기와 일치할 때만 허용하고,
다른 평가기로의 재계산을 복구로 표시하지 않습니다.

### 기존 평가 실행기

저장소 루트에서 실행합니다. AI Service 의존성을 먼저 설치해야 합니다
([설치 안내](../../backend/ai-service/README.md)). 서버·MySQL·Qdrant·Excel은 필요 없습니다.

```bash
# 입력 검증만: API 키 불필요, 파일 쓰기 없음, 품질 지표는 null
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/evaluate.py

# 테스트: 실제 Agent/SDK 경로도 HTTP 스텁으로만 검증하며 외부 호출 없음
backend/ai-service/.venv/bin/python -m pytest evaluation/support-program-evidence
```

실제 모델 평가를 선택한 경우에만 아래 명령을 실행합니다. `OPENAI_API_KEY`는 기존 보안 환경변수 주입
방식으로 설정하며, 이 도구는 `.env`를 자동으로 읽지 않습니다. 키를 명령행 인자로 넣지 마세요.

```bash
# 유료: 최대 12회 답변 생성. 기존 폴더가 아닌 새 경로를 지정
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/evaluate.py \
  --execute --output-dir work/evidence-evaluation-v1

# 저장된 결과 재계산: API 호출 없음
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/evaluate.py \
  --capture work/evidence-evaluation-v1/capture.json
```

- OpenAI 공식 API에만 전송하며 기본 모델·타임아웃과 기존 답변 Service·Agent를 사용합니다.
- 순차 실행, SDK 재시도 0회, 질문당 Agent 1턴, 첫 오류 즉시 중단입니다. 임베딩 호출은 없습니다.
- `--case-id E01`로 특정 사례만 진단할 수 있습니다. 여러 사례는 fixture 순서대로 옵션을 반복합니다.
  이미 호출한 실패 사례도 비용·실패 집계에서 제외하지 마세요.
- 모델은 현재 AI Service 기본값을 사용합니다. 실제 값·프롬프트/도구/fixture/요청 해시를 캡처에 기록합니다.
- 매 질문 후 `capture.json`을 저장하며 오류 메시지 원문·키·인증 헤더는 저장하지 않습니다.
  계약 실패 진단용 생성 답변 텍스트(`outputTexts`)와 하위 예외 종류(`causeType`)는 기록합니다.
  API 응답에서 제공한 토큰 사용량과 질문별 지연을 기록하며, 사용량 미제공은 0이 아니라 `null`입니다.
  임시 파일을 끝까지 쓴 후 교체하므로 쓰기·교체 실패가 이전 캡처를 잘라내지 않습니다. 저장 실패가 발생해도
  API 클라이언트는 종료합니다. 남은 `capture.partial.json`은 미완성 기록일 수 있으므로 평가 입력으로 사용하지 마세요.
- 끝나면 `report.json`을 저장합니다. 미완료 실행은 종료 코드 1이며 부분 결과로 전체 점수를 내지 않습니다.
- 재계산 시 fixture·요청 해시·질문 순서·인용·완료 여부를 검사합니다. 해시는 파일 일치를 확인하는 것이며,
  캡처가 실제 API에서 생성됐음을 암호학적으로 증명하지는 않습니다.
- `work/`는 기존 임시 출력 제외 경로입니다. 도구·질문·참조·문서는 모두 Git 공유 대상입니다.
  실제 실행 기록을 팀에 공유할 때는 민감정보를 확인한 뒤 별도 버전 폴더에 보존해야 합니다.

## Ops에서 저장 캡처 비교

[React 운영 화면](../../infrastructure/llmops/README.md#django-운영-화면)에서 자료·기준·후보를 선택하면
`Django → Prefect → 원본 검증 → pandas/Pandera → 지표 재계산 → Evidently/Langfuse`로 진행합니다.
허용 자료는 Ops의 `capture_catalog.json` 한 곳에서 관리하며 임의 경로나 코드를 API로 받지 않습니다.

- `target-coverage-20260907-v1`: 가상 6건의 동일 캡처 재현
- `fixed-context-e01-v1`: 9월 6일 청크 ID 프롬프트와 9월 7일 청크 순번 프롬프트의 공통 E01 비교

후자의 원본은 각각 E01 한 건과 E01·E07·E10·E12 네 건입니다. 원본 전체의 fixture·요청·완료 여부를
먼저 검증한 뒤 카탈로그에 명시한 E01만 메모리에서 선택합니다. 원본 파일은 바꾸지 않으며, 실패한
원본에서 성공 사례만 골라 정상 비교로 만들지 않습니다. 같은 fixture와 같은 사례 순서만 비교합니다.
평가 ID는 원본 캡처·fixture·평가기 버전·선택 사례를 포함하므로 전체 실행과 부분 비교가 구별됩니다.

`comparison.json` 버전 2는 양쪽 실행 정보, 원본/비교 사례, 기준·후보·차이와 사례별 결과를 담습니다.
지연·토큰은 모든 비교 사례의 기록이 있을 때만 평균을 내며, 미측정은 `null`로 유지합니다.
과거 캡처에는 API 응답별 토큰은 있어도 사례별 응답 연결 정보가 없어 순서로 추정하지 않습니다.
의미 충실도도 미측정입니다. 보고서와 비교 JSON의 해시는 manifest에서 확인합니다.
이 경로는 새 모델을 호출하지 않으며 과거 한 사례의 차이를 현재 모델의 전반적 품질로 해석하지 않습니다.

## Ops에서 실패한 후처리 복구

`ops_flow.py`의 `recovery` 모드는 원본 요청·완료 캡처·fixture·비교 기준의 해시를 확인하고,
새 요청 폴더에 바이트를 복사한 뒤 기존 `evaluate_capture`만 호출합니다. `evaluate.execute`는
호출하지 않습니다. 원본의 유료 호출 수는 보존하며 복구의 추가 호출 수는 0입니다.
`llmops.py`는 입력 검증 뒤 해시와 마지막 보고서/등록 단계를 즉시 manifest에 저장하므로
후처리 도중 프로세스가 중단되어도 입력을 확인할 수 있습니다. 입력 검증 이전의 중단은 복구하지 않습니다.
실행 방법과 제한은 [후처리 복구 안내](../../infrastructure/llmops/README.md#후처리-복구)를 참고하세요.

## Ops에서 새 응답 생성

Ops 실행기는 접수 시 DB에 예약한 누적 호출·입력·출력 토큰 한도를 사용합니다. 모델 HTTP 전송 전에
전용 인증으로 소유권과 호출 번호를 승인받고, 응답의 입력·출력 토큰을 정산합니다. 승인·정산 실패나
사용량 누락이면 다음 호출을 차단하며, 응답 유실을 0회/0토큰으로 환급하지 않습니다.
새 명세는 선택 사례마다 `answer:{case_id}` 작업과 모델·입력·출력 상한을 `model_operations`에 고정합니다.
전송 전에 그 작업을 승인받고 응답이 속한 원래 요청의 작업 ID로 정산합니다. 같은 사례의 중복
전송도 차단합니다. 과거 호출의 작업 ID는 추정하지 않습니다. Ops의 `0017_input_token_budget`
migration과 같은 소스로 생성한 실행기·실행 명세가 필요합니다.
`budget_client.py`도 실행 명세에 포함합니다. 예약은 금액 상한이 아니며 전체 RAG 및 직접 실행 CLI의
호출을 합산하지 않습니다. [Ops 누적 한도와 설정](../../backend/ops-service/README.md#누적-호출출력-토큰-한도)을 따릅니다.

[실행 설정](../../infrastructure/llmops/README.md#ops에서-새-모델-평가) 후 Ops에서 새 응답 생성을 선택합니다.
`ops_flow.py`는 승인한 fixture 해시와 비교 기준을 먼저 검증하고 선택 사례만 `evaluate.execute()`에 전달합니다.
실제 생성은 기존 `Service → Agent → OpenAI Responses` 경로를 사용하며 HTTP 서버 초기화에 의존하지 않습니다.
모델은 승인 명세에서 고정하고, 전송 직전 endpoint·모델·출력 제한·호출 예산을 다시 검사합니다.
자동 재시도는 없고 첫 실패에서 중단합니다. `capture.modelApiCalls`는 응답 유실을 포함한 전송 시도 횟수이며
확인된 과금 횟수나 금액이 아닙니다. API 응답이 없으면 토큰을 추정하지 않습니다.

생성 전에는 같은 요청의 모델·입력·지침·응답 스키마·추론 설정을
[OpenAI 입력 토큰 계산 API](https://developers.openai.com/api/docs/guides/token-counting)로 전송합니다.
입력 32,768토큰 초과, 계산 실패·누락·잘못된 형식은 생성 승인 이전에 중단하며 로컬 추정값으로 대체하지 않습니다.
흐름은 `Ops 예약·claim → Service·Agent 요청 → 입력 계산 → Ops authorize → Responses 생성 → settle → close`입니다.
`capture.inputTokenCountRequests`는 계산 요청 시도, `inputTokenCounts`는 작업별 확인값,
`modelApiCalls`는 답변 생성 시도입니다. 계산 요청을 포함한 전체 HTTP 횟수를 생성 횟수로 표시하지 않습니다.
계산은 같은 실행 제한 시간 안에서 수행하며 재시도하지 않습니다. 이는 실제 사용량·청구 확정이 아니며,
Ops 정산은 생성 응답의 usage를 따릅니다. 누적 입력 한도는 CLI에서 활성화해야 합니다.
직접 `--execute`도 호출당 입력 검사를 거치지만 Ops 누적 장부에는 포함되지 않습니다.

생성된 파일은 `/results/<요청 UUID>/capture/capture.json`에 보존하고 같은 질문의 저장 기준과 비교합니다.
각 사례에 응답 사용량 인덱스와 trace ID를 연결하므로 새 응답의 토큰·지연과 Langfuse 점수를 확인할 수 있습니다.
평가 단계의 manifest는 모델 호출 0회이고 전체 요청의 실제 호출 시도 수는 새 캡처에서 읽습니다.
기존 캡처를 덮어쓰거나 모델명을 고치지 않습니다. 완료한 새 결과는 관리자가 검토 후 같은 자료의
비교 기준으로 지정할 수 있습니다. 다음 요청은 기준 UUID·캡처/fixture 해시를 고정하고 실행기는
이를 검증한 뒤 `reference-capture.json`을 실행 폴더에 복사합니다. 기준 교체·철회는 이미 접수한
평가에 소급 적용하지 않습니다. API 계약은 [Ops 검토 안내](../../backend/ops-service/README.md#응답-검토와-비교-기준)에 있습니다.
무료 테스트의 HTTP 스텁 응답은 실제 모델 품질 측정에 포함하지 않습니다.

새 Ops 접수는 품질 정책 내용·코드 해시도 명세에 포함하며 실행 직전 동일 여부를 검사합니다.
완료 응답의 정책 판정은 Django에서 수행합니다. 평가 기준 자료 검토와 후보 답변 검토를 분리하고
현재 근거의 명시적 재판정 이력을 저장합니다. 새 모델 호출이나 기존 Langfuse 점수·Evidently 보고서의
수정은 없으며 계약은 [Ops 품질 판정](../../backend/ops-service/README.md#평가-기준-검토와-품질-판정)을 따릅니다.

2026-09-27 승인된 `gpt-6-luna` 실제 API 테스트는 E01 가상 질문 한 건·1회로 수행했습니다.
토큰·Langfuse trace/점수·보고서 확인 결과와 한계는 [실제 호출 기록](../../infrastructure/llmops/README.md#gpt-6-luna-실제-api-1회-검증)에 보존합니다.
`comparison.json`에는 집계 지표와 실행 식별자를 보관하며, 검토 화면의 답변 원문은 해시가 검증된
후보·기준 캡처에서 읽습니다. 검토 승인은 별도 관리자 기록이며 AI 작성 참조의 출처나 미측정 의미 충실도 값을 바꾸지 않습니다.


## 임베딩 배치 예산 연결: 내부 실행기

`embedding_budget.py`는 기존 AI 서비스의 `prepare_embedding_batches`와 동일한 중복 제거·토큰 계산·
전처리를 사용해 문서/질문 배치별 작업 ID, 모델, 차원, 입력 SHA-256, 최대 입력, 출력 0을 만듭니다.
`EmbeddingBudget`을 `build_evaluation_app(..., embedding_budget=guard)`에 전달하면 기존 SDK의
HTTP hook에서 배치를 대조하고 Ops 승인을 받은 뒤에만 전송합니다. production 의존성은 추가하지 않았습니다.
가드는 `EmbeddingBudget(client, operations, receipt_directory=capture_directory)`로 생성합니다.
호출자는 해당 실행의 `/results/{run UUID}/capture`가 최초 전송 전에 생성되고 Ops의 결과 볼륨과
공유되도록 구성해야 합니다. `build_evaluation_app`의 `output_dir`로 같은 경로를 전달하면 앱 생성 시 준비합니다.

흐름: `고정 배치 계획 → 기존 Service의 임베딩 요청 → SDK 요청 검증 → BudgetClient → Ops 승인 →
OpenAI 임베딩 → usage 검증 → v2 사용량 증거 저장 → Ops 정산 → Service 벡터 검증·캐시`.
요청 URL·모델·입력·차원·추가 필드가 달라지면 전송하지 않습니다. 사용량 누락·상한 초과·timeout·
승인/정산 실패는 다음 전송을 차단합니다. 사용량이 확인되고 벡터만 잘못된 경우 사용량을 정산하고
Service가 결과·캐시 반영을 거절합니다.

이 도구는 **내부 색인·검색 세션용 연결점**입니다. 예약 생성·claim·close 및 자료/예산 승인은 호출자가
수행해야 합니다. 가드를 전달한 세션은 답변 생성을 거절하며, 답변 슬롯을 임베딩 캐시로 건너뛰지 않습니다.
`ops_flow.py`가 이 가드를 자동 사용하지 않으므로 전체 RAG Ops 실행이 연결된 상태는 아닙니다.
답변까지 포함하는 별도의 내부 CLI 연결은 아래 혼합 RAG 예산 세션을 따릅니다.
공개 RAG 자료 계약·manifest·접수·실행 연결은 별도 후속입니다.

캐시 적중으로 완전히 전송하지 않은 배치는 승인하지 않고 남겨 두며 종료 때 예약을 반환합니다.
부분 캐시 적중으로 남은 문자열이 재배치되어 승인한 배치 해시와 달라지면 중단합니다. 이를 자동으로
새 승인 계획으로 바꾸거나 넓은 상한만으로 전송하지 않습니다.

임베딩 증거 v2는 실제 응답의 `x-request-id`·승인 배치 ID/종류·모델·차원·입력 해시·상한·사용량을
보관합니다. 사용량은 `prompt_tokens`/`total_tokens`를 입력/전체로 정규화하며 출력은 0입니다.
이 필드는 [OpenAI 임베딩 문서](https://developers.openai.com/api/docs/guides/embeddings)와
[요청 ID 문서](https://developers.openai.com/api/reference/overview)의 응답 계약을 따릅니다.
요청 ID는 불투명한 값이며 `req_` 접두사에 의존하지 않습니다. 현재 파일 계약은 1~200자의
영문·숫자·`_`·`-`(첫 글자는 영문/숫자)만 허용하며 형식이 달라지면 증거를 생성하지 않습니다.
원문·벡터·키는 저장하지 않고 답변 `response_id`를 임의 생성하지 않습니다.

증거는 기존 `LLMOPS_BUDGET_TOKEN`과 v2 전용 도메인으로 서명해 `usage-{sequence}.json`에
0600 권한·fsync·배타적 생성으로 저장합니다. 저장 실패는 정산 시도와 다음 전송을 막고,
정산 실패에도 이미 저장한 파일은 남습니다. 유효한 요청 ID가 없으면 증거 없이 확인 사용량의 정산을
시도하지만, 정산까지 유실되면 입력 예약을 유지합니다. 사용량 미확인을 0으로 기록하지 않습니다.
닫힌 예약에서 기존 `correct_evaluation_usage`의 미리보기·증거 해시 확인 후 적용으로 복구하며
[Ops 보정 계약](../../backend/ops-service/README.md#증거-기반-미확인-사용량-보정)을 따릅니다.
이 파일은 실행기가 관측한 사용량의 서명 기록이며 제공자의 독립적인 청구 증명은 아닙니다.

무료 검증은 실제 OpenAI SDK·기존 임베딩 Service와 HTTP 대역을 사용합니다. Ops의 실제 MySQL 장부
테스트와 SDK 테스트는 각각 수행하며, 이 결과를 유료 API·전체 RAG/Prefect/Kubernetes 통합 완료로
해석하지 않습니다. 기존 개발 DB migration이나 유료 평가를 자동 실행하지 않습니다.


## 혼합 RAG 예산 세션

`rag_budget.py`는 기존 AI HTTP 색인·검색·답변을 하나의 예약에 연결합니다. 새 프레임워크나
모델 구현은 추가하지 않습니다. `make_rag_spec(cases)`는 1~12개 사례의 `case_id`, `chunks`,
`question`, `limit`를 검증하고 전송 자료·문서/질문 배치·답변 작업·소스/잠금 파일 해시를 고정합니다.
현재 모델은 `gpt-6-luna`, 임베딩은 `text-embedding-3-small`/1536차원이며 답변 입력은 최대
32,768토큰, 출력은 최대 2,000토큰입니다. Ops가 작업 수와 각 작업 상한의 합계로 예약합니다.

흐름은 `앱 시작 → Ops claim → 승인 자료의 PUT chunks → 문서 임베딩 승인·증거·정산 →
POST search → 질문 임베딩 승인·증거·정산 → 실제 검색 결과의 POST answers → 입력 토큰 계산 →
답변 승인·증거·정산 → 앱 종료 시 Ops close`입니다. 기존 Service·Agent·SDK·Qdrant를 사용합니다.

- HTTP의 자료·질문·순서와 SDK의 모델·프롬프트·출력 스키마·상한을 모두 대조합니다.
  검색 결과의 청크 ID·내용 해시·문서 ID·순서가 승인 자료와 같아야 하며 답변에는 실제 검색된
  청크 순서만 전달합니다. 빈 검색 결과, 동시 요청, 누락·재전송·변조는 세션을 중단합니다.
- 답변 전에 [OpenAI 입력 토큰 계산 API](https://developers.openai.com/api/docs/guides/token-counting)에
  실제 요청의 메시지·스키마·추론 설정을 보내고, 계산값을 Ops 승인에 포함합니다. 이 요청은 추가
  외부 요청이며 `inputTokenCountRequests`에 따로 기록합니다. 계산 실패·입력 초과·승인 거절이면
  답변 생성 요청을 보내지 않습니다. SDK 자동 재시도는 사용하지 않습니다.
  같은 입력 계산 요청을 두 번 전송할 수 없으며, 답변 출력 상한은 정수여야 합니다.
- 완전히 캐시된 문서/질문 임베딩 작업만 생략할 수 있습니다. 동일한 문자열이어도 문서와 질문의
  작업 종류를 구분하고 답변 작업은 생략하지 않습니다. 부분 캐시로 배치 해시가 바뀌면 중단합니다.
- 확인한 사용량은 정산 HTTP 전에 기존 임베딩 v2·답변 v1 증거로 저장합니다. 정산 실패에도 증거가
  남으며 원래 미정산 기록의 보정 절차를 사용할 수 있습니다. 응답 유실·사용량 미확정은 0이 아니며
  다음 호출을 막습니다. 잘못된 답변 인용도 실제 관측한 사용량을 먼저 정산한 뒤 서비스가 거절합니다.
  응답 모델과 상태도 승인 계약에 맞아야 합니다. 모델/상태 불일치와 상한 초과 사용량은
  미확인으로 남기고, 유효한 사용량의 불완전 응답은 정산하되 다음 전송을 차단합니다.

내부 `RagBudget(client, spec, receipt_directory=...)`를 `build_evaluation_app(..., rag_budget=guard)`에
전달하거나 다음 CLI를 사용할 수 있습니다. **같은 명세 해시와 flow UUID로 이미 승인·예약된 내부
Ops 실행**이 전제입니다. 이 명령은 실행 접수나 예산 승인·예약을 생성하지 않습니다.
`LLMOPS_OPS_API_URL`, `LLMOPS_BUDGET_TOKEN`, `OPENAI_API_KEY`는 실행 환경에서 주입하고,
자료 전송·모델 호출 승인을 받은 뒤 격리된 로컬 Qdrant와 새 출력 디렉터리를 지정합니다.

```bash
# backend/ai-service에서 실행. 아래 변수는 기존 승인/예약의 값이어야 합니다.
uv run --locked --group evaluation python ../../evaluation/support-program-evidence/serve_flow.py \
  --execute --output-dir "$RAG_CAPTURE_DIR" --qdrant-url http://127.0.0.1:16333 \
  --max-api-calls "$RAG_MAX_MODEL_CALLS" --budget-spec "$RAG_SPEC_PATH" \
  --request-id "$RAG_RUN_ID" --flow-id "$RAG_FLOW_ID" --spec-sha256 "$RAG_SPEC_SHA256"
```

예산 인자 4개는 함께 전달해야 하며 명세의 자료·모델·소스 해시가 현재 실행기와 다르면 시작하지
않습니다. `--max-api-calls`는 명세 작업 수와 같아야 합니다. 서버는 loopback에서만 열리고
세션 종료 시 서버를 정상 종료해야 `close`를 시도합니다. claim/close 실패는 오류로 드러나며
프로세스 강제 종료·close 유실 시 기존 Ops 종료 정리/보정 절차가 필요합니다. 출력 경로는
artifact 조회를 사용하려면 해당 실행의 `/results/{run UUID}/capture`에 연결해야 합니다.
runner 이미지에 모듈을 포함하지만 기본 `ops_flow.py`가 자동으로 이 세션을 시작하지는 않습니다.

무료 `test_rag_budget.py`는 실제 AI 앱·Service·Agent·SDK·메모리 Qdrant와 로컬 예산 HTTP 대역,
모델 HTTP 대역으로 정상·캐시·계산/승인/정산 실패·취소 상태의 승인 거절·응답 유실·미확정 사용량·
인용 오류·명세/CLI 변조를 검증합니다. 실제 Ops HTTP+MySQL 연결은 아래 별도 통합 검사를 따릅니다.
Core 수집기·Prefect를 같은 혼합 실행으로 연결하는 작업은 후속입니다. 공개 RAG live 접수·
사람 검토·품질 판정과 유료 품질 측정 완료를 뜻하지 않습니다.

## 실제 Ops HTTP·MySQL 혼합 예산 검증

`infrastructure/llmops/rag_budget_http_checks.py`는 별도의 Python 3.12 AI 프로세스와 실제
Django WSGI HTTP·serializer·예산 transaction·MySQL 8.4를 연결합니다. 테스트 데이터로
내부 예약을 만들며 공개 RAG 접수 API를 열거나 운영 장부에 실행을 추가하지 않습니다.

흐름: `AI HTTP → 기존 Service/Agent/SDK → 실제 BudgetClient HTTP → Django → MySQL`.
모델 요청은 `rag_budget_http_worker.py`의 전송 대역이 모두 처리하고 Qdrant는 메모리 모드입니다.
대역에 없는 모델 URL은 거절하며 production 예산 함수와 DB 동작은 대체하지 않습니다.

검증 범위는 다음과 같습니다.

- 같은 자료·질문 2회 실행: 문서·질문 캐시로 6개 예약 중 작업 0·1·2·5만 승인하고,
  종료 후 실제 사용량인 호출 4회·입력 203·출력 40으로 장부가 일치해야 합니다.
- 기존 취소 Service로 취소를 기록한 뒤 신규 승인은 거절합니다. 이미 전송된 답변의 확인된
  사용량 정산은 허용하며 취소 상태를 완료 상태로 덮어쓰지 않습니다.
- 승인 응답 유실, 정산 도착 전 실패, 정산 커밋 후 응답 유실을 구분합니다. 미확인 호출은
  상한을 유지하고 이미 커밋한 사용량은 유지합니다. 어느 경우에도 추가 모델 전송을 재시도하지 않습니다.
- 실제 HTTP로 동시 claim·동일 작업 승인을 요청해 소유자와 호출 행이 한 번만 확정되는지 확인합니다.
  잘못된 토큰·배치 해시도 거절하며 종료 실패 후 같은 소유자의 재종료는 중복 차감하지 않습니다.
- 임베딩 v2·답변 v1 증거를 실제 artifact HTTP로 조회해 미리보기·해시 대조·일회 보정을 수행합니다.
  확인된 차액만 반환하고 원래 미정산 호출 행은 보존합니다. 같은 요청의 재적용은 파일 없이도 재현합니다.

두 가상환경을 각 서비스의 잠금 파일로 설치한 뒤, **격리된 MySQL 8.4** 접속값을 지정하고 실행합니다.
Django가 해당 서버에 `test_<DB_NAME>` DB를 생성·삭제하므로 개발·운영 DB 서버를 사용하지 않습니다.

```bash
# 저장소 루트. AI는 uv sync --locked --extra dev --group evaluation, Ops는 uv sync --locked로 설치
RAG_BUDGET_AI_PYTHON="$PWD/backend/ai-service/.venv/bin/python" \
PYTHONPATH="$PWD/infrastructure/llmops" \
backend/ops-service/.venv/bin/python backend/ops-service/manage.py test rag_budget_http_checks --noinput
```

`RAG_BUDGET_AI_PYTHON` 누락·실제 MySQL 8.4 부재는 실패이며 테스트를 건너뛰지 않습니다.
`ops-ci.yml`의 필수 `checks` 작업이 두 환경을 설치하고 전체 Ops 테스트 뒤 이 검사를 수행합니다.
추가 실행 환경과 통합 검사 시간을 고려해 해당 작업의 제한은 25분입니다.
Core·Prefect·외부 Qdrant·Kubernetes 및 관리자 UI 취소 경로는 이 검사의 범위가 아닙니다.


## 공식 HTML 전체 경로 재실행

[Core 통합 테스트](../../backend/core-service/src/test/kotlin/ai/govbiz/core/supportprogram/service/evidence/SupportProgramEvidenceIntegrationTest.kt)는
기본적으로 실제 MySQL 8.4와 고정 HTML·AI HTTP 스텁을 사용하므로 OpenAI 비용이 없습니다.
공식 HTML의 제목·본문 조각과 출처·원본/조각 해시는
[테스트 자료](../../backend/core-service/src/test/resources/support-program-evidence/official-sources.json)에 보관합니다.
이 테스트는 운영 DB가 아닌 Testcontainers DB만 사용합니다.

유료 모델 연결을 선택할 때만 아래처럼 실행합니다. 먼저 Docker로 **비어 있는 별도 Qdrant**를 준비하고,
API 키는 보안 환경변수로 주입합니다. `serve_flow.py`는 별도 production 서버가 아니라 기존 AI 앱을
호출 한도·기록 장치로 감싼 로컬 평가 실행기입니다. 동기화·랭킹 endpoint는 허용하지 않습니다.

```bash
# 저장소 루트: 평가 전용 빈 Qdrant. 운영 볼륨은 연결하지 않음
docker run --detach --rm --name govbiz-rag-evaluation \
  --publish 127.0.0.1:17333:6333 qdrant/qdrant:v1.17.1

# 저장소 루트, 터미널 1: API 비용 발생 가능. 출력은 매번 새 경로
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/serve_flow.py \
  --execute --port 18009 --qdrant-url http://127.0.0.1:17333 \
  --max-api-calls 14 --output-dir work/evidence-flow-v2/api

# 터미널 2: JDK 21·Docker 환경에서 실행. capture 경로는 실제 절대 경로로 지정
cd backend/core-service
GOVBIZ_EVIDENCE_FLOW_AI_URL=http://127.0.0.1:18009 \
GOVBIZ_EVIDENCE_FLOW_CAPTURE_DIR=/absolute/path/to/work/evidence-flow-v2/core \
./gradlew test \
  --tests '*SupportProgramEvidenceIntegrationTest.runsSixFixedOfficialQuestionsThroughThePublicHttpApi' \
  --rerun-tasks --no-daemon
```

빈 Qdrant 기준 공고 임베딩 2회·질문 임베딩 6회·답변 6회, 최대 14회가 예상됩니다. 이미 벡터가 있는
Qdrant를 사용하면 호출 조건이 달라지므로 같은 조건 비교가 아닙니다. SDK 재시도는 없고 첫 오류에서
중단합니다. 예산은 서버에만 적용되므로 다른 평가 실행의 호출도 합산해야 합니다.
평가 서버 내부의 예기치 않은 예외도 중단 상태로 기록하고 이후 요청을 거부하며, 최초 요청의 HTTP 500을
정상 응답으로 바꾸지 않습니다.
`--rerun-tasks`는 이전 Gradle 결과 재사용을 막습니다. 라이브 환경변수를 켠 채 전체 테스트를 실행하지 마세요.
실행 후 서버를 종료하고 평가용 Qdrant만 정리합니다.
위 예제에서 직접 만든 컨테이너라면 `docker stop govbiz-rag-evaluation`으로 종료합니다.
`--rm`이므로 임시 벡터는 제거되지만 별도 출력 경로의 캡처 파일은 유지됩니다.

공유 결과는 API 없이 다시 검사할 수 있습니다.

```bash
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/verify_flow.py \
  --run-dir evaluation/support-program-evidence/runs/official-flow-20260907-v1
```

원문 HTTPS 다운로드 자체는 별도로 확인했고, 반복 가능한 전체 흐름에서는 그때 받은 HTML 조각을
공식 URL의 HTTP 응답으로 재생합니다. 따라서 최신 공식 사이트를 실시간으로 다시 수집한 평가와는 다릅니다.
이 평가의 Core→AI 읽기 제한은 60초이므로 production 제한·지연 검증으로 사용하지 않습니다.

## 실제 호출 흐름과 해석

기존 사용자 기능은 **HTTP API → Service → 원문 수집/Repository → AI Facade → AI HTTP API → Service → Agent → OpenAI → Response**입니다.
그 과정에서 근거 청크를 별도 Qdrant 컬렉션에 색인·검색하며 Core가 최종 인용문을 원래 청크에서 구성합니다.
자세한 내용은 [기존 호출 흐름](../../docs/architecture.md)을 따릅니다.

이 평가 도구는 **고정 fixture → 기존 AI 답변 Service → Agent → OpenAI → 캡처/보고서**입니다.
HTTP API·원문 수집·DB·청킹·임베딩·Qdrant를 생략하므로 `scope=fixed-answer-context-only`로 기록합니다.

전체 흐름은 `scope=core-http-mysql-frozen-html-ai-evidence-flow`로 별도 기록합니다.
`completed`는 실행·계약 검증의 완료이며 모델 의미의 정답 판정은 아닙니다. 상태 일치·인용 무결성과
답변 의미 검토를 구분하고, AI-only 검토를 사람 검토로 소개하지 않습니다. 현재 공식 자료는 공고당
청크 1개뿐이므로 이 결과로 다수 청크 중 검색 성능이나 일반적인 RAG 정확도를 주장하지 않습니다.

첨부파일·PDF/OCR 확장과 새로운 제공처 추가는 이번 검수에 포함하지 않습니다.
