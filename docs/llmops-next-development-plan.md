# LLMOps 개발 현황과 후속 전략 — 임베딩 사용량 증거와 보정

[문서 목록](README.md) · [도입·구현 이력](langfuse-adoption-strategy.md) · [Ops API](../backend/ops-service/README.md) · [실행 안내](../infrastructure/llmops/README.md)

## 현재 완료 판단과 다음 개발 순서 — G2 임베딩 증거 보정

개인 PC의 Kubernetes + Compose 운영 기반 고도화는
[병합 규칙](merge-protection.md) → [기존 환경 갱신·복구](ops-upgrade-runbook.md) 순서로 진행한다.
리뷰 승인 0명 정책을 유지하면서 CI 종합 판정과 규칙 점검 도구, Ops 갱신 단계 기록을 추가했다.
이는 로컬 코드 구현이며 원격 ruleset 적용·개인 PC migration·무료 평가·실제 백업 복원 완료가 아니다.
아래 RAG 기능 후속 과제와 별개로 배포 기반의 실제 검증 증거를 먼저 확보한다.

2026-10-01 저장소와 원격 CI를 다시 대조했다. 아래의 이전 구현·DB 집계는 당시 기록이며
현재 개발 우선순위는 이 절을 따른다. 후속으로 G1의 캡처 연결을 구현했으며 운영 DB의
현재 검토·기준·예산 상태나 실제 배포 버전은 조회하지 않았다. 과거의 기준 0건 등을 현재 수치로 재사용하지 않는다.

현재 단계는 **고정 근거 평가의 운영 기능을 갖추고, 전체 RAG의 실제 실행·예산·검토 연결을 준비하는 단계**다.
서로 무게가 다른 기능 수를 합산한 완료율 대신 적용 범위와 증거를 구분한다.

| 영역 | 코드 기준 진행 상태 | 아직 완료로 판단할 수 없는 범위 |
|---|---|---|
| React·Django 운영 기능 | 기존 Core 관리자 로그인, 접수·조회·비교·동기화·실패 후처리 복구 구현 | 새 RAG 평가의 접수·실행·비교는 미연결 |
| 자료·응답 검토와 품질 정책 | 고정 근거의 사람 검토, 판정 이력, 기준 지정·철회·오래된 합격 차단 구현 | 현재 모델의 유효한 사람 검토 기준은 이번 점검에서 미확인; 전체 RAG 정책 없음 |
| 예산·취소 | 고정 근거 live의 누적 장부·입력 계산, 내부 혼합 예약·임베딩 SDK 가드·호출별 상한·v2 증거 보정 구현 | 새 migration의 실제 환경 적용·변경 SHA CI·RAG 접수/실행기 연결·금액/기간 한도·runner→Kubernetes 왕복 검증 |
| 관측·인프라 복구 | Core→AI 상세 RAG 추적, Prefect·sync·artifact·컨테이너 교체·보고서 변조 검증 구현 | 최신 SHA의 전체 통합 CI, 개인/운영 환경 적용·복원 완료는 별도 증거 필요 |
| RAG 오프라인 평가 | v1 계산기·v2 대역 출처와 Core 다중 청크 수집 10사례 실제 서버 검증 | 필수 CI 회귀 수정, 공식 HTML 수집 연결, 사람 검토 계약과 Ops 품질·기준 지정 |
| 자동 운영 | 상시 실행기와 상태 동기화 존재 | 정기 모델 평가, 품질/비용 알림, 품질에 따른 배포 차단은 별도 후속 |

### 이번 후속 구현 — 임베딩 서명 증거와 입력 차액 보정

`skn-96 / 909b793` 이후의 변경을 `skn-98`에 기록한다. 내부 문서·질문 임베딩 가드에 증거 저장을 연결하고
기존 Ops CLI 보정과 React 조회를 확장했다. 새 의존성·유료 호출·개발 DB migration은 없다.

- 실제 응답 요청 ID·작업/배치 해시·모델·차원·상한·사용량을 v2 전용 HMAC으로 서명한다.
  원문·벡터·키를 저장하거나 답변용 응답 ID를 만들어 넣지 않는다. 기존 답변 v1 형식은 보존한다.
- 정산 HTTP 전에 증거를 배타적으로 저장한다. 저장 실패는 다음 전송을 차단하고, 정산 실패 후에도
  파일이 남는다. 요청 ID가 없거나 현재 허용 형식이 아니면 증거 없이 정산을 시도하되 실패 시 예약을 유지한다.
- 닫힌 미확인 호출만 미리보기·증거 해시 확인 후 보정한다. 승인 명세·소유자·시각·배치·상한을 대조하며
  입력 500 예약/100 사용 예에서는 입력 400만 반환하고 호출 횟수·출력 0·원본 미정산 행을 보존한다.
- migration `0019_embedding_usage_receipt`는 고유한 임베딩 요청 ID와 답변/임베딩 식별자의 상호 배타 제약을 추가한다.
  중복/동시 보정은 한 번만 반영하며 감사 저장 실패는 장부 변경도 롤백한다. 과거 답변 증거는 유지한다.
- 관리자 API/React는 임베딩 요청 ID·확정 입력·입력 차액을 읽기 전용으로 표시한다. 잘못된 작업 종류·
  식별자 혼용·입력 차액·출력 사용량·중복 요청 ID는 거절한다.

호출 흐름: `기존 임베딩 SDK → v2 증거 파일 → Ops 정산 시도`;
유실 복구는 `CLI 미리보기 → 해시 확인·적용 → MySQL 보정 이력/입력 차액 → 관리자 API → React`다.
파일은 실행기가 관측한 사용량의 증거이며 OpenAI의 독립적인 청구 확인은 아니다.
자세한 경계와 실행법은 [Ops 보정 계약](../backend/ops-service/README.md#증거-기반-미확인-사용량-보정)과
[평가 실행기](../evaluation/support-program-evidence/README.md#임베딩-배치-예산-연결-내부-실행기)에 기록했다.

로컬에서는 기존 Python 3.12 가상환경과 Node 24를 사용했다(`uv`가 PATH에 없음).
평가 실행기 선택 100건 통과 후 SDK→실제 증거 파일 회귀를 추가해 해당 모듈 21건을 확인했다.
격리 MySQL 8.4에서 예산·보정 69건, 추가 질문 배치/증거 혼용 및 migration 보존을 확인했다
(서로 다른 테스트 총 70건, 추가 재검증 포함). 추가 테스트의 요청 UUID 중복과 오래된 ORM 캐시를
수정한 뒤 해당 회귀를 다시 통과시켰다.
React 관련 94건은 최종적으로 모두 통과했다(화면 문구 검증 수정 후 해당 파일 41건 재검증).
Ops Ruff·포맷·migration 정합성, Web 타입·정적 검사, 실행 manifest를 확인했다.
SDK에는 HTTP 대역을 사용했고 MySQL은 별도 임시 컨테이너였다. 실제 RAG/Prefect·Kubernetes 왕복은 남았다.

기준 커밋 `909b793`은 GovBiz·Ops·Infra·Catalog CI 성공,
[LLMOps CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36732564802) 실행 중으로 확인했다.
이번 변경의 전체 CI는 `skn-98` 최종 커밋·푸시 SHA에서 확인해야 한다. 기존 CI의 push/PR에
Ops 전체 MySQL 테스트, 평가 실행기 전체 pytest, Web 전체 검증이 포함되어 있다.

다음은 **RAG 실행 명세·자료·Prefect 경로 연결과 무료 통합 검증 → Compose 실행기→Kubernetes Ops 왕복 →
공개 RAG replay·검토 계약** 순서다. 그 뒤 승인된 자료·호출 예산에서 live를 검증한다.
금액·기간 한도와 정기 실행은 별도 후속으로 유지한다.

### 직전 구현 — 혼합 작업 장부와 임베딩 SDK 승인 경계

`skn-92 / 20f03c2` 이후 작업이다. **공개 RAG 실행은 아직 연결하지 않았다.**
작업별 예산 계약과 기존 Service의 실제 SDK 전송 경계를 먼저 구현했다.

- 내부 RAG 명세는 문서/질문 임베딩과 답변의 작업 ID·모델·개별 상한을 고정한다. 임베딩은 차원과
  전처리 배치 해시도 대조하며 출력 0, 누적 입력 한도 필수를 적용한다. 예약 총량은 개별 상한의 합계다.
- 가상 사용량을 만들지 않고 실제 응답의 usage로 정산한다. 승인/정산 유실·timeout·미확인 사용량은
  다음 호출을 막고 해당 입력 예약을 유지한다. 캐시로 전송하지 않은 임베딩 슬롯만 건너뛰며 답변은 건너뛸 수 없다.
- 종료·취소·종료 정리·답변 증거 보정과 관리자 API/React가 호출별 상한을 사용한다.
  migration `0018_operation_token_limits`는 nullable 4개 필드를 추가하며 과거 기록에는 당시 예약 상한을 사용한다.
- `EmbeddingBudget`은 `serve_flow.build_evaluation_app`에 주입할 수 있는 내부 색인·검색 연결점이다.
  현재 CLI·Prefect·공개 Ops 접수에서 자동으로 사용하지 않는다. 부분 캐시로 배치가 달라지면 승인 해시 불일치로 중단한다.
- 당시에는 임베딩용 증거·보정이 미구현이었으며 현재는 위 v2 계약으로 확장했다. 답변 v1은 혼용하지 않는다.

호출 흐름: `고정 배치 → 기존 Service → SDK 요청 대조 → Ops 작업 승인 → OpenAI 임베딩 →
usage 검증·Ops 정산 → 벡터 검증·캐시 → 종료 후 미사용 예약 반환`.
실제 API 대신 HTTP 대역을 사용했고 개발 DB·사용량·실제 승인 기록은 변경하지 않았다.

검증 결과와 실행 제약은 [Ops README](../backend/ops-service/README.md#임베딩-배치별-예산-내부-실행-계약)와
[평가 실행기 README](../evaluation/support-program-evidence/README.md#임베딩-배치-예산-연결-내부-실행기)를 함께 따른다.
이번 변경은 `skn-96`에 기록하며 최종 SHA의 전체 CI를 별도로 확인한다. 실제 Kubernetes 연결·현재 모델 품질 검증으로 판단하지 않는다.

로컬 검증: 격리 MySQL 8.4의 예산·동시성·migration·복구·보정 82건, 평가 실행기 선택 pytest
83건과 평가 서버 13건, React 관련 84건이 통과했다. Ops Ruff·웹 타입/정적 검사·migration 정합성·
실행 manifest 검사를 수행했다. Python 3.12 기존 가상환경을 사용했으며 새 의존성은 없다.
예약 명세와 저장 총량 불일치 차단을 추가한 뒤 관련 MySQL 41건을 재검증했다(위 82건과 중복 포함).
전체 컨테이너·실제 RAG/Prefect·Kubernetes 검증은 완료하지 않았다.

실행 명령은 기존 Python 3.12 가상환경의 `python -m pytest`로 평가 경로의
`test_embedding_budget.py`, `test_budget_client.py`, `test_execution_spec.py`, `test_ops_flow.py`,
`test_serve_flow.py`와 인프라의 `test_cancellation_smoke.py`를 선택했다.
격리 MySQL에서는 `manage.py test`로 `apps.evaluations.test_embedding_budget`,
`test_budget_operations`, `test_budget_cleanup`, `test_usage_correction`, `test_input_budget`,
`test_budget_reporting`, `test_budget`을 선택했다. Web은 Node 24의 Vitest로
`BudgetPanel.test.tsx`, `App.ops.test.tsx`를 실행하고 `tsc -b`·Oxlint를 확인했다.
전체 CI는 기존 `ci.yml`·`ops-ci.yml`·`llmops-ci.yml`의 push/PR에서 수행한다.

**기준 SHA CI 실패 보완:** [LLMOps CI의 취소 검사](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team/actions/runs/36728469723)가
`settle_error` 시나리오에서 실패했다. artifact상 별도 보정 이력은 입력 100을 반영했고 전역 입력 증가도
100이었다. 원래 호출 행은 계약대로 NULL로 유지됐지만 검증기가 보정 행을 무시해 32,768을 기대했다.
DB 스냅샷에 별도 보정 행을 포함하고 최종 검증에서 이를 대조하도록 수정했다. 취소 도구 무료 테스트 62건이 통과했다. 원래 호출 행은 변경하지
않는다. 보정 누락·중복·다른 호출 지정·0 반환·원본 변경 거절 회귀를 추가했다.
CI artifact의 같은 장부/보정 근거를 대조해 수정 계산을 확인했으며 전체 Compose CI 재실행 성공은 별도 확인이 필요하다.

이 절의 수치는 직전 변경 당시 검증이며 현재 후속 순서는 상단을 따른다.

### 직전 구현 — 입력 예산의 승인·정산·운영 화면 연결

적용 범위는 `fixed-answer-context-only`의 새 live 평가다. **전체 RAG G2 완료가 아니다.**

- 입력 32,768토큰/호출을 명세와 예약에 고정하고, 접수 시 사례 수만큼 최대 입력을 예약한다.
- 생성 요청의 메시지·지침·응답 JSON 스키마·추론 설정을 OpenAI 입력 계산 API로 확인한 후 Ops에서
  작업 ID·모델·상한·계산값을 승인한다. 실패·잘못된 응답·상한 초과 시 생성하지 않는다.
  계산 요청은 추가 외부 요청이며 답변 생성 시도와 별도 카운터로 보존한다.
- 정산·종료·취소·종료 정리·서명 증거 보정에 입력 장부를 연결했다. 동시 접수는 같은 DB 잠금을 사용하고
  미확인 호출은 최대 입력 예약을 유지한다. 보정은 실제 usage를 반영하며 원래 승인·미정산 기록은 보존한다.
- `0017_input_token_budget`는 확인된 과거 입력만 합산한다. 과거 상한·계산값은 NULL이다.
  과거 미확인 호출/열린 구형 예약/예약 없는 live가 있으면 입력 한도 활성화를 거절한다.
- `set_evaluation_budget --input-tokens`로 운영자가 승인한 누적 입력 한도를 명시해야 한다.
  미설정은 기존 호출·출력 한도만 적용하며, 새 입력 예약 기록만으로 누적 한도 적용을 주장하지 않는다.
- React에 입력 한도 적용·미설정·과거 미확인과 예약/정산/반환·호출 전 계산·변경 이력을 표시했다.
  과거 API 필드 누락과 미확인 사용량을 0으로 채우지 않는다.

흐름: `관리자 동의 → Django 입력 예약 → Prefect claim → 요청 입력 계산 → Ops 작업 승인 →
OpenAI 답변 → 사용량 정산 → 종료/보정 → React 장부`.
설정·마이그레이션은 [Ops README](../backend/ops-service/README.md#입력-상한과-이전-장부-전환)를 따른다.

로컬 검증은 실제 외부 모델 호출 없이 수행했다. 평가 실행기 관련 pytest 139건, 취소 도구 56건,
웹 관련 83건을 검증했고 MySQL 8.4를 별도 네트워크·임시 DB로 띄워 예산 91건과 접수·복구·취소 등
추가 범위 99건을 실행했다(두 MySQL 실행에는 중복 테스트 포함). Ops Ruff, migration 정합성,
웹 타입 검사와 정적 검사·`git diff --check`도 통과했다. 마지막으로 입력 초과 증거 거절과 과거 보정값 migration 보존 2건을 재확인했다. `uv`가 PATH에 없어 기존 Python 3.12 가상환경을 사용했다.
실제 개발 DB migration·입력 한도 설정·기존 컨테이너 교체·유료 API 검증은 수행하지 않았다.
전체 Ops/MySQL/컨테이너·LLMOps Compose·Web 검증은 기존 CI의 push/PR 이벤트에 연결돼 있으며
위 검증은 직전 입력 예산 개발 당시 기록이다. 현재 변경과 후속 순서는 문서 상단을 따른다.

### 확인한 차이와 후속 구현 상태

1. **현재 예제는 실제 청킹 산출물이 아니다.** `rag-fixture.json`은 원문 280/96 UTF-16 단위를
   수동으로 6/2청크로 나눴다. 현재 Core의 1,500단위 packing 규칙이면 각 원문은 1청크가 된다.
   따라서 이 예제의 청크·기대 인용을 실제 Core 캡처에 그대로 적용할 수 없다.
   기존 계산용 예제를 보존하고 실제 청커가 6개를 만드는 별도 가상 원문과 Core 단위 테스트를 추가했다.
2. **새 평가기는 Ops 밖에 있다.** 실행 명세와 품질 정책은 여전히 `fixed-answer-context-only`이며,
   `ops_flow.py`는 기존 `evaluate.py`를 호출한다. 범위 문자열만 바꾸거나 카탈로그에 파일만 등록하면 안 된다.
3. **자료·실행의 출처 구분이 더 필요하다.** RAG fixture v1은 가상·미검토 자료만 허용한다.
   합성 capture는 trace가 null이어야 하고, 저장 capture의 모델명·trace 형식은 실제 유료 호출 증명이 아니다.
   v2에 실제 서버+모델 대역의 `integration-stub` 출처를 추가했다. 승인된 유료 실행·자료 검토 계약은 남았다.
4. **내부 예산 계약만으로 RAG 실행이 연결되지는 않는다.** 작업별 입력·출력 예약과 SDK 가드는 구현했다.
   실제 RAG 명세·자료·실행기·승인/정산/취소 왕복을 통합 검증하기 전에는 RAG live를 열지 않는다.
5. **평균만으로 합격을 판단할 수 없다.** 새 지표는 성공한 측정의 평균이며 실패는 null이다.
   측정 수·전체 대상 수·필수 사례 실패를 같이 판정해야 하고 인용 recall만으로 과잉 인용·의미 정확성을 보장하지 않는다.

### 실행 순서와 종료 조건

| 순서 | 구현 묶음 | 종료 조건 |
|---|---|---|
| G0 — 취소 검사 회귀 보완 | 최신 커밋 검증 확정 | `skn-92 / 20f03c2`의 GovBiz·Ops·Infra·Catalog 성공, LLMOps 취소 검사 실패 확인. 보정 이력 누락 계산을 수정했으며 `skn-96` 최종 SHA의 전체 CI가 필요 |
| G1 — 해당 통합 단계 통과 | production 청킹 자료와 실제 Core 캡처 수집 | `b1d9f03` 실제 서버 CI·artifact의 2개 원문 버전·10사례 통과 확인. 전체 workflow 실패와 구별. 공식 HTML 다운로드·추출은 별도 미구현 범위 |
| G2 — 작업별 예산 기반 구현 | RAG 호출별 예산·취소와 Kubernetes 경로 | 혼합 예약·임베딩 SDK 가드·캐시 슬롯·호출별 정산/복구/화면·임베딩 증거 보정 구현. 실제 RAG 명세·실행기 연결, Compose 실행기→Kubernetes Ops 인증·DB 왕복은 남음 |
| G3 | Ops RAG 접수·결과·검토 계약 | 명세·카탈로그·manifest·복구·Django API·React를 함께 연결. 먼저 무료 replay, 그 뒤 G2를 충족한 live 경로. 기존 고정 근거와 범위가 다른 기준 비교·혼합 판정 거절. 전체 사례·실패·trace·두 지표를 화면에서 대조 |
| G4 | 검토 자료와 현재 모델의 실제 기준 | 출처·고정 원문·기대 근거에 대한 사람 검토와 전송/호출 예산 승인 후 실제 평가. 응답 사례 검토→해당 범위 품질 판정→명시적 기준 지정. 같은 자료·질문·정책의 후보 비교 1회를 끝까지 검증 |
| G5 | 정기 실행·알림·승격·배포 | 기간별 입력/임베딩/출력 또는 금액 한도, 겹친 실행 방지·취소·실패 알림을 먼저 검증. 동일 모델/프롬프트/자료/정책의 유효한 품질 판정을 배포 판단에 연결. 발행 이미지·실제 환경·백업 복원 증거를 별도로 확보 |

G1에서는 정상, 실제 다중 청크 검색, 캐시 재사용, 원문 버전 변경, 검색 실패, 답변 실패/시간 초과,
잘못된 인용을 검증한다. 각 오류가 보고서와 trace의 같은 사례·단계에 연결되고 누락 사례를 성공으로
계산하지 않아야 한다. 유효 trace는 실제 Langfuse 관측과 대조하되 trace 장애를 품질 성공으로 숨기지 않는다.
자동으로 채운 모델명·trace ID나 편집한 캡처만으로 통합 검증을 통과시키지 않는다.

실자료 계약은 새 버전 또는 명시적인 확장으로 도입하고 출처·수집 시점·원문 해시·검토 ID를 고정한다.
기존 v1 합성 자료를 사람 정답으로 바꾸거나 과거 품질 판정을 소급 승인하지 않는다.
검색 자료/청킹/임베딩 변경과 답변 모델/프롬프트 변경을 기록해 비교 대상의 차이를 설명할 수 있어야 한다.

기존 고정 근거 자료·응답의 사람 검토와 현재 기준 상태 조회는 개발과 병행할 수 있다.
기존 승인 범위의 고정 근거 기준을 먼저 확보하더라도 전체 RAG 기준으로 승격하지 않는다.
모델 교체·프레임워크 추가·스케줄 활성화·운영 화면 확장부터 시작하지 않고 G1의 실제 산출물 연결을 먼저 끝낸다.
`deploy/fork` 방식은 계속 사용하지 않는다.

검증 현황: 기준 `4537e5f`의 필수 CI 5개 성공을 확인했다. 이번 후속 변경은 `skn-75`에 기록하며 최종 SHA의 CI를 별도로 확인한다.
로컬에서는 Core `SupportProgramEvidenceChunkerTest`와 무료 회귀 85건(수집기·설정·평가기),
기존 상세 추적 검사기 33건이 통과했다. 설정 테스트에서 시험용 Langfuse 환경 누락을 수정한 뒤
해당 4건을 다시 확인했다. 새 파일 Ruff·포맷, Compose 설정 렌더링·격리와 문서 링크를 검증한다.
`uv`가 PATH에 없어 기존 Python 3.12 AI 가상환경으로 실행했다. 실제 MySQL·Qdrant 서버·Langfuse
통합은 LLMOps CI에 연결했으며 새 SHA의 결과를 확인하기 전에는 전체 완료로 표시하지 않는다.

### 추가 고도화 — 임베딩 입력 상한과 사용량 근거

두 임베딩 서비스에서 실제 전송 문자열을 `cl100k_base`로 계산해 요청별 상한으로 배치를 나눈다.
`OPENAI_EMBEDDING_REQUEST_TOKEN_LIMIT`은 기본 262,112이며 1~262,112만 허용한다.
기존 8,191 토큰 절단을 유지하고, 이후에도 설정 상한을 넘는 단일 입력이나 빈 문자열이 있으면
모든 입력의 사전 검사에서 첫 HTTP 요청 전에 거절한다. 임베딩 응답의 prompt/total 사용량 누락·형식 오류·
불일치·상한 초과는 오류이며 실패 결과를 캐시에 저장하거나 색인하지 않는다.

근거 RAG의 실제 배치마다 `evidence.embedding.request`를 기록한다. 문서/질문 부모, 배치 순서/크기,
토큰 추정과 설정 상한, 보고 사용량을 남기고 사용량을 확인하지 못한 호출은 `unknown`으로 구분한다.
완료한 앞 배치의 보고 사용량은 뒤 배치 실패에도 보존한다. 캐시 hit는 새 호출로 기록하지 않는다.
SDK 원문·질문·키 마스킹을 유지하고 기존 합성 추적·실제 Core 캡처 검사기도 새 하위 관측을 검사한다.
실제 흐름은 `Core → AI 입력 준비·배치 → OpenAI → 사용량·벡터 검증 → Qdrant`다.

이전 임베딩 변경은 **G2의 요청별 입력 제한과 관측 근거**까지였다. 고정 근거 누적 입력 예약은 위 후속 구현을 따른다. 임베딩 작업별 승인·정산,
금액/기간 한도, runner→Kubernetes 왕복, Ops RAG 접수·사람 검토는 아직 완료하지 않았다.
설정은 환경변수 예제·개발/운영 Compose에 연결했으며 기존 개발 컨테이너를 교체하거나 실제 키로
모델 호출을 하지 않았다. 추적·설정 소스 변경에 맞춰 실행 release를 재생성하며 기존 이력은 수정하지 않는다.

직전 `skn-84 / 2a5e9e2`의 Ops·Infra·Catalog CI가 성공했다. Ops의 MySQL migration/작업 ID 제약
검증은 통과했고, GovBiz는 Core `expiresStaleQueuedAndRunningJobs` 한 건 실패로 컨테이너 단계가
건너뛰어졌다. 테스트가 재접수를 만든 후 대기열이 비어야 한다고 검사하는 모순을 수정해 **재접수 작업만
대기열에 남는지** 확인한다. production 만료·재접수 규칙은 바꾸지 않는다.
해당 SHA의 [GovBiz CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36721263687) 실패는
이번 임베딩 코드 변경 전 결과이며, [LLMOps CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36721263747)는
조회 당시 실행 중이다. 이번 미커밋 변경의 전체 CI 성공으로 해석하지 않는다.

로컬 검증은 Python 선택 297건과 Core MySQL 8.4 통합 3건이 통과했다.
AI 입력/설정/bootstrap/캐시/추적 219건, Core 추적·RAG 캡처 대역 50건,
기존 추적 smoke 1건, 실행 명세 23건, Compose 설정 검사 4건이다.
Python 3.12의 기존 `.venv/bin/python -m pytest <대상 경로>`를 사용했다(`uv`가 PATH에 없음).
Core는 JDK 21에서 `./gradlew test --tests 'ai.govbiz.core.applicationpreparation.repository.ApplicationDocumentGenerationJobRepositoryIntegrationTest' --no-daemon`으로
CI 실패 범위만 실제 MySQL Testcontainers에서 검증했다. Ruff 오류 검사, 실행 release 대조,
Compose 기본/변경 상한 렌더링, 문서 링크 및 `git diff --check`를 확인한다.
무료 대역과 SDK exporter 검증이며 이번 변경의 실제 Langfuse 서버 저장·전체 클러스터 검증은
GovBiz/LLMOps CI에 맡긴다. 새 코드의 전체 CI 결과는 아직 없다.

커밋·리베이스 기록: 이번 변경은 `skn-91`에서 관리한다. `origin/main`과 `upstream/main`이
같은 `b1c7297`임을 확인하고 `git pull --rebase origin main`을 수행했다. Core 대기열 테스트는
같은 수정이 이미 main에 병합돼 있어 원격의 `retried` 변수명과 설명 주석을 유지했다.
임베딩·추적·설정 변경은 리베이스 전과 동일하며 기존 로컬 검증을 반복하지 않았다.
실행 release 대조와 `git diff --check`를 재확인했으며 최신 커밋의 전체 CI 결과는 별도로 확인한다.

### 이번 후속 고도화 — 사례별 답변 작업과 장부 연결

`main / 77fd6f7`의 기존 회귀 보완을 보존하고 G2의 첫 단위로 **고정 근거 답변 작업 식별**을 구현했다.
전체 RAG 예산·운영 접수를 완료한 것은 아니다.

- 새 실행 명세의 `model_operations`에 사례별 `answer:{case_id}`·종류·모델·최대 출력을 고정한다.
  명세 변경·계획 누락·순서 교체는 실행 전 검사에서 거절한다.
- HTTP 전송 직전 작업 승인을 받고 같은 요청의 작업으로 정산한다. DB는 다른 사례의 승인·정산,
  동일 작업 재승인, 이전 사용량 미확인 상태의 다음 작업을 거절한다. 취소 뒤 새 승인은 차단한다.
- `0016_budget_operation_identity`는 nullable ID와 예약별 고유성 제약을 추가한다.
  과거 사용량·예약을 보존하고 과거 사례 연결은 추정하지 않는다. React 장부에 작업 ID/미기록을 표시한다.
- 취소 통합 실행기에도 같은 작업 ID 전달을 연결했다. 추가 production 의존성·서비스는 없다.
  실제 운영 DB 변경과 유료 API 호출은 수행하지 않았다.

로컬 무료 평가·실행기 131건, DB 없는 Ops 계약 7건, 취소 대역·검사기 55건, React 장부 26건으로
선택 테스트 219건이 통과했다. MySQL의 중복 제약·migration 보존·취소·정산 검증은 새 테스트를 Ops CI에
연결했으며 로컬 단위 검증으로 대체하지 않는다. 로컬 mysqlclient 미설치로 Ops 계약 검사는 DB 접근을
금지한 dummy backend를 사용했다. Python 3.12 기존 가상환경을 사용했으며 `uv`는 PATH에 없다.
Node 24.19.0/pnpm 11.22.0에서 루트 `pnpm install --frozen-lockfile`은 통과했다. sandbox의 pnpm
실행 전 검사에서 재설치를 요구해 설치된 Vitest·oxlint를 Node 24로 직접 실행했다. 잠금 파일은 유지했다.
Ruff·oxlint·TypeScript(`tsc -b --noEmit`)·migration 변경 누락 검사·실행 명세 검증을 확인했다.
새 SHA의 전체 CI는 아직 대기이며
커밋·푸시는 별도 요청 시 수행한다.

남은 순서는 **입력·임베딩 토큰 예약과 문서/질문 임베딩 작업 → 실제 RAG 승인·정산·취소 연결 →
runner→Kubernetes Ops 왕복 → Ops RAG 접수·검토**다. 기존 장부는 계속 호출·출력 토큰 상한이며
금액 한도나 전체 RAG 지출 통제가 아니다. RAG live와 정기 실행을 활성화하지 않는다.

### 직전 후속 보완 — 설정 검사와 Prefect 접수 복원력

현재 작업 기준은 `main / 77fd6f7`이며 커밋·푸시는 별도 요청 시 수행한다. `skn-75 / b1d9f03`의
RAG 단계·artifact는 통과했지만 GovBiz와 LLMOps 전체 CI는 실패했다. G2 확장 전에 아래 회귀를 보완했다.

1. **설정 검사 의존성:** `--config-only`가 RAG 평가기를 import하면서 표준 Python에 없는 Pydantic을
   요구했다. 실제 캡처 실행 직전에만 import하도록 옮겼다. 자원을 만들기 전 의존성 검사는 유지한다.
   `python -S`로 같은 실패 2건을 재현했고 관련 4건이 수정 후 통과했다. 검사에서 평가기 import 자체도 금지한다.
2. **Prefect 일시적 503:** 취소 검증 `after_settle` 접수에서 Prefect가 반환한 503과 미사용 예약
   6회/12,000토큰 보존을 artifact에서 확인했다. 내부 DB 잠금 여부는 확정하지 않는다.
   생성 POST에만 동일 deployment·인자·요청 키로 최대 3회(대기 0.5초·1초) 전송한다.
   응답 유실·시간 초과·다른 HTTP 오류·잘못된 응답은 재시도하지 않는다. 예산·모델 호출 재시도도 추가하지 않는다.
3. **검증 보강:** 첫 생성 503 뒤 실제 flow 하나·예약 하나·대기 취소 후 미사용 몫 반환을 확인하는
   `dispatch_busy_once`를 기존 CI에 추가해 총 13개 시나리오를 유지한다. 접수 실패 HTTP 상태도 산출물에 남긴다.
   재시도 대기 중 취소가 접수되면 취소 의사와 예약을 유지하고 worker 승인을 거절하는 DB 회귀를 추가했다.

로컬 Ops DB 없는 계약 14건, 취소 대역·검사기 52건, stdlib 설정 검사 4건이 통과했다.
Ops 로컬은 mysqlclient 미설치 때문에 dummy backend로 DB 접근을 금지했으며 MySQL 검증을 대체하지 않는다.
실제 MySQL 회귀·13개 서버 시나리오·전체 필수 CI는 새 SHA에서 확인한다. `main / 7a29f12`의 기존
LLMOps CI 성공은 확인했지만 이번 수정의 검증 결과로 재사용하지 않는다. RAG live·스케줄 활성화와
G2의 현재 진행 범위는 위 사례별 답변 작업 절을 따른다. 임베딩 예산과 전체 RAG 연결은 남아 있다.

### 이번 G1 구현과 남은 범위

- Core 테스트와 CI가 동일한 가상 원문을 사용한다. 실제 청커의 6개 경계와 원문 변경 시 ID 전환을 검증한다.
- 시험용 ASGI 래퍼를 임시 AI에만 읽기 전용으로 연결해 실제 색인·검색·답변 요청/응답을 수집한다.
  production 의존성·이미지·서버 API·운영 UI는 추가하지 않는다.
- 정상·캐시·검색 누락·인용 누락·근거 부족·답변 오류·시간 초과·잘못된 인용·검색 오류 9건과
  원문 변경 1건을 실행한다. Core 응답과 AI 기록, 실제 trace와 Langfuse 부모·오류·캐시를 대조한다.
- 캡처 v2는 `integration-stub` 출처와 모델·프롬프트·기록기 해시, 유료 호출 0회를 보존한다.
  검색/답변 지표와 실패·미실행을 분리하며 의미 충실도 null·사람 미검토·기준 지정 불가를 유지한다.
- 원시 기록·평가 입력·보고서와 중간 실패 상태를 CI artifact로 보존한다. 기존 단일 청크 6건 추적,
  Ops 취소·Kubernetes 복구·보고서 변조 검증도 유지한다.

기존 계획의 가상 HTML 수집까지 완료한 것은 아니다. 현재 소유한 DB snapshot으로부터의 경로를 먼저
연결했으며 HTTP 다운로드·HTML 추출·첨부/PDF는 이번 G1 증거에서 제외한다. 운영 공식 URL 검증을
완화하지 않았다. 실행 명령과 산출물은 [평가 README](../evaluation/support-program-evidence/README.md)와
[통합 실행 안내](../infrastructure/llmops/README.md#실제-core-다중-청크-캡처와-오프라인-평가)에 정리했다.
다음은 새 CI 결과 확인·실패 수정 후 G2의 호출별 예산·취소다. RAG live와 정기 실행은 계속 닫아 둔다.

## 이번 후속 구현 — 전체 RAG 자료 계약·무료 평가기, 2026-09-30

`skn-72 / 7026e3a`의 고정 근거 범위 계약 다음 단계로
[전체 RAG 오프라인 평가기](../evaluation/support-program-evidence/rag_evaluate.py)를 추가했다.
원문·청크·기대 근거·검색 결과를 해시와 버전으로 고정하고, production AI 요청·응답 계약으로
공고 간 혼입·버전 불일치·잘못된 검색 순서·검색 밖 인용을 거절한다.
실제 흐름은 `고정 fixture + 저장 capture → 무결성 검증 → 검색/답변 지표 → JSON 표준 출력`이다.
새 production 의존성·서비스·실행 서버는 추가하지 않았다.
PR #157이 반영된 `origin/main / c9089ca`를 pull·rebase했으며 `skn-73`의 보고서 변조 탐지·
복구 검증과 문서를 함께 보존했다.

가상 공고 2개·수동 분할 청크 8개·질문 3개와 합성 캡처를 제공한다. 검색 성공 뒤 인용 누락,
검색 근거 누락, 원문 정보 부족을 나누어 점수 계산을 확인한다. 이 자료는 production 청킹 결과,
실제 검색·모델 응답 또는 사람이 검토한 정답이 아니다.

실패 단계·코드와 입력 trace ID를 보존하고, 미측정은 null로 남긴다. 대상 사례 수·측정 사례 수·
실패 수를 함께 제공하며 모든 질문에 기록이 있어야 한다. 저장 실행의 모델·프롬프트·실행기 버전을
현재 기본값으로 바꾸지 않는다. 의미 충실도·실제 호출 증명·운영 기준 승인은 자동 판정하지 않는다.
자료·실행 형식과 명령은 [평가 README](../evaluation/support-program-evidence/README.md)에 정리했다.

로컬 Python 3.12에서 `test_rag_evaluate.py` 69건, 합성 캡처 CLI, Ruff 검사·포맷을 확인했다.
`uv`가 PATH에 없어 기존 AI 가상환경으로 실행했다. 기존 CI의 평가 도구 전체 테스트에 새 테스트가
포함되며 이번 변경은 `skn-74`에 기록한다. 최종 커밋의 원격 전체 검증은 푸시 후 확인해야 한다.
기준 `7026e3a`는 GovBiz·Ops·Infra·Catalog CI 성공, LLMOps CI는 확인 시점에 실행 중이다.
현재 Ops·React는 고정 근거 평가만 제공하고 기존 실행 명세·모델 호출 예산도 유지한다.

다음 순서는 **실제 Core 캡처 수집 연결 → 임베딩·답변 호출별 예산/취소 → Ops의 별도 RAG 접수·검토**다.
원문·질문·근거 검토 및 전송·비용 승인 뒤 유료 평가를 활성화해야 한다.
보고서 변조 탐지·복구 검증은 아래 `skn-73` 절에 구현 내용을 보존했다. 스케줄 활성화,
runner→Kubernetes 예산 경로와 실제 운영 환경 적용 등 남은 검증은 별도다.

## 후속 구현 — 보고서 변조 탐지·복구 검증, 2026-09-30

`skn-71 / e623b35` 다음 작업으로 S3의 보고서 변조·복구 검증을 추가했다.
이번 후속 변경은 `skn-73`에 기록한다. PR #153이 반영된 `origin/main / 70c4784` 위로
리베이스하며 `skn-72`의 평가 범위 계약·운영 화면 구분과 갱신된 실행 명세를 함께 유지한다.
기존 Ops의 SHA-256 검사를 재사용하고, 임시 Kubernetes E2E의 artifact 장애 시나리오를 세 가지로 확장했다.
Prefect·실행기·결과 저장소는 Compose에 유지하며 추가 평가나 모델 호출 없이 기존 완료 실행을 사용한다.

1. 원본 보고서의 SHA-256을 확인한 뒤 보관하고, 같은 길이에서 마지막 1바이트만 바꾼 시험 사본을 만든다.
   manifest·요청·DB 기록을 변조본에 맞춰 갱신하지 않는다.
2. 실제 Ops Pod에서 결과 서버 HTTP 200과 변조 사본의 해시·바이트 수가 일치하는지 확인한다.
   파일 누락·전송 실패를 무결성 검사 성공으로 처리하지 않는다.
3. 인증된 Ops 보고서는 404, 관리자 런타임 진단은 503이며 `result_artifact`만 실패해야 한다.
   Ops 생존·DB 준비 probe와 기존 완료 상태·flow·명세·모델 호출 0회는 유지한다.
4. 확인된 시험 사본만 제거하고 원본을 복원한다. 보고서 200·원본 SHA-256·전체 진단 PASS까지 필요하다.
   검사 중 예외에도 복원을 시도하며 다른 작성자의 파일이나 손상된 백업은 덮어쓰지 않고 실패로 남긴다.

호출 흐름은 `Compose 시험 보고서 변조 → 내부 artifact HTTP 200·바이트 증거 →
Kubernetes Ops 무결성 오류 → 원본 복원 → 인증 보고서·런타임 진단 재확인`이다.
`artifact_recovery.scenarios.report_tampered`에 변조 해시·길이·차단 응답·복구 해시를 기록한다.

로컬의 격리 Linux 컨테이너에서 신규 7개를 포함한 관련 테스트 49개가 통과했다.
실제 임시 파일의 변조·복원·충돌 거절과 시나리오 판정을 검증한 결과이며 Kubernetes 전체 실행 성공의 증거는 아니다.
Infra CI의 자동 테스트 발견과 기존 필수 LLMOps `--evaluate` 단계에 포함된다.
이번 변경의 실제 클러스터 결과는 새 커밋 CI에서 확인해야 한다.

다음 구현은 runner→Kubernetes Ops 예산 경로다. 발행 이미지·Argo·백업 복원도 별도 검증이 필요하다.
아래 절은 각 시점의 구현 기록이다.

## 이번 후속 구현 — 평가 범위 계약, 2026-09-30

개발 기준은 `skn-70 / 3fca0bf`다. 해당 커밋의 실제 Core 상세 RAG CI 단계와 보존 보고서를 확인했다.
정상·캐시·모델 오류·시간 초과·잘못된 인용·검색 실패 여섯 사례, 관측 100개가 모두 통과했고 유료 호출은 없다.
기준 커밋의 GovBiz·Catalog·Ops·Infra·LLMOps CI 5개는 모두 성공했다.
이번 평가 범위 변경은 `skn-72`에 기록하며 최종 SHA의 필수 CI로 별도 검증한다.
PR #152가 반영된 `upstream/main / fde8ff2`를 pull·rebase하고, `skn-71`의 Compose 교체·
Kubernetes Ops 복구 검증과 관련 문서를 보존했다.

Ops 전체 RAG 확장의 첫 단계로 평가 범위를 접수·실행·결과·품질 정책에 연결했다.
새 명세 v2는 `evaluation_scope`를 고정하고, 실행기는 캡처·manifest·비교 보고서에 같은 범위를 남긴다.
현재 지원하는 `fixed-answer-context-only` 외의 입력·범위 혼합·새 결과의 필수 범위 누락은 거절한다.
React는 접수 전과 상세·비교 화면에서 고정 근거 답변과 검색 품질 미측정을 표시한다.
품질 판정과 기준 지정도 범위를 확인하며 과거 기록에 새 명세·승인을 소급 생성하지 않는다.

무료 검증은 평가 도구 146건, Ops DB 없는 검사 8건, Web 53건과 TypeScript·Ruff·oxlint다.
DB 없는 Ops 검사는 로컬 mysqlclient 미설치로 dummy backend를 사용했고 DB 접근은 금지했다.
MySQL 8.4의 API·검토·기준·복구 회귀와 전체 서버는 새 SHA의 CI 검증 대상으로 남긴다.
코드·실행 명세·README를 갱신했으며 기존 컨테이너 교체와 유료 모델 호출은 하지 않았다.

당시 계획한 다음 구현은 **원문·청크·검색 결과 버전 및 기대 검색 근거를 고정하는 전체 RAG 자료 계약과 무료 평가기**이며,
이번 후속 구현 현황은 문서 상단 절을 따른다.
검색 근거 재현과 답변 인용 재현을 별도로 계산하고 실패 단계·실제 trace ID를 보존해야 한다.
그 뒤 Ops 실행 경로에 임베딩·답변 호출별 예산 예약을 연결한 후 승인 범위에서 유료 평가를 활성화한다.
현재 고정 근거 fixture의 가상 자료 제한이나 호출 예산을 단순 해제하는 방식은 사용하지 않는다.

## 후속 구현 — Compose 컨테이너 교체·브리지 복구 검증, 2026-09-30

`skn-69 / 8b79d2e` 다음 작업으로 S3의 실제 Compose 컨테이너 교체 검증을 추가했다.
이번 후속 변경은 `skn-71`에 기록한다. PR #149가 반영된 `origin/main / c517396` 위로
리베이스하며 `skn-70`의 실제 Core 상세 RAG 통합 검사와 CI 연결을 함께 유지한다.
[교체 검증](../infrastructure/gitops/scripts/smoke_ops_replacement.py)을 기존 Kubernetes E2E의
artifact·Prefect·동기화 복구 뒤에 연결했다. Prefect·실행기·결과 저장소의 Compose 배치를 유지한다.

1. 시험 Prefect를 같은 이미지·볼륨으로 재생성하고 컨테이너 ID 변경을 확인한다.
2. 읽기 전용 결과 서버를 임시로 두 개 실행해 서로 다른 실제 IP를 확보한 뒤, 소유권을 확인한 이전 서버만 제거한다.
   Docker가 해제된 IP를 재사용해 주소 변경 검사가 생략되는 일을 막는다.
3. 기존 `check`가 오래된 주소를 거절하고 EndpointSlice를 수정하지 않는지 확인한다.
   명시적 `connect` 후 Service UID·ClusterIP, 내부 네트워크·kind 노드·이미지·볼륨이 보존돼야 한다.
4. 실제 Pod의 런타임 진단과 인증된 기존 보고서 SHA-256을 확인한다.
   새 무료 평가 한 건이 완료되고 Kubernetes DB·Prefect의 요청·flow·실행 명세·모델 호출 0회가 일치해야 통과한다.
   이전 두 평가의 DB 기록도 그대로 유지돼야 한다.

호출 흐름은 `Compose 서버 교체 → 오래된 경로 거절 → connect로 EndpointSlice 갱신 →
Kubernetes Ops 진단·기존 보고서 조회 → 새 무료 평가 → ops-sync·DB 대조`다.
`replacement_recovery`는 경로 복구만으로 PASS가 되지 않으며 새 평가 검증까지 성공해야 한다.
시험 자원만 교체하고 최상위 E2E의 정리·실패 처리를 유지한다.

로컬에서는 신규 11개와 기존 artifact·동기화 복구 31개, 총 42개 테스트가 격리 Linux 컨테이너에서 통과했다.
추가로 작은 임시 Compose 환경에서 대기 프로세스를 사용해 실제 Docker ID·결과 서버 IP 변경,
동일 named volume 유지와 생성 자원 정리를 확인했다. 이 검사는 실제 Prefect·Kubernetes 업무 검증을 대신하지 않는다.
전체 경로는 필수 LLMOps CI의 기존 `--evaluate`에 연결했으며 이번 변경의 새 SHA 검증은 커밋·푸시 후 필요하다.

남은 S3는 보고서 변조·복구와 runner→Kubernetes 예산 경로다.
발행 이미지·Argo·백업 복원 및 사용할 개인 환경의 활성화도 별도 완료 증거가 필요하다.
아래 절은 각 시점의 구현 기록이며 현재 범위·미검증 항목은 이 절을 우선한다.

## 후속 구현 — Prefect 장애·동기화 복구 검증, 2026-09-30

`skn-67 / ec71717` 다음 작업으로 S3의 Prefect 응답 중단과 동기화 프로세스 중단·재시작 검증을 추가했다.
기존 Kubernetes E2E에서 무료 저장 캡처 평가 한 건을 추가하며 실제 모델은 호출하지 않는다.
PR #146을 포함한 `origin/main / bdd212e` 위로 리베이스했으며 상세 RAG 추적과 갱신된 실행 명세를 유지한다.

1. 시험 Prefect 컨테이너를 일시 정지하고 새 무료 요청을 접수한다. HTTP 503, 접수 미확인과 상태 조회 오류,
   실제 60초 경과 후 `status_stale=true`를 확인한다. DB 시각이나 실행 상태를 시험 코드로 수정하지 않는다.
2. Prefect를 재개한 뒤 기존 동기화 프로세스가 다시 조회하는지 확인한다.
   새 조회 시각·접수 미확인 상태와 Prefect 실행 0건으로 자동 재접수가 없음을 검사한다.
3. 시험 Ops sync 명령을 대기 프로세스로 교체하고 Pod를 배포한다. 같은 요청 ID로 명시적 재시도와 중복 접수를 수행한다.
   Prefect의 실제 무료 평가가 완료돼도 Ops 목록의 상태·동기화 시각이 바뀌지 않고 지연 표시가 유지돼야 한다.
4. 원래 sync 명령을 복원하고 새 Pod에서 목록 조회만으로 자동 완료 반영을 기다린다.
   요청·flow·명세·모델 호출 0회·보고서를 검증하며 Prefect 실행은 정확히 한 건이어야 한다.

호출 흐름은 `Core 인증 → 웹 프록시 → Kubernetes Ops 접수 → Compose Prefect/실행기 → Kubernetes ops-sync → Ops DB`다.
상세 API·수동 동기화 명령·DB 직접 갱신으로 완료를 만들지 않는다.
Prefect 장애 중 기존 완료 보고서 조회와 Ops 생존·DB 준비 상태도 유지돼야 한다.

검증은 기존 `--evaluate`와 필수 LLMOps CI에 연결했다. 보고서의 `sync_recovery`에는 장애 상태,
자동 재접수 0건, 중단 중 DB 상태, 복구 결과·요청·flow·명세·보고서 해시를 남긴다.
임시 Compose 프로젝트·kind context·실행기 및 Prefect 소유권을 확인하고 예외 시 Prefect와 sync 설정을 복원한다.
전체 workflow 85분·Kubernetes 단계 25분 제한은 유지한다.

로컬에서는 신규 동기화 복구 테스트 15개와 기존 artifact·포트 전달 21개, 총 36개가 통과했다.
네트워크 없는 격리 Linux 컨테이너에서 예외 복원·중복/잘못된 실행 거절·기한 초과 실패와 실제 SIGTERM 종료를 확인했다.
Ruff 검사·포맷, Python·워크플로 구문·참조 경로와 `git diff --check`도 확인한다.
무료 로직·프로세스 검증을 실제 Kubernetes 장애 주입 성공으로 간주하지 않는다.

기준 커밋 `skn-67 / ec71717`의 필수 CI 5개 성공을 확인했다. 이번 후속 변경은 `skn-69`에 기록한다.
이번 변경의 실제 클러스터 검증은 새 커밋 CI에서 확인해야 한다.
남은 S3는 Compose 컨테이너 실제 교체·브리지 갱신, 보고서 변조, runner→Kubernetes 예산 연결이며,
발행 이미지·Argo·백업 복원도 별도 후속 작업이다.

## 후속 구현 — artifact 장애 복구 검증, 2026-09-30

`skn-65 / a768ef7` 다음 작업으로 S3 중 **artifact 인증 실패·보고서 누락·복구 검증**을 추가했다.
기존 `smoke_ops_bridge.py --evaluate`의 무료 평가·Pod 재시작 검증 뒤에서 같은 실행을 사용한다.
별도 평가를 접수하거나 모델을 호출하지 않는다.
이번 변경은 `skn-67`에 기록하고, PR #142를 포함한 `origin/main / 708c6d5` 위로 리베이스했다.
원격의 Core 도우미 추적·통합 검증과 기존 Kubernetes 평가 경로를 함께 유지한다.

- 임시 Ops API의 토큰 참조를 잘못된 값으로 교체해 결과 서버 401을 확인한 뒤 원래 Secret 참조로 복원한다.
- 해당 실행의 보고서만 SHA-256을 확인하고 임시 이름으로 옮겨 결과 서버 404를 확인한 뒤 되돌린다.
- 두 장애 모두 사용자 보고서 404·관리자 런타임 진단 503, Ops 생존·준비 probe 200을 요구한다.
- 복구 뒤 진단·보고서 200, 원래 보고서 해시, Kubernetes DB의 완료 상태·flow·명세·모델 호출 0회가 같아야 통과한다.
- 생성된 시험 프로젝트·클러스터·실행기 소유권이 맞을 때만 주입한다. 예외 시에도 복원을 시도하고 복원 실패를 숨기지 않는다.

호출 흐름은 `Core 로그인 → 웹 프록시 → Kubernetes Ops → Compose artifact HTTP`다.
기존 완료 이력은 보존하고, 결과를 읽을 수 없는 상태는 보고서 응답과 런타임 진단에서 구분한다.
Secret 데이터·기존 사용자 환경·실행 장부를 수정하지 않는다.

로컬의 격리 Linux 컨테이너에서 신규 장애 검증 16개와 기존 포트 전달 5개가 통과했다.
이는 무료 로직·파일 이동·복원 검증이며 실제 클러스터 장애 주입 성공의 증거는 아니다.
Infra CI의 테스트 자동 발견과 필수 LLMOps 통합 단계에 연결했으며 새 변경의 원격 검증은 커밋·푸시 후 필요하다.
기준 커밋 `a768ef7`은 Infra·Ops·GovBiz·Catalog 성공을 확인했고 LLMOps는 실행 중이다.

S3의 Prefect 장애·동기화 중단·실제 Compose 컨테이너 교체와 runner→Kubernetes 예산 경로,
S4의 발행 이미지·Argo·백업 복원은 남아 있다. 이번 두 사례만으로 S3 전체 완료를 선언하지 않는다.

## main에서 함께 반영한 skn-65 구현 — 2026-09-30

S1의 로컬 이미지 Ops 활성화와 Core·Ops 동시 웹 연결을 추가했다.
소유권·현재 브리지·DB 대상·Secret 참조를 검증하고 artifact 토큰만 추가한 뒤 migration→API+sync→진단으로 진행한다.
성공한 연결은 다음 로컬 초기화에도 유지하며 GHCR·Argo 입력을 로컬 설정으로 변경하지 않는다.

S2는 기존 무료 평가 검증을 재사용하는 `smoke_ops_bridge.py --evaluate`로 구현해 필수 LLMOps CI에 연결했다.
격리 Kubernetes Core/Ops/MySQL과 Compose 실행기를 사용하며 Compose Ops DB가 없음을 확인한다.
반복 활성화의 비밀값 보존, 관리자 인증, 중복 접수, 목록 자동 동기화, Pod 재시작 후 DB·보고서 해시 보존을 검사한다.
실행 절차와 경계는 [Ops 연결 계약](../infrastructure/gitops/docs/ops-runtime.md)을 따른다.

skn-65 구현 당시에는 아래 로컬 검증까지 확인했다. 후속 `skn-66 / 8e8592a`의 LLMOps CI에서는
격리 Kubernetes Ops 활성화·무료 평가·동기화·재시작 보존 단계까지 성공했다.
기존 체험용 Compose나 개인 kind 환경에 적용 완료했다고 판단하지 않는다.
S3 이후 장애·live 예산·GHCR/Argo·복원 작업은 남아 있다.

로컬에서는 관련 무료 테스트 74개를 통과했다. 소유권·잠금·Helm·migration 검증은 격리 Linux 컨테이너에서,
실제 Compose 병합·브리지 검사는 Windows Docker 환경에서 확인했다. 신규 Python 파일의 Ruff 검사·포맷,
워크플로 YAML·Bash 구문, 문서 경로와 `git diff --check`도 확인했다.

## 현재 판단과 확인 범위 — 2026-09-30

개발 시작 기준은 `skn-68 / 93093a37f8c67ea65551ad3a52079175b604a812`이며,
PR #144가 반영된 `upstream/main / d1b348c` 위에 상세 공고 RAG 분산 추적을 커밋·푸시했다.
그 후속으로 실제 Core HTTP→MySQL 합성 원문→AI·Qdrant→Langfuse 통합 검사 여섯 사례를 추가했다.
이번 변경은 PR #148이 반영된 `upstream/main / fb46afa`를 pull·rebase했으며,
`skn-69`의 Prefect 장애·동기화 복구 검증과 관련 문서를 함께 유지한다.
`skn-65`의 Kubernetes Ops 활성화·무료 평가 검증, `skn-67`의 artifact 장애·복구 검사,
CI의 웹 프록시 종료·85분 제한을 함께 유지한다.
기준 SHA의 GovBiz·Catalog·Ops·Infra·LLMOps CI 5개는 모두 성공했다.
이번 통합 검사 변경은 `skn-70`에 기록하며 새 전체 검증은 최종 SHA의 필수 CI 통과 후 판단한다.
이전 `skn-66 / 8e8592a`의 필수 CI 5개 성공으로 이번 변경의 검증을 대신하지 않는다.
뒤의 기록은 당시의 장애·검증 이력이다.

**실제 Core 상세 RAG CI 단계와 여섯 사례의 보고서를 확인했고 Ops 평가 범위 계약을 추가했다.
다음은 전체 RAG 자료·검색 지표 계약과 무료 평가기다. 사람의 자료·응답 검토와 현재 모델 비교 기준 확보는 병행한다.**
이미 구현된 검토·예산 보정·실패 사용량 기록을 다시 구현하지 않는다.

| 항목 | 현재 확인한 상태 | 완료 판단 |
|---|---|---|
| 기존 CI 회귀 | `93093a3`의 GovBiz·Catalog·Ops·Infra·LLMOps 모두 성공 | 새 통합 검사 변경분의 전체 CI는 커밋·푸시 후 별도 확인 |
| 개발 환경 | Ops·sync·실행기·Prefect 실행 중, migration `0015_usage_correction` 적용 | 이전 무료 replay·복구 결과 유지. 이번 조회는 집계·상태 확인 |
| 사람 검토·기준 | 자료 검토 0건, 사례 보류 1건, 전체 검토 승인 0건, 품질 `NEEDS_REVIEW` 1건, 활성 기준 0건 | 현재 모델의 검토된 비교 기준 미확보 |
| 평가 이력 | live 완료 2건, recovery 완료 2건, replay 완료 14건·실패 3건 | 과거 live 완료를 현재 모델 전체 품질 증거로 사용하지 않음 |
| 예산 적용 | 설정·예약 0건, live 비활성화 | 호출·출력 예약 기능은 구현됐지만 실제 유료 평가 통제 적용은 별도 |
| 전체 추적·평가 | 상세 공고 추적 연결에 실제 Core HTTP·MySQL·AI·Qdrant·Langfuse 검사 여섯 사례 추가 | 새 코드 CI·전체 서버 결과 확인, 회원 RAG E2E와 Ops 평가 연결은 남음 |

이전 `8edfa32` CI: [GovBiz](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36580527445),
[Catalog](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36580527441),
[Ops](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36580527440),
[Infra](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36580527498),
[LLMOps](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36580527473).
개발 환경·검토·예산의 DB 집계는 2026-09-29 기록이며 이번 작업에서 다시 조회하거나 변경하지 않았다.
기준 `8e8592a` CI: [GovBiz](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36617864693),
[Catalog](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36617864700),
[Ops](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36617864891),
[Infra](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36617864600),
[LLMOps](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36617864837).
개발 시작 기준 `93093a3` CI: [GovBiz](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36621640462),
[Catalog](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36621640364),
[Ops](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36621640474),
[Infra](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36621640359),
[LLMOps](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36621640407).

## 현재 사용 방침 — 배포 브랜치 방식 제외

개인 포크 `main`의 PR·필수 CI 갱신 조건이 Sync fork를 차단했다. 사용자 승인으로 이 두 조건을
해제하고 삭제·force-push 방지를 유지한 뒤 GitHub 동기화 API의 fast-forward 성공을 확인했다.

사용자 방침에 따라 **`deploy/fork` 배포 브랜치 방식은 사용하지 않는다.** 개인 포크의
`MSA_PROMOTION_ENABLED=false`, `MSA_RELEASE_ENABLED=true`를 확인했다.
배포 브랜치가 없거나 기존 후보 검사 조건을 충족하지 않는 것을 현재 LLMOps의 개발 장애로
분류하지 않는다. 해당 브랜치 생성·보호 규칙·후보 PR·Argo 전환은 현재 후속 작업에서 제외한다.

이를 전제로 추가했던 미커밋 배포 검사·테스트 변경은 철회했다. 이후 main에 반영된 별도 배포
브랜치·PR 자동화 제거를 이번 리베이스에 포함했다. 과거 snapshot 검증은 유지하며 현재 상태는
[배포 브랜치·PR 제거](../infrastructure/gitops/docs/deployment-candidates.md)를 따른다.
아래 이력의 배포 브랜치 도입 제안은 현재 채택한 전략이 아니다.
Sync fork 해결과 당시 기준 커밋의 CI 통과 사실은 그대로 유지한다.

## 이어서 진행할 순서

| 순서 | 작업 | 완료 조건 |
|---|---|---|
| P1 완료 | 실제 Core 검색 추적 통합 검증 | `8edfa32`의 실제 서버 CI 네 사례 통과 |
| 병행 | 사람이 검토한 현재 모델 기준 확보 | TC01~TC06 자료 검토, 예산 설정·호출 범위 승인 후 새 평가. 응답 검토와 품질 합격 후 명시적 기준 지정 |
| P2 도우미 연결 CI 완료 | Core 도우미 → AI | `8e8592a` 실제 Core 게스트 정상·오류·시간 초과 저장/재조회 성공. 회원 RAG 전체 E2E는 별도 |
| P2 상세 추적 CI 완료 | 상세 공고 RAG 연결 | `skn-68`에 기록. Core 선택 테스트와 실제 Langfuse 3건·26개 관측 통과, 해당 SHA의 필수 CI 5개 성공 |
| P2 통합 CI 완료 | 실제 Core 상세 RAG 통합 검사 | `3fca0bf` CI 보고서에서 여섯 trace·100개 관측 통과, 해당 커밋의 필수 CI 5개 성공 |
| P2 후속 로컬 구현 | Ops 평가 범위 계약 | 접수·결과·품질·화면의 범위 일치와 검색 미측정 표시. 새 변경의 MySQL·전체 CI 확인 필요 |
| P2 다음 | 전체 RAG 자료·지표·실행 연결 | 원문·청크·검색 결과·기대 근거 버전 고정, 검색과 답변 지표 분리, 실패 단계·trace 연결. 이후 임베딩·답변 예산을 연결한 뒤 live 접수 활성화 |
| 자동 실행 전 | 입력·금액·기간 예산 및 알림 | 동시 예약·기간 경계·취소·미확인 사용량 보존·중복 보정 거절을 검증. 전체 서비스 적용 범위 명시 |
| 마지막 | 정기 실행 | 검토된 자료·예산·중복 실행 방지·취소 정책을 충족한 뒤 활성화 |

현재 평가기는 가상 자료·고정 문맥 답변 중심이다. 실제 자료와 전체 RAG 평가는 출처·검토·버전 계약을
확장한 뒤 연결하며 단순히 가상 자료 제한을 제거하지 않는다. 새 유료 호출과 품질 승인을 자동으로
생성하지 않는다. 작은 데이터셋의 합격을 일반 정확도나 전체 서비스 품질로 확대 해석하지 않는다.

## 이전 구현 — 실제 Core 상세 RAG 통합 검사

기존 Catalog 격리 검증에 `--evidence-traces-output`을 추가했다. 단일 합성 원문을 소유한 임시 MySQL에
저장하고 실제 Core 공개 API를 호출한다. 원문은 공식 사이트에서 새로 수집하지 않으며 Core 컨테이너의
해당 공식 호스트를 loopback으로 제한해 캐시 회귀가 외부 요청으로 이어지지 않게 했다.
운영 코드의 공식 HTTPS 검증·공개 응답·오류 정책은 바꾸지 않았다.

정상·동일 질문 캐시·모델 오류·모델 시간 초과·잘못된 인용·검색 임베딩 실패를 검사한다.
답변 캐시는 없으므로 같은 질문의 두 번째 답변도 모델 대역 1회가 필요하며 질의 임베딩만 재사용한다.
시간 초과는 AI span에서 `timeout`, Core 공개 응답은 기존 503으로 확인한다. 사용량이 없는 응답을 확정 0으로 처리하지 않는다.
Langfuse 조회에는 Core가 생성한 trace ID를 사용하고 실패 보고서에도 본문·키·원문 예외를 저장하지 않는다.

실제 AI SDK·localhost HTTP 대역·메모리 Qdrant, 검사기와 격리 Compose 렌더링을 로컬에서 검증했다.
LLMOps CI의 기존 실제 서버 단계와 실패 산출물 보존에 연결했고 `3fca0bf`의 **JVM·MySQL·Qdrant·Langfuse
상세 RAG 통합 단계 통과**와 해당 커밋의 필수 CI 5개 성공을 확인했다.
로컬 기존 서비스의 컨테이너·볼륨·사용자 DB와 평가 승인 이력은 변경하지 않았다.
[시나리오·명령·완료 기준](../infrastructure/llmops/README.md#실제-core를-거치는-상세-rag-통합-검사)을 따른다.

## 이전 구현 — 상세 공고 RAG 추적

`SupportProgramEvidenceService → Facade → Client → AI Router → 색인·검색·답변 Service`를 연결했다.
Core는 새 `evidence.total` 아래 일곱 업무 단계를 기록하고 세 AI 호출에 각각의 부모를 전달한다.
AI는 색인 준비·임베딩·저장, 검색 준비·질의 임베딩·벡터 조회·결과 검증, 모델 응답·인용 검증을 구분한다.
원문·청킹·임베딩 캐시, 실패 단계와 사용량 미확정을 기록하며 질문·문서·답변·키·예외 본문은 수집하지 않는다.
기존 오류 상태·출력 검증·캐시·DB 정책은 유지하고 새 의존성이나 유료 호출을 추가하지 않았다.

Ops 링크는 **AI 실행 추적 ↗**로 세 기능을 안내한다. 평가 실행 명세의 소스 해시를 재생성했으며
기존 접수 이력과 품질·예산 기록은 변경하지 않았다. API와 평가 실행기의 추적 경로를 함께 회귀 검증한다.
무료 RAG smoke는 합성 Core 부모·실제 AI HTTP·메모리 Qdrant·HTTP 모델 대역으로
정상/캐시/미준비 실패 3건·26개 관측을 검사하며 기존 LLMOps CI 저장·재조회 과정에 포함한다.
세부 명령·결과·미검증 범위는 [상세 RAG 검증 안내](../infrastructure/llmops/README.md#상세-공고-rag-추적-검증)를 따른다.

후속으로 실제 Core 상세 RAG 검사 코드를 추가했으며 전체 서버 결과 확인과 Ops 검색/답변 품질 평가는 남아 있다.
사람이 검토한 현재 모델 기준이나 정기 실행 완료로 해석하지 않는다.

## 이전 구현과 검증 — 실제 Core 검색 추적

기존 `smoke.py`의 합성 Core 부모 검증에 더해, Catalog 분리 검증 도구에
`--search-traces-output` 옵션을 추가했다. 실제 Core 로그의 trace ID로 Langfuse 관측을 찾아
Core 9단계와 AI 단계의 부모 연결, 캐시 상태·호출 횟수, 503/504 오류 전달, 본문·비밀 키 미수집을
검사한다. LLMOps CI에 실행·실패 증거 업로드 단계를 연결했다.

2026-09-29 로컬 결과는 **네 trace·63개 관측 통과, 유료 API 호출 0회**다.
정상은 17개, 캐시는 14개, 모델 오류와 timeout은 각각 16개 관측이다.
기록은 Git 제외 경로 `work/core-search-traces-verified.json`에 있으며, 실행 방법과 trace ID는
[실제 Core 검색 trace 검사](../infrastructure/llmops/README.md#실제-core를-거치는-검색-trace-통합-검사)에 정리했다.

첫 실행은 메모리 부족으로 Langfuse worker가 종료돼 실패했다. worker를 복구하고 검증 컨테이너에
메모리 상한을 적용했다. 공개 프로젝트 키의 SDK 메타데이터를 비밀 키와 구분하고, 수집·색인 갱신과
one-hot 대역의 완전 동점이 캐시 검증을 흔들지 않도록 임시 자료 고정·문서별 벡터를 적용했다.
실제 서비스의 캐시 정책·모델 호출 경로는 변경하지 않았다. 실패를 성공으로 처리하지 않고 새 입력으로 재검증했다.

위 결과는 커밋 전 로컬 검증이며 이후 `8edfa32`의 필수 CI도 통과했다.
이 결과를 현재 모델 품질, 사람 검토 기준, 상세 RAG 전체 평가 완료로 해석하지 않는다.

## 이번 후속 구현 — 도우미 단계 추적

기존 LangGraph의 분류·계획·도구·답변·검증과 관심 공고 서브그래프의 검색·병렬 판단·합성·검증에
본문 없는 span을 추가했다. 모델·프롬프트·문서 구성 해시, 단계 결과와 미확정 사용량을 남긴다.
Ops의 추적 링크는 검색과 도우미를 함께 안내하며 새 평가 점수나 사람 승인 이력을 만들지 않는다.
HTTP bootstrap·직접 Service 경로와 기존 LLMOps CI smoke에 연결했다.
도우미·기존 추적 테스트 167개, 통합 smoke 1개, 실행 명세 20개, Web Ops 50개와 실제 Langfuse
저장·재조회 3건·23개 관측이 통과했다. 유료 API 호출·품질 승인·운영 컨테이너 이미지 교체는 하지 않았다.
검증 결과와 실행 범위는 [도우미 추적 안내](../infrastructure/llmops/README.md#도우미-그래프-추적-검증--2026-09-30)를 따른다.

## 이번 후속 구현 — Core 도우미 분산 연결

`AssistantMessageService → AiAssistantClient → AI Router → AssistantAgentService → LangGraph`를
같은 trace로 연결했다. Core의 `assistant.total` 아래 첫 요청·응답 검증·자료 준비·재호출·재검증을 기록한다.
검색 전용 OTLP 설정은 두 기능이 실제 공유하는 `_common/config/LlmTracingConfig`로 옮겼으며,
새 의존성·모델 호출·공개 JSON 필드는 없다. 내부 AI 헤더만 검증해 사용하고 외부 부모 ID·baggage는 채택하지 않는다.

로컬 결과는 Core 선택 **51개**, AI 추적·Router **31개**, 인프라 검사기·HTTP 대역 **56개** 통과다.
Core는 JDK 21의 `./gradlew test --tests ... --no-daemon`, Python은 PATH에 `uv`가 없어 기존 Python 3.12
가상환경의 `python -m pytest`로 실행했다. 컨테이너 기동 없는 Compose 설정 경계·Python 정적 검사도 통과했다.
SDK → localhost OpenAI HTTP 대역의 실제 통신은 정상·503·504와 사용량 누락 보존을 검증했다.
처음에는 테스트 서버 바인딩이 sandbox에서 차단됐고, 허용된 로컬 서버 실행으로 재검증했다.
Core의 개인정보 마스킹이 무작위 숫자 표식을 바꾸지 않도록 smoke 표식은 문자만으로 생성한다.

LLMOps CI에 실제 Core 게스트 세 사례의 Langfuse 저장·재조회와 실패 증거 업로드를 추가했다.
로컬에서는 이 무거운 전체 Compose 검사를 반복하지 않았다. 회원의 자료 준비·재호출은 Core Service/HTTP 대역과
기존 AI 그래프에서 각각 검증했으며, 실제 회원 RAG 전체 E2E 완료로 표시하지 않는다.
유료 호출, 사람 검토·품질 판정·비교 기준 생성, 개발 컨테이너 교체는 수행하지 않았다.
[실행 방법과 검증 범위](../infrastructure/llmops/README.md#core-도우미-분산-추적-검증)를 따른다.

<details>
<summary>2026-09-29 GitOps 분석 기록 — 당시 상태</summary>

## 최신 판단 — 2026-09-29 22:11 KST 확인

**다음 개발의 중심은 Kubernetes Ops에서 새 무료 평가를 접수하고 결과를 읽는 전체 흐름을 완성하는 것이다.**
네트워크 연결·migration·동기화 컨테이너는 구현됐지만, 활성화·웹 접속·새 평가·장애 복구의 연결 증거가 부족하다.
아래 순서가 과거 계획보다 우선한다. 문서 아래의 과거 DB 집계·CI 상태·배포 PR 설계는 현재 상태가 아니다.

| 분석 기준 | 확인 결과 |
|---|---|
| 로컬 브랜치 | `skn-62 / 0cb2997973311ee7f641c589d0b2e2763e0b2cda`; 분석 시작 시 작업 트리 깨끗함 |
| 개인 포크와 원본 main | 둘 다 `814d084fb77b8f68c751d490d1434a90f666a379`; 로컬 HEAD와 파일 내용 동일 |
| 원격 CI | 두 SHA 모두 Infra·Ops 성공, GovBiz·Catalog·LLMOps 실행 중으로 관찰. 16개 작업 전체 완료 판정은 보류 |
| 이미지 발행 | 확인한 run `36572945076`은 workflow success지만 `publish=skipped`, `state=blocked`; CI 미완료 차단 |
| main 보호 | Ruleset `24174638` 활성. 실제 규칙은 deletion·non_fast_forward 두 개. PR·required_status_checks 없음; 별도 branch protection API도 404 |
| 실행 환경 | 현재 Docker context에서는 kind 노드 1개만 실행 중. 이 체크아웃의 기본 `.local/fork/settings.json` 없음. 다른 WSL 경로·context·클러스터 내부 상태는 확인하지 않음 |
| 이번 작업 범위 | 코드·GitHub API·실행 목록의 읽기 전용 조사와 문서 갱신. 배포, 원격 규칙 변경, 유료 호출, 사람 검토 승인 없음 |

CI 상태는 위 조회 시점의 기록이다. 이후 배포 판단 시 대상 SHA와 최신 run attempt를 다시 확인한다.
같은 파일 내용이어도 병합 커밋의 CI를 이전 SHA 결과로 대체하지 않는다.

## 확인된 공백과 영향

| 우선순위 | 코드·원격 근거 | 판단 |
|---|---|---|
| P0 | main rules API에 필수 CI 규칙 없음. [발행 gate](../infrastructure/release/gate.py)는 별도로 5 workflow·16 job 검사 | 병합 차단과 이미지 발행 차단이 서로 다르다. 현재 CI 실패 병합은 원격 규칙으로 막지 않는다. 발행 가드를 우회하지 않고, 리뷰 0명 정책과 필수 CI 정책을 분리해 정리해야 한다. |
| P1 | [ops_bridge.py](../infrastructure/gitops/scripts/ops_bridge.py)는 `ops-bridge-values.json` 생성만 수행. [connected_runtime.py](../infrastructure/gitops/scripts/connected_runtime.py)는 Ops 제외 | URL·Secret·opsSync 활성화가 하나의 지원되는 실행 절차로 이어지지 않는다. 생성 파일 존재를 적용 완료로 표시하면 안 된다. |
| P1 | [fork_cluster.py](../infrastructure/gitops/scripts/fork_cluster.py)의 web은 Core 18080만 전달. [Vite](../frontend/web/vite.config.ts)는 Ops 18001 사용 | Ops 포트 전달이 별도로 없으면 화면에서 연결 실패. 기존 Compose가 18001을 점유하면 다른 Ops DB를 볼 위험이 있다. 포트 충돌과 실제 목적지를 검사해야 한다. |
| P1 | [브리지 smoke](../infrastructure/gitops/scripts/smoke_ops_bridge.py)는 `evaluation_executed=false`; [기존 LLMOps CI](../.github/workflows/llmops-ci.yml)는 실제 Core 인증과 Compose Ops 평가를 검증 | 두 검증의 통과를 Kubernetes Ops의 실제 평가 E2E 성공으로 합산할 수 없다. Kubernetes 배치에서 같은 업무 흐름의 검증이 필요하다. |
| P1 / live 전 | [Compose 실행기](../infrastructure/llmops/compose.ops.yaml)의 `LLMOPS_OPS_API_URL=http://ops-service:8000`. [BudgetClient](../evaluation/support-program-evidence/budget_client.py)는 이 주소로 claim·authorize·settle·close | 기존 주소는 Compose Ops용이다. Kubernetes DB의 예약을 처리하는 역방향 경로·토큰·실행 ID를 연결해야 한다. 무료 저장 캡처는 BudgetClient를 사용하지 않으므로 첫 무료 E2E를 이 작업에 묶어 지연시키지 않는다. 취소는 기존 Prefect 경로도 함께 검증한다. |
| P1 | 브리지 주소 갱신은 수동 connect. 동기화 컨테이너는 HTTP probe 없음; 런타임 진단은 runner 생존을 증명하지 않음 | 기존 실행별 `status_stale`·동기화 시각 표시를 활용한다. 프로세스가 살아 있으나 진척이 없는 경우와 외부 장애를 구분해 검증한다. Prefect 장애를 API liveness 실패로 연결하지 않는다. |
| P2 / Argo 전 | 공개 gitops 명령 → approved_bundle → approved_release가 여전히 `deploy/fork`를 조회 | 별도 브랜치 제거 후 새 Argo 활성화 경로는 정리되지 않았다. 과거 snapshot 조회 호환성과 신규 활성화를 분리하고, 신규 실행은 명확한 안내로 차단해야 한다. 별도 배포 브랜치·PR을 다시 만들지 않는다. |
| P2 / AI 품질 | [평가기](../evaluation/support-program-evidence/evaluate.py)는 synthetic·ai-authored·최대 3문서/12사례·고정 근거. 의미 충실도 자동 지표 없음 | 기반 기능과 현재 모델 품질 기준은 별개다. 사람 검토 기록·현재 설정의 비교 기준이 확보되기 전 자동 품질 승격을 주장하지 않는다. |

## 개발 순서와 종료 조건

| 단계 | 구현 범위 | 완료 증거 / 다음 단계 진입 조건 |
|---|---|---|
| S0: 검증 기준 확정 | 최신 main의 16개 작업·브리지 artifact 확인. 원격 규칙의 문서 불일치 정정. 권고는 리뷰 0명을 유지하면서 필수 CI를 강제하는 것; PR 강제와 별도 배포 PR은 별개의 결정 | 정확한 SHA·run attempt·job별 성공과 `ops-bridge.json`의 실제 PASS. 원격 정책을 변경한다면 변경 후 API 결과로 확인. 이번 조사에서는 규칙을 수정하지 않음 |
| S1: Ops 활성화와 웹 경로 | 기존 dev 렌더러에 검증된 Ops 연결 입력을 전달. 기존 DB·Django Secret 보존, artifact token 키만 명시적 주입. Core·Ops loopback 포트 전달과 대상 확인 | 렌더링·정책 검증 후 migration→API+sync 반영. 재실행 시 동일 결과, 잘못된 소유권·포트 충돌·누락 토큰 거부. HTTP 결과 조회·인증 성공. GHCR 경로의 추적된 입력 검증은 유지 |
| S2: 무료 Kubernetes 업무 E2E | 격리된 실제 Core·MySQL·Kubernetes Ops/API+sync와 Compose Prefect·runner·artifact 구성. 기존 ops_smoke의 인증·접수·결과 검증 재사용 | 관리자 로그인→무료 접수→Prefect 실행→Kubernetes DB 자동 완료→HTTP 보고서·비교 조회→재시작 후 보존. 모델 호출 0, 동일 request ID 중복 접수 시 flow 1개. 화면 조회가 상태 동기화를 대신하지 않아야 함 |
| S3: 장애·복구와 역방향 예산 경로 | E2E 환경에서 서비스 교체·동기화 중단·토큰 실패·결과 누락 재현. live 전에는 runner→Kubernetes Ops 예산 API를 격리된 내부 경로로 연결 | 아래 장애 표 통과. 무료 모델 HTTP 대역으로 취소·예산 소진·응답 유실·미확인 사용량 보존 검증. 임의 외부 포트 공개와 기존 장부/volume 삭제 없음 |
| S4: 배포·데이터 복구 | 지원되지 않는 신규 gitops 진입점 정리. 검증된 SHA의 Chart·values·digest를 묶어 실제 GHCR 초기화 확인. Argo 실사용 단계에서는 새 정책에 맞는 입력·동기화·되돌리기 계약 확정 | 새 환경에서 네 이미지 실제 pull·migration·업무 E2E·이전 호환 이미지 복구. Argo를 구현하면 A→B→A와 실패 차단을 별도 검증. Ops DB와 결과물 백업을 새 볼륨으로 복원해 동일 실행 조회 |
| Q: 품질 기준 / 병행 | 기존 자료·기대 답의 사람 검토와 현재 모델의 제한 평가 준비. 실제 Core 검색 추적→상세 근거 RAG 추적으로 확장 | 검토자·자료 해시·프롬프트/모델/평가기 버전·사례별 판정·기준 지정 이력. 유료 실행은 자료와 호출 예산 승인을 받은 범위만 사용 |
| S5: 평가 범위와 자동 실행 | 검색·답변·도우미 평가를 단계별로 연결하고 입력/금액/기간 예산 및 필요한 알림 마련 | 검색 지표와 답변 품질 분리, 미확인 비용 보존, 동일 버전 품질 증거 확인. 중복 일정·재시작·한도 소진 검증 이후 정기 실행 활성화 |

S1~S2는 무료 경로부터 완성한다. Q의 사람 검토 준비는 병행할 수 있다.
기존 기능을 새로 만드는 대신 이미 있는 인증, 실행 명세, 상태 동기화, 결과 검증, 취소·예산 검증을 실제 배치에 연결한다.
별도 배포 브랜치, 강제 리뷰어, 범용 오케스트레이터, Prefect의 Kubernetes 이관, HA/HPA는 이번 선행 과제가 아니다.

## 다음 구현 묶음의 구체적인 범위

첫 묶음은 **S1 + S2의 최소 성공 경로**로 제한한다.

1. 브리지 결과의 repository·state·namespace·서비스 주소를 확인한 뒤 기존 dev 렌더러에 Ops 설정을 전달한다.
   Secret 값은 Git·values·명령 인자·진단 출력에 남기지 않는다. 기존 DB·Django 키를 회전하지 않는다.
2. Core와 Ops의 웹 접근을 함께 관리하고, 사용 중인 포트를 임의로 종료하거나 기존 Compose Ops로 조용히 연결하지 않는다.
3. 기존 `ops_smoke.py`의 검증을 재사용하되 Kubernetes Ops DB가 실제 접수·상태·결과의 기준인지 증명한다.
   테스트용 관리자 생성은 격리된 DB에만 수행하며 기존 회원 DB를 사용하지 않는다.
4. 정상 접수와 동일 ID 재접수, 비관리자/CSRF 거부, 보고서 해시, API+sync 재시작 후 이력 보존을 검증한다.
5. 결과에 소스 SHA, 실제 image ID/digest, execution release 해시, request/flow ID, transport,
   단계별 PASS/FAIL, `model_api_calls=0`, 정리 결과를 기록한다. 비밀값·세션·원문은 제외한다.

예상 변경 지점은 기존 fork_cluster/connected_runtime·Ops 연결 설정·웹 실행 경로·격리 smoke와 관련 테스트다.
새 DB나 production 패키지는 필요성이 입증되기 전 추가하지 않는다.
처음부터 모든 장애·Argo·품질 자동 승격을 한 변경에 넣지 않는다.

## 통합 검증에 반드시 포함할 장애

| 상황 | 기대 결과 |
|---|---|
| Ops sync 종료·재시작 | API 조회와 무관하게 자동 동기화 재개, 동일 flow 중복 생성 없음 |
| Prefect 중단 | 상태를 성공으로 바꾸지 않고 기존 오류/지연 표시. API/DB 이력 조회 보존 |
| artifact token 불일치·결과 누락/변조 | HTTP 오류·해시 실패를 명시, 완료/정상 보고서로 표시하지 않음 |
| Compose 컨테이너 실제 재생성 | 이전 주소 감지, connect 갱신 후 새 요청과 결과 조회 복구 |
| Ops API+sync 이미지 변경 실패 | 두 이미지 함께 복구. DB migration의 하위 버전 호환성을 별도 확인 |
| 실행기 예산 주소/토큰/실행 명세 오류 | 모델 전송 전 차단. 다른 Ops DB의 예약으로 진행하지 않음 |
| 예산 승인 후 취소·응답 유실 | 추가 전송 차단, 확인된 사용량 보존, 미확인 몫을 임의 환급하지 않음 |
| DB·결과물 복원 | 새 격리 저장소에서 실행·결과 해시·검토·장부 연결 일치. 기존 볼륨 삭제 없음 |

외부 장애를 liveness로 연결해 Pod를 반복 재시작하는 설계를 피한다.
[Kubernetes probe 문서](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)처럼
생존·서비스 준비·업무 의존성 진단의 목적을 구분하고, 기존 읽기 전용 런타임 진단을 재사용한다.

## 설계 판단의 외부 근거와 검증 한계

selector 없는 Service·EndpointSlice는 클러스터 밖 서버를 연결하는 공식 지원 방식이다.
다만 대응 EndpointSlice가 자동 생성되지 않으므로 외부 IP 갱신 책임은 이 연결 도구에 있다.
현재 규모에서는 명시적 connect·check와 실패 보고를 먼저 완성한다.
[Kubernetes Service 문서](https://kubernetes.io/docs/concepts/services-networking/service/#services-without-selectors)

Argo의 자동 동기화는 GitHub CI의 성공 판정을 대신하지 않는다. 자동 동기화 중 rollback 제약도 있으므로
복구 전략은 이미지 변경뿐 아니라 Git revision·동기화 정책까지 포함해야 한다.
현재의 과거 branch 기반 진입점을 그대로 재활성화하지 않는다.
[Argo 자동 동기화 문서](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)

이번에는 분석과 문서 변경만 수행했다. 통과한 기존 테스트를 다시 실행하지 않았으며 문서 경로와 diff를 확인한다.
실제 현재 품질·로컬 DB 집계·Argo 상태·GHCR pull은 이번 조사에서 측정하지 않았다.

</details>

<details>
<summary>skn-58~60의 분석·복구·사용량 수정 기록 — 당시 상태</summary>

## 당시 판단과 확인 범위

2026-09-29 KST의 분석 대상은 `skn-58 / 762be648e5ff9333509093b60cc8b25cbb1f1874`다.
분석 시작 시 작업 트리는 깨끗했다. 코드·원격 CI·로컬 컨테이너 상태와 Ops DB의 집계를 읽고,
추가 모델 호출 없는 실행 명세 검사와 도우미 실패 로그 대역 재현을 수행했다.
최초 분석에서는 전략 문서를 정리했고, 이후 A의 테스트 경로 수정, B의 로컬 환경 복구·무료 평가,
C의 도우미 실패 사용량 기록 수정을 아래에 추가했다. 사람의 자료/응답 검토 승인, 품질 합격,
예산 설정·장부 보정은 수행하지 않았다.

**평가 운영과 비용 통제의 기반은 상당 부분 구현됐다. 현재 병목은 새 관리 기능의 부족보다
최신 코드의 검증·환경 적용, 실제 사람 검토 기준, 서비스 전체 관측과 평가의 연결이다.**
구현량을 임의의 완료율로 환산하지 않는다. 코드 구현, CI 통과, 대상 환경 적용, 품질 입증을 따로 판단한다.

이전 분석의 ‘근거 답변 두 span만 존재’, ‘예산 조회·정리·보정 미구현’, ‘skn-43 취소 테스트 기동 실패’를
현재 상태로 반복하면 안 된다. 일반 검색 분산 추적과 예산 조회·감사·C1 정리·C2 보정이 추가됐다.
skn-56의 실제 취소·정리 통합 CI도 통과했다. 반면 C2를 포함한 최신 커밋의 Ops 컨테이너 CI에는
아래에서 확인한 **새 테스트 경로 오류**가 있다.

## 기존 P0~P4의 진행 상태

| 기존 단계 | 코드 구현 | 검증·적용 및 남은 조건 |
|---|---|---|
| P0 CI 회귀 수정 | 과거 접수 프로필·취소 기동 회귀 및 C2 컨테이너 테스트 경로 수정 | C2 수정의 checkout 3개·컨테이너/MySQL 19개 로컬 검증 통과. 수정 SHA의 필수 CI 대기 |
| P1 품질 판정·평가 기준 검토 | 자료/응답 검토·판정·이력·기준 지정·철회와 오래된 합격 차단 구현 | 로컬 DB에는 자료 검토 0건, 사례 검토는 보류 1건, 판정은 검토 필요 1건. 기능과 실제 검토 완료가 다름 |
| P2 현재 모델 기준 확보 | 새 모델 평가와 검토 화면은 준비됨 | 로컬 비교 기준 0건. live 완료 2건이 있어도 사람 검토 기준이나 일반 품질 증거로 인정할 수 없음 |
| P3 누적 예산·취소 | DB 전역 호출/출력 예약·취소·조회·감사·종료 정리·서명 증거 보정 구현 | 로컬 0014~0015 적용·데이터 보존 확인. 수정 SHA 전체 CI, 입력/금액/기간 한도와 전체 서비스 비용 통제는 남음 |
| P4 정기 실행·전체 RAG 확대 | 일반 지원사업 검색의 Core→AI 분산 trace 구현 | 실제 Core 포함 검색 통합 검증, 상세 근거 RAG·LangGraph 노드 전체 추적, Ops 전체 RAG 평가·정기 실행은 남음 |

코드 근거: [평가 API](../backend/ops-service/apps/evaluations/urls.py),
[품질 정책](../backend/ops-service/apps/evaluations/quality_policy.py),
[예산](../backend/ops-service/apps/evaluations/budget.py),
[종료 정리](../backend/ops-service/apps/evaluations/budget_cleanup.py),
[사용량 보정](../backend/ops-service/apps/evaluations/usage_correction.py),
[검색 추적 범위와 검증](../infrastructure/llmops/README.md#지원사업-ai-검색-추적).

## 지금 해결해야 할 사실

### 1. 최신 CI의 컨테이너 테스트가 실패한다

2026-09-29 19:12 KST 조회에서 [Ops CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36553147937)의
`Ops checks and MySQL tests`는 성공했지만 `Ops container integration`은 실패했다.
`test_usage_correction.py:32`가 저장소 checkout 깊이인 `Path(__file__).resolve().parents[4]`로
실행기 `budget_client.py`를 읽으려 한다. 컨테이너 파일 위치 `/app/apps/evaluations/`에서는
해당 부모가 없어 `IndexError: 4`로 테스트 모듈 로딩이 중단된다. Ops 이미지는 평가 실행기 소스를
포함하지 않으므로 숫자만 바꿔서는 의존 경계 문제도 해결되지 않는다.

이 실패는 C2 보정 알고리즘 자체의 실패 증거가 아니다. 그러나 생산자·소비자 계약과 컨테이너
검증을 완료했다고 판단할 수 없다. 테스트를 삭제·skip하거나 Ops에 평가 실행 SDK를 추가해 덮지 않는다.

| 동일 SHA의 필수 CI | 19:35 KST 재조회 상태 |
|---|---|
| [GovBiz](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36553147812) | 성공 |
| [Ops](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36553147937) | 실패 — 컨테이너 테스트 경로 |
| [LLMOps](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36553147988) | 성공 — 실제 취소·프로세스 종료·예산 장부 통합 단계 실행 확인 |
| [Infra](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36553147903) | 성공 |
| [Catalog](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36553147997) | 성공 |

이는 시점 기록이다. 수정 후에는 수정 SHA의 필수 job과 C2 실제 서버 시나리오까지 다시 확인한다.

**후속 수정 — 컨테이너 테스트 경로 회귀:** 네트워크를 차단한 임시 컨테이너의 실제 `/app`
배치에서 같은 `IndexError: 4`를 재현했다. 테스트의 실행기 경로를 기존
`settings.LLMOPS_EVIDENCE_DIR / "budget_client.py"`로 변경했다. 저장소 checkout은 기본 경로를,
Compose는 기존 `/evaluation-data` 읽기 전용 마운트를 사용한다. 실제 생산자·소비자 계약 테스트를
유지하며 production 의존성·이미지 구성·실행 명세는 변경하지 않았다.

- 저장소 checkout 배치·기본 설정: DB와 네트워크 없이 서명·파일 검증 **3개 통과**.
- CI Compose와 같은 `/app` 소스 배치·`/evaluation-data` 마운트: 격리된 **MySQL 8.4에서 19개 통과**.
  동일한 3개가 포함되므로 고유 테스트 수는 19개다. 기존 이미지에 현재 소스를 읽기 전용으로 연결한
  선택 검증이며 새 이미지 전체 빌드나 전체 Compose smoke 성공으로 표현하지 않는다.
- Django `check`, `makemigrations --check --dry-run`, 변경 파일 Ruff 검사·포맷 확인 통과.
  로컬 Ruff는 설치된 Python 3.12 환경에서 `uv run --locked --no-sync`로 실행했다.
- 개발 DB·Prefect·실행기 상태는 변경하지 않았다. 수정 코드는 아직 커밋·푸시 전이므로
  **수정 SHA의 필수 CI는 대기**다. 위 표는 수정 전 `762be64`의 결과다.

### 2. 로컬 개발 환경 불일치와 복구 결과

19:05~19:07 KST의 읽기 전용 확인 결과다. 운영/스테이징 환경 상태로 확대 해석하지 않는다.

- Ops DB migration은 `0013_budget_change_audit`까지다. C1의 `0014`, C2의 `0015`는 미적용이다.
- 실행 중인 Ops 이미지에는 현재 저장소에 있는 `check_evaluation_runtime` 명령이 없다.
- Prefect 컨테이너는 `Exited (255)`이며 평가 실행기 재시작 횟수는 조회 시 655회였다.
  실행기 마지막 오류는 DNS `Name or service not known`이다. 종료된 Prefect와의 연결 설정을 함께 확인해야 한다.
- ops-sync 재시작 횟수는 297회였고 마지막 로그는 DB 연결·migration 확인 오류였다.
  로그만으로 DB 주소 오류와 스키마 불일치 중 하나로 원인을 확정하지 않는다.
- 평가 19건: live 완료 2건, recovery 완료 2건, replay 완료 12건·실패 3건.
  자료 검토 0건, 사례 검토 `DEFERRED` 1건, 품질 판정 `NEEDS_REVIEW` 1건, 지정 기준 0건이다.
- 예산 설정·예약 행은 각각 0건이다. 한도가 설정돼 실제 유료 평가를 통제 중이라고 표현하지 않는다.

UI에 과거 결과가 보이는 것과 현재 실행기가 정상 작동하는 것은 별개다.
새 기능 추가 전에 Ops·ops-sync·실행기 이미지, DB schema, 평가 자료·결과 공유 경로, Prefect를 맞춰야 한다.
진단 API의 PASS도 실행기 생존·공유 볼륨 동일성을 보장하지 않으므로 무료 replay까지 확인한다.

**후속 B — 2026-09-29 개발 환경 복구:** 위 상태를 확인한 뒤 기존 Compose에서 복구를 수행했다.
실행 중인 Ops 평가와 Prefect 미완료 작업·활성 스케줄이 모두 0건인 상태에서 시작했다.
Ops SQL·결과·Prefect 저장소를 백업하고, 별도 MySQL 8.4에 SQL을 복원해 21개 테이블의
행 수·해시 일치를 확인했다. 현재 소스로 Ops·sync·실행기를 빌드한 뒤 `migrate_deployment`로
`0014~0015`를 적용했다. 기존 20개 데이터 테이블의 모든 행을 보존했으며 신규 빈 감사 테이블
2개와 Django content type 2개·권한 8개만 추가했다.

- `.env.ops`의 live 설정을 false로 바꾸고, 모델 API 키 없는 실행기로 검증했다.
  예산·예약·정리·보정은 0건이며 사람이 지정한 비교 기준도 여전히 0건이다.
- 기존 Core 관리자 로그인으로 React Ops 접근을 확인했다. 가상 6건 재평가
  `da6c2183-e080-43de-a5ae-ebdd8d19c75c`는 완료됐고 보고서 브라우저 표시·점수 22개 재조회를 확인했다.
- E01 비교 `05f30b8d-8ced-4dfa-aa5d-4adc226f6ea1`는 완료 전에 목록으로 이동한 뒤
  ops-sync가 완료를 반영했다. 두 실행 모두 새 모델 호출은 0회다. 기존 19건에 무료 검증 2건만 추가했다.
- Ops DB·스키마 readiness와 실행 설정·완료 결과 진단은 PASS다.
  Ops·sync·실행기의 release와 실제 공유 결과 volume도 대조했다.
- 세 서비스 재시작 뒤에도 완료 결과·점수 26개가 유지됐고 요청당 Prefect 부모 실행은 1건이다.
  기존 결과 파일 123개의 해시가 백업과 일치했다. 자동 재시작 횟수도 0회로 확인했다.

재현 절차는 [LLMOps 개발 환경 복구](../infrastructure/llmops/README.md#기존-개발-환경-복구--모델-호출-없이-확인)를 따른다.
이는 로컬 환경 적용·무료 연결 검증이며 현재 모델 품질, 유료 예산 통제의 실제 적용,
Kubernetes 연결 또는 수정 SHA의 전체 CI 통과를 뜻하지 않는다.

### 3. 관측 범위와 실패 시 사용량 기록에 공백이 있다

[공유 추적기](../backend/ai-service/app/tracing.py)는 근거 답변뿐 아니라 검색 임베딩·벡터·랭킹·선택을
기록한다. 일반 검색을 처음부터 다시 구현할 필요는 없다. 다만 기존 검색 smoke는 합성 Core 부모와
모델/임베딩 대역을 사용한다. 실제 Core/MySQL/Elasticsearch를 통과하는 전체 연결 증거는 별도다.

[LangGraph 서비스](../backend/ai-service/app/assistant_agent/service.py)는 최초 분석 당시 `ainvoke`가 정상 종료해야
집계 상태를 받는다. 메모리 대역이 호출 1회·입력 100·출력 20을 상태에 반영한 뒤 timeout을 내도록
실행했을 때 최종 로그는 호출·입력·출력을 모두 0으로 기록했다. 모델/API 호출 없는 서비스 경계 재현이며
실제 OpenAI 청구 누락을 측정한 것은 아니다. 성공한 단계는 보존하고 미확인 사용량은 null/unknown으로
구분해야 한다. Ops 예산 장부의 보수적 예약 보존과 도우미 로그의 이 문제를 혼동하지 않는다.

**후속 C 일부 — 실패 사용량 기록 수정:** 요청마다 별도 숫자 집계기를 만들어 모델 호출 시작과
수신 사용량을 기록한다. 마지막 완료 노드 상태는 내부 `astream(values)`로 보존하며 공개 HTTP 응답은 유지한다.
완료 응답 뒤 오류·timeout·외부 취소가 나도 확인한 토큰 합계가 남는다. 병렬 map이 중단되거나 오류를 처리한 뒤
전체 요청이 성공해도 미확인 호출을 따로 센다. 모든 호출에서 확인하지 못한 입력/출력 합계는 `None`이며
`observed_*` 부분 합계와 `usage_unknown_calls`로 구분한다. 명시적 0과 호출 전 실패의 0은 유지한다.

실제 ChatOpenAI Responses SDK의 무료 HTTP 대역 테스트에서 **출력 스키마 검증이 callback 종료보다 먼저
실패하는 추가 누락**도 재현했다. SDK 오류에 첨부된 수신 HTTP 200 응답에서 숫자 사용량만 읽도록 보완했다.
형식 오류는 계속 오류로 반환하며 모델 재실행·업무 fallback·공급자 변경은 추가하지 않았다.
집계기는 본문·예외·자격증명을 저장하지 않는다. 상세 필드 계약은
[AI Service 사용량 로그](../backend/ai-service/README.md#도우미-도구-에이전트-langgraph)를 따른다.

로컬 검증은 `backend/ai-service`에서 `uv run --locked --extra dev python -m pytest tests/assistant_agent`로
**126개 통과**했다. 이 중 새 사용량 회귀는 20개다. 변경 Python 파일의 Ruff 검사,
`execution_spec.py`의 실행 명세 검사와 `git diff --check`도 통과했다.
새 회귀는 timeout·취소·출력 검증 실패·사용량 누락과 부분 누락·명시적 0·병렬 map·중복 집계 방지·
동시 요청 격리를 포함한다. 실제 유료 모델 호출이나 현재 모델 품질 측정은 아니다.
수정 코드는 커밋·푸시 전이며, 전체 AI 테스트·패키지 빌드·Qdrant 검증은 수정 SHA의
`ci.yml / AI Service` 결과로 별도 확인해야 한다.

상세 근거 RAG의 원문 확보→색인→검색→답변, LangGraph의 분류→계획→도구→답변→검증을
동일 trace와 부모 관계로 연결하는 작업이 남았다. 본문·기업 정보·예외 원문을 수집하지 않는 기존 경계를 유지한다.

### 4. 평가 기능에 비해 품질 증거가 적다

[Ops 자료 목록](../backend/ops-service/apps/evaluations/capture_catalog.json)은 저장 가상 TC01~TC06과
공통 E01 비교다. [평가기](../evaluation/support-program-evidence/evaluate.py)는 `synthetic`,
`ai-authored`, 최대 3문서·12사례 및 `fixed-answer-context-only`를 요구한다.
실제 자료를 쓰려면 파일만 교체하거나 제한을 삭제할 것이 아니라 출처·버전·검토·범위를 구분하는 계약이 필요하다.

자동 지표는 상태 일치와 기대 인용 recall이며 의미 충실도는 null이다. 전체 근거를 모두 인용해도
recall이 높을 수 있어 과잉 인용·조건 누락·AND/OR·예외 해석을 사람 검토로 확인해야 한다.
별도 검색/공식 RAG 도구와 과거 실행 자료는 존재하지만 현재 모델의 승인된 Ops 기준을 대신하지 못한다.

### 5. 비용·배포·개선 순환의 범위를 구분해야 한다

- 현재 장부는 **Ops live 평가의 호출 수·출력 토큰**을 제한한다. 입력 토큰·금액·기간, 임베딩·일반
  검색·도우미·직접 CLI 호출까지 통합한 전체 서비스 지출 상한은 아니다.
- C2 증거는 실행기가 관측한 응답의 HMAC 서명이다. 공급자 청구 확정이 아니다. 응답 자체가 유실되거나
  증거가 없거나 키 교체로 검증할 수 없으면 예약을 유지한다. 자동 추정 환급으로 바꾸지 않는다.
- 동일 SHA의 CI·이미지 receipt·검토 대상 배포 후보 PR 흐름은 구현돼 있다.
  [배포 후보 검증](../infrastructure/gitops/scripts/deployment.py)은 현재 Ops 품질 PASS를 모델·프롬프트·
  자료·평가기와 묶어 검사하지 않는다. PR 승인과 LLM 품질 승인도 구분한다.
- 사용자 문제 요청을 검토 가능한 회귀 사례로 전환하는 흐름과 LLM 품질/지연/비용 임계 알림은
  확인한 Ops 구현에 없다. Prefect 상태 동기화 주기는 정기 모델 평가가 아니다.

## 실행할 개발 순서와 완료 조건

아래가 현재 우선순위다. 맨 아래 과거 기록의 순서보다 이 표를 우선한다.

| 순서 | 작업 | 완료 조건 |
|---|---|---|
| **A / P0** | C2 컨테이너 테스트와 최신 CI 마무리 | 컨테이너에서도 실제 실행기-소비자 계약을 검증하는 명시적 테스트 경로 확보. 테스트 skip 없이 Ops/MySQL/컨테이너와 C1→C2 실제 서버 검증, 수정 SHA의 필수 CI 전체 성공 |
| **B / P0** | 개발 환경 정합성 복구 | 로컬 적용·무료 replay 2건 검증 완료. 기존 데이터 보존, 0015 적용, 동일 release·결과 volume, 준비 상태·보고서·점수·목록 자동 완료 확인. 전체 CI 승인은 A에서 별도 확인 |
| **Q / 병행** | 사람이 검토한 현재 모델 기준 확보 | 먼저 기존 6건의 자료·기대 답을 검토. A/B 후 승인된 자료·모델·최대 6회/회당 출력 2,000 범위의 제한 평가, 전 사례 검토·판정·명시적 기준 지정. 추가 자료·호출은 별도 범위 확정 |
| **C / P1** | LangGraph 실패 기록과 전체 요청 추적 | 실패 사용량 보존·미확인 구분은 로컬 구현·무료 회귀 검증. 전체 CI와 기존 일반 검색의 실제 Core 통합, 상세 RAG·LangGraph의 부모 연결·단계/전체 timeout·캐시·취소·관측 전송 실패 검증은 남음 |
| **D / P1** | 검색·전체 RAG·도우미 평가 연결 | 출처·검토·버전이 고정된 자료, 검색과 답변 지표 분리, 선택 근거·실패 단계·실행 trace 연결. 기존 도구를 재사용하고 Ops 장부 밖으로 유료 호출이 빠지지 않게 승인 계약 확장 |
| **E / P2** | 운영 문제를 개선·릴리스 판단에 연결 | 권한과 비식별화가 적용된 문제 사례→사람 검토→회귀 평가→동일 생성 설정의 개선 비교. 품질 증거 누락·철회·버전 불일치 시 AI 변경 승격 차단 |
| **F / 자동 실행 전** | 입력·금액·기간 예산과 필요한 운영 알림 | 적용 대상 모델/임베딩/도구와 비용 단위·가격 버전·기간 정책 확정. 동시 예약·기간 경계·미확인 이월·보정 중복 및 임계치/알림 실패 검증 |
| **G / 마지막** | 정기 실행 활성화 | 위 범위에 필요한 검증 후 일정·자료·예산 확정. 중복 tick·재시작·한도 소진·취소에도 추가 전송/밀린 작업 일괄 재생성 방지 |

Q의 자료 검토와 C의 무료 관측 개발은 금액·기간 예산 F 전체가 끝날 때까지 미룰 필요가 없다.
다만 자동 유료 실행은 G의 조건을 충족해야 한다. 작은 데이터셋의 합격은 해당 사례·정책의 회귀 기준이며
일반 정확도나 통계적으로 신뢰할 수 있는 p95·전체 검색 품질의 증거로 확대하지 않는다.

### 다음 한 번의 구현 범위

A의 테스트 경로 수정과 두 배치의 로컬 검증은 위 기록처럼 완료했다. 기존 `ops-ci.yml`은 push와
pull request에서 checkout/MySQL 테스트와 실제 `/app` Compose 테스트를 모두 실행하므로 이 검증을
유지한다. 다음 커밋·푸시 후 수정 SHA의 필수 CI 전체 성공을 확인해야 A를 완료로 판단할 수 있다.

B의 로컬 복구·기존 이력 보존·새 무료 평가 검증은 완료했다. 구버전 접수 명세와 기존 검토를
덮어쓰지 않았으며 실제 예산 한도·품질 승인·유료 실행도 생성하지 않았다. C의 첫 범위인
**LangGraph 실패 사용량 보존·미확인 구분**도 로컬에서 수정했다. 다음 연결 검증은 기존 일반 검색을
실제 Core와 무료 모델 대역으로 통과시켜 부모 trace·실패 전파를 확인하는 것이다. 이 증거를 확보한 뒤
상세 RAG·LangGraph 단계 span으로 확장한다. Q의 자료·응답 검토는 실제 사람 판단이 필요하며 이를 AI가 대신 승인하지 않는다.

## 최초 분석의 검증과 제한

- `execution_spec.py`의 쓰기 없는 검사가 `Execution release verified`로 통과했다.
- 도우미 timeout의 0 사용량 로그 문제를 메모리 graph 대역 1건으로 재현했다. 네트워크·모델 호출은 없다.
- 로컬 Ops DB에서는 migration·실행 상태·검토·기준·예산의 **집계만** 읽었다. 사용자/질문/응답 본문은 조회하지 않았다.
- 원격 로그로 최신 Ops 실패 위치를 확인했다. 과거 C1 성공과 현재 C2의 실행 중/실패 상태를 분리했다.
- 최초 분석에서는 production 코드를 수정하거나 개발 환경을 재기동하지 않았다.
  후속 개발에서 수행한 테스트 경로 수정·격리 검증은 위 A의 후속 수정 기록과 구분한다.

</details>

<details>
<summary>이전 구현·검토 기록 — 당시 상태이며 현재 우선순위는 위 표를 따름</summary>

## C2 증거 기반 사용량 보정의 구현 당시 기록

다음 개발 묶음으로 **서명된 실행기 응답 증거의 저장·미리보기·CLI 보정·감사·React 조회**를 추가했다.
모델 응답을 받은 뒤 정산 HTTP에 실패해도 기록이 남도록, 실행기가 기존 예산 인증 토큰으로
도메인을 분리한 HMAC-SHA256 사용량 증거를 먼저 저장한다. 응답 원문·질문·API 키는 포함하지 않는다.
출처는 `WORKER_RESPONSE`이며 제공자 청구 확정이나 사람 검토 품질 증거로 해석하지 않는다.

Ops는 닫힌 예약의 실행·flow·worker·명세·호출 번호·모델·상한·시간을 확인한다. 기본 미리보기 후
검토한 증거 SHA-256를 명시해야 적용하며, 원래 호출/정리 기록을 보존하고 `0015_usage_correction`에
원본 증거·보정값·사유·담당자·전후 장부를 추가한다. 출력 차액 반환과 감사는 원자적이다.
같은 요청은 원래 결과를 반환하고 중복 응답 ID·다른 요청의 동일 호출 보정·늦은 worker 정산은 거절한다.
증거 없는 호출·응답 유실·토큰 교체로 검증 불가능한 기록은 최대 예약을 유지한다.

계약과 명령은 [Ops README](../backend/ops-service/README.md#증거-기반-미확인-사용량-보정)에 있다.
로컬 선택 검증은 MySQL 8.4 환경의 Ops **55개**, React 예산 화면 **24개**,
실행기·실행 명세 **126개**, 취소/보정 도구 **51개**가 통과했다. Ops는 초기 52개 이후
C1→C2·응답 ID 중복·상한 일치 회귀 3개를 추가해 보정 19개를 재검증한 고유 건수다.
Ruff/포맷·Oxlint·TypeScript·Django 설정/migration 정합성·실행 명세·문서 경계·diff 검사도 통과했다.
C1→C2 추가 테스트의 오래된 관계 캐시를 새 DB 상태로 갱신했고, 실행기 변경에 따른 명세 해시를
재생성한 뒤 실패했던 범위를 재검증했다. 새 서버 통합의 성공으로 확대 해석하지 않는다.

커밋 준비는 C1과 Ops 환경 진단이 병합된 `main / 814c7b7`에서 `skn-58`로 진행했다.
병합된 진단 API·Compose 연결 검증을 유지하며, 해당 상태에서 격리 MySQL 환경의
`test_runtime` 11개와 실행 명세·문서 경계·diff 검사를 추가로 통과했다.

실행기 변경에 맞춰 실행 명세의 소스 해시도 갱신했다. 기존 접수 명세를 임의로 다시 쓰지 않으며,
새 이미지와 다른 명세의 실행은 기존 사전 검사에서 차단한다. 기존 개발 DB는 아직 `0013`이며
`0014~0015` 대상 환경 적용·이번 변경의 원격 필수 CI·실제 서버 확장 검증은 별도 확인 대상이다.
유료 모델 호출·실제 장부 보정·새 스케줄 활성화는 수행하지 않았다.

기준 커밋 `skn-56 / 4fc3db7`의 [GovBiz CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36550029650),
[Ops CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36550029647),
[LLMOps CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36550029718),
[Infra CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36550029643),
[Catalog CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36550029721)는 모두 성공했다.
LLMOps의 실제 취소·프로세스 종료·예산 정리 검증 단계까지 성공한 것을 확인했다.
이는 C1 커밋의 결과이며, 현재 작업 트리의 C2 변경까지 검증한 결과는 아니다.

다음 순서는 **C2의 최신 SHA CI·대상 환경 적용 → 검토된 현재 모델 기준 확보와 예산 정책 확정 →
입력/금액/기간 예산 → 정기 실행**이다. 실제 모델 평가는 사람이 검토한 자료와 명시적인 호출·출력
상한 승인 안에서 수행한다. 자동화나 사용량 추정으로 미확인 예약을 해제하지 않는다.

## 현재 구현 — 예산 조회·감사 및 Infra CI 보완

아래는 C1 구현 당시 기록이다. 이후 확인된 CI 성공과 C2 현황은 위 절을 따른다.

사용자의 추가 개발 요청으로 **C1 종료 예약 정리 CLI·감사·React 조회**를 추가했다.
기본값은 쓰기 없는 미리보기이며 명시적 `--apply`에서 Prefect 종료 증거와 고정 명세를 대조해
미승인 몫·확정 출력 차액만 정리한다. 미확인 사용량은 유지하며 실행 재개·C2 사용량 보정은 포함하지 않는다.
동일 UUID 재시도는 원래 감사 결과를 반환하고 변경과 감사는 함께 커밋/롤백한다.
계약은 [Ops README](../backend/ops-service/README.md#종료된-예약의-미사용-몫-정리)에 있다.
새 `0014_budget_cleanup`은 격리 테스트 DB에서 검증하며 기존 개발 DB에는 아직 적용하지 않았다.
실제 개발 장부 정리나 유료 호출은 수행하지 않는다. 앞선 CI 보완과 이번 C1의 최신 SHA 필수 CI가
통과하기 전에는 운영 반영 완료로 판단하지 않는다. 기존 배포 gate는 유지한다.

C1 로컬 선택 검증은 격리 MySQL 8.4의 정리·예산·조회·취소 **74개**, React **65개**,
통합 도구 무료 테스트 **45개**가 통과했다(재실행 중복 제외). 정리 19개에는 중복 요청·승인·
정산·worker close 경합, 감사 실패 rollback, 종료 근거·명세·합계 불일치 거절을 포함한다.
Ruff·포맷·Oxlint·TypeScript·Django 설정/migration 정합성·실행 명세 및 문서 경계 검사를 통과했다.
실제 Prefect를 사용하는 기존 CI 도구는 close 실패 후 정리와 settle/close 동시 실패를 포함해
12개 시나리오로 확장했다. 이 확장본의 실제 서버 실행은 아직 하지 않았으며 CI 확인 대상이다.

2026-09-29 `skn-48 / 3cc6341`의 필수 CI 5개와 실제 취소 통합 검증 단계가 모두 성공한 것을
확인했다. [LLMOps CI 결과](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36486640472)는
이전 중계기 버전의 로컬 결과와 구분한다. 예산 조회·감사는 `main / 80d55a9` 위에서 구현했고,
`skn-50 / a847718`로 푸시한 뒤 PR #110을 통해 `main / 4339f7c`에 병합됐다.

PR B 범위의 관리자 예산 조회 API·React 화면·CLI 한도 변경 감사를 구현했다.
확정 사용량·승인 후 미확인·미승인 예약·종료 전 반환 대기를 구분하고, 총계와 페이지는 같은 전역
예산 잠금 안에서 조회한다. 미설정·합계 불일치·과거 예약 기록 부재는 0으로 표시하지 않는다.
`0013_budget_change_audit`로 변경자·CLI 출처·사유·이전/새 한도·시각·요청 UUID를 보존한다.
동일 요청은 멱등이며 감사와 한도 변경은 함께 커밋/롤백한다. 변경자는 CLI 운영자의 자기 기입 값이다.

구현 계약과 적용 명령은 [Ops README](../backend/ops-service/README.md#예산-조회와-한도-변경-감사)에 있다.
선택 검증은 격리된 MySQL 8.4에서 예산·감사·취소 **55개**, React 관련 **60개**, 취소 도구의
무료 회귀 **37개**가 통과했다. Ruff·포맷·oxlint·TypeScript 및 migration 정합성 검사도 통과했다.
병합 SHA `4339f7c`의 GovBiz·Ops·LLMOps·Catalog separation CI는 성공했지만,
Infra CI는 Helm 버전 불일치로 실패했다. 따라서 필수 CI 전체 통과 상태는 아니다.
기존 개발 DB에는 `0011~0013`을 적용했고 평가 **19건 → 19건**을 확인했다.
예산·예약·감사 행은 각각 0건이며, 조회 결과는 `unconfigured`, 과거 live 예약 누락은 2건이다.
Web·Core·Ops 연결과 세 예산 조회 API의 미인증 `401`·`no-store`를 확인했다.
기존 관리자 로그인 후 실제 React 화면에서 미설정·과거 live 예약 누락 2건·빈 예약/감사 이력을
확인했다. 과거 live 상세는 사용량을 0으로 판단할 수 없다고 표시하고, replay 상세는 새 모델
예약 대상이 아니라고 표시한다. 15초 자동 갱신도 확인했다. 실제 장부가 있는 상태와 오류 표시는
앞서 수행한 자동 테스트 범위이며 이번 개발 DB의 브라우저 검증으로 주장하지 않는다.
개발 환경 적용 범위는 [실행 안내](../infrastructure/llmops/README.md#예산-조회-개발-환경-적용--2026-09-29)에 기록했다.
유료 모델 호출·실제 한도 변경·예약 환급은 실행하지 않았다.

Infra 실패는 `kubernetes-manifests` 작업이 배포 후보 테스트를 포함해 실행하면서 Helm 4.3.0을
설치하지 않은 데서 발생했다. 별도 `helm-gitops` 작업의 설치는 다른 runner 작업에 전달되지 않는다.
`main / 4339f7c` 작업 폴더에서 두 작업에 고정 Helm 설치·체크섬 검증·실행 버전 확인을 연결했다.
기존 테스트의 생략이나 버전 요구 완화는 없다. Python 3.13과 공식 체크섬으로 확인한 Helm 4.3.0에서
도구 설정 회귀 2개와 실패했던 실제 렌더링을 포함한 배포 후보 테스트 8개가 통과했다.
이 CI 보완과 C1은 `skn-56`에서 함께 관리하며, 최신 커밋 SHA의 원격 전체 검증은 별도로 확인해야 한다.

`skn-56`은 최신 `main / 17e8cc2` 위로 리베이스했다. main에 병합된 Ops 배포 migration·
스키마 준비 검사와 사이드바 변경을 유지한다. 양쪽에서 추가한 동일 Helm 설치 단계는 하나로
합치고 두 작업의 실행 버전 확인과 도구 회귀 검증을 보존했다. 종료 예약 정리 코드·테스트·
`0014_budget_cleanup`은 그대로 유지하며, 리베이스 전 `bddf2ed`의 CI 결과와 새 SHA의 검증은 구분한다.
리베이스 통합 선택 검증은 MySQL의 health·정리 29개, React 운영 50개, 고정 Helm·배포 후보·
Ops migration 14개가 통과했다. 문서 경계·실행 명세·migration 정합성과 `git diff --check`도 확인했다.

다음 순서는 아래와 같다. 기존 기능을 다시 만들지 않고 검증 증거가 준비된 범위부터 진행한다.

| 순서 | 작업 | 완료 조건 |
|---|---|---|
| 1 | 조회·감사 CI와 대상 환경 적용 | 개발 DB 0013·실제 관리자 조회 완료. 4fc3db7 필수 CI 5개 성공 확인 |
| 2 | PR C1: 종료 예약의 미사용 몫 정리 | 4fc3db7 실제 Prefect 정리·필수 CI 통과. 대상 환경 0014 적용은 남음 |
| 3 | PR C2: 증거 기반 미확인 사용량 보정 | CLI·실행기 증거·원본 보존·React 구현. 최신 SHA CI 및 대상 환경 0015 적용으로 완료 판단 |
| 병행 | 사람 검토 기준 준비 | 자료·사례를 사람이 검토; 실제 모델 평가는 승인된 자료·호출/출력 상한에서 별도 실행 |
| 후속 | 입력·금액·기간 예산, RAG 확대와 정기 실행 | 각 하위 절의 비용·품질·복구 조건 충족 후 활성화 |

## 이전 통합 검증 — skn-48 / main 626ecf6

2026-09-29 `skn-48`을 최신 `main / 626ecf6` 위로 리베이스했다. main에는 skn-45의 취소 통합
검증 수정, skn-46의 Core→AI 검색 추적, skn-47의 이미지 발행·승격 결과 기록과 쓰기 차단이
병합돼 있다. 병합된 기능을 다시 만들지 않고 남은 차이를 검증한다.

취소 테스트는 skn-45의 `docker compose exec` 기반 내부 HTTP 방식과 실패 진단을 유지한다.
skn-48의 별도 ingress는 중복되어 제외하고 Python 3.12 실행 고정, 재기동 중 비JSON 준비 응답
처리, CI 단계 20분 한도를 통합했다. 각 준비·종료 대기의 시간 초과는 계속 실패로 처리한다.
기존 `b548c3b`의 무료 36개·실제 서버 11개 통과는 리베이스 전 기록이며 최신 SHA의 CI 성공과
구별한다. 상세 명령과 검증 범위는 [실행 안내](../infrastructure/llmops/README.md#skn-48-리베이스-통합)에 있다.
리베이스 충돌 해결 후 무료 관련 회귀 **46개**와 Ruff·Compose 격리·CI YAML 검사는 통과했다.
리베이스된 최신 SHA의 실제 서버 11개 시나리오와 필수 CI 전체 결과는 별도로 확인한다.

| 순서 | 작업 | 진입·완료 조건 |
|---|---|---|
| 1 | 리베이스 통합 검증 | 내부 HTTP·격리·쿠키/CSRF·실패 진단·준비 검사 회귀, 최신 SHA의 필수 CI 5개 및 취소 시나리오 11개 통과 |
| 2A | 현재 모델 기준 확보 준비 | 사람이 기존 6건의 자료 검토. 실제 호출은 1 통과 후 자료·모델·호출/출력 상한 승인, 전 사례 검토·품질 판정·명시적 기준 지정 |
| 2B | 예산 조회 API·React 표시·한도 변경 감사 | 확정 사용량·미확인·미승인 예약·종료 전 반환 대기 구분, 합계·권한·동시 정산·감사 rollback 검증 |
| 3 | 종료 예약 정리·증거 기반 사용량 보정 | 미확인 몫 보존, 중복 반환·새 모델 전송 0회, 보정 근거와 이력 보존 |
| 4 | 실제 검색 전체 경로 추적·RAG 평가 확대 | 실제 Core부터 Langfuse까지 연결 확인, 검색과 답변 지표·대역 검증과 실제 품질 측정 구분 |
| 5 | 입력·금액·기간 예산과 정기 실행 | 예산 통제와 주기·수신 대상 승인, 중복 tick·미확인 비용·복구 확인 후 활성화 |

2A의 사람 검토는 독립적으로 준비한다. 다음 코드 구현은 1의 검증 완료 후 2B이며, 무료 검증을
현재 모델의 사람 검토 기준 확보로 표시하지 않는다. 아래는 최초 전략과 상세 완료 조건의 기록이다.

## 이전 판단과 기준 — main baae7bd

2026-09-29 KST 검토 기준은 [origin 저장소](https://github.com/ilil1/SKN34-4th-1Team)의
`main / baae7bd45298db2bd206d6d6bfdf7416bd47a53b`이다. 작업 트리는 검토 시작 시 깨끗했다.
`skn-43 / fe39c03`의 실제 취소·예산 통합 도구와 CI가 PR #88로 병합됐다. 취소 API·누적 예약·
품질 판정·발행 gate에 더해 11개 실제 서버 시나리오의 코드도 이미 있다.
최초 검토 당시 skn-43의 해당 CI는 시나리오 진입 전 실패했으며 이 영역의 코드는 기준 main과 동일했다.
따라서 새 통합 도구를 다시 만드는 대신 실패 원인과 검증 증거부터 해결하기로 했다.
이후 skn-45의 원인 수정·실제 로컬 검증 결과와 원격 CI 대기는 아래 PR A에 반영했다.

**다음 개발은 통합 CI 실패 재현·수정 → 예산 조회·한도 변경 감사 → 종료 예약 정리 → 미확인 사용량 보정 순서다.**
사람의 자료 검토는 독립적으로 준비한다. 자동 유료 실행과 실행기 증설은 비용 통제·복구·운영 검증을
충족한 뒤 시작한다. 이미 구현한 취소 API·품질 판정·기준 지정·CI 발행 차단을 다시 만들지 않는다.

이 문서는 구현 계획이다. 운영 DB 조회·수정, 유료 평가, 스케줄 활성화, 외부 알림 전송,
배포나 원격 보호 규칙 변경은 이번 전략 작성에서 실행하지 않았다.

## 확인된 기능과 남은 공백

| 영역 | 코드·증거 | 현재 판단 |
|---|---|---|
| 접수·검토·품질 판정 | [실행 명세](../backend/ops-service/apps/evaluations/execution_spec.py), [품질 판정](../backend/ops-service/apps/evaluations/quality.py), [정책](../backend/ops-service/apps/evaluations/quality_policy.py) | 버전 고정·자료/사례 검토·판정·기준 지정은 구현됐다. 현재 모델의 사람 검토 기준 확보는 별도 운영 증거가 필요하다. 이번 검토에서 운영 DB의 검토 여부는 확인하지 않았다. |
| 누적 호출·출력 예산 | [budget.py](../backend/ops-service/apps/evaluations/budget.py), [모델](../backend/ops-service/apps/evaluations/models.py) | DB 전역 예약·단일 소유권·정산·초과 차단은 구현됐다. 입력 토큰/금액/기간 한도는 없다. |
| 평가 취소 | [services.py](../backend/ops-service/apps/evaluations/services.py), [취소 테스트](../backend/ops-service/apps/evaluations/test_cancellation.py) | 요청자 권한·취소 기록·신규 승인 차단·종료 확인·환급 경합은 구현됐다. 실제 실행기 중단 11개 시나리오를 추가했으며, 아래 PR A의 최신 검증 상태를 따른다. |
| 실서버 CI | [LLMOps CI](../.github/workflows/llmops-ci.yml), [Ops smoke](../infrastructure/llmops/ops_smoke.py), [취소 smoke](../infrastructure/llmops/cancellation_smoke.py) | 저장 응답·인증·재접수·보고서·무료 복구·실행 명세 불일치 검증에 11개 취소·예산 시나리오를 연결했다. skn-43 CI의 포트 조회 실패와 후속 수정·검증 상태는 아래 PR A에서 구분한다. |
| 한도 변경·장부 조회 | [조회·감사](../backend/ops-service/apps/evaluations/budget_reporting.py), [공개 API](../backend/ops-service/apps/evaluations/urls.py), [웹 계약](../frontend/web/src/data/ops/opsApi.ts) | 후속 PR B 구현으로 관리자 읽기 API·React 표시·CLI 감사 이력을 추가했다. 새 migration 적용과 해당 변경의 필수 CI는 현재 구현 절의 상태를 따른다. |
| 미확인 예약 복구 | [worker_action/close_after_cancellation](../backend/ops-service/apps/evaluations/budget.py), [ops_flow.py](../evaluation/support-program-evidence/ops_flow.py) | claim은 실행 try/finally 앞에 있고 close 실패를 자동 재정산하지 않는다. 취소 기록 없는 FAILED/CRASHED 등은 동기화에서 예약을 정리하지 않으며 종료된 실행에는 새 취소도 거절한다. closed 예약의 늦은 settle도 거절한다. 보수적으로 한도를 유지하지만 이를 안전하게 정리하는 별도 경로가 필요하다. |
| 추적·평가 범위 | [tracing.py](../backend/ai-service/app/tracing.py), [evaluate.py](../evaluation/support-program-evidence/evaluate.py) | 기준 검토 이후 Core→AI 검색 단계·임베딩/랭킹·선택 추적과 Ops 이동 링크를 추가했다. 상세 범위·미검증 항목은 [실행 안내](../infrastructure/llmops/README.md#지원사업-ai-검색-추적)를 참조한다. 고정 근거 평가는 synthetic·ai-authored, 최대 3문서·12사례이며 자동 의미 충실도는 미측정이다. |
| 발행·승격 | [gate.py](../infrastructure/release/gate.py) | 동일 SHA의 5개 CI·필수 job 검사는 구현됐다. 현재 모델의 사람 검토 품질 증거와 배포 대상의 연결은 별도 과제다. |

미확인 예약 유지 자체를 과금 오류로 단정하지 않는다. 현재 설계는 초과 사용 방지를 우선하며,
문제는 실패 후 예약이 계속 남을 때 운영자가 원인과 정리 근거를 확인할 경로가 부족하다는 점이다.

## 즉시 적용할 완료 판단

1. **코드 완료:** API·실행기·웹 계약, migration, 변경 동작의 테스트와 문서가 함께 준비됐다.
2. **통합 검증 완료:** 해당 변경의 최신 SHA에 필수 CI 5개와 필수 하위 job이 실제 성공했다.
   대기·실행 중·실패·취소·필수 job 생략은 통과가 아니다.
3. **모델 품질 확인:** 승인된 입력·모델·예산에서 생성한 결과와 실제 사람 검토·판정 기록이 있다.
   자동 테스트와 저장 응답 재생은 이 조건을 대신하지 않는다.
4. **운영 준비 완료:** 대상 환경의 인증·백업 복원·장애 정리·롤백을 실제로 확인했다.
   workflow 전체 success만으로 이미지 발행이나 배포 성공을 선언하지 않는다.

2026-09-29 재조회에서도 원격 main은 `protected=false`, 적용 branch rules 조회는 빈 목록이었다.
코드의 발행 gate와 main 병합 제한은 별개다. 저장소 관리자는 main의 필수 검사·리뷰·우회 정책을
정하고 설정한 뒤 API로 적용 결과를 확인해야 한다. 필수 검사로 지정하기 전에 PR 경로 필터·
검사 이름·대상 SHA를 대조하고, 문서 PR에서도 필요한 검사가 생성되는지 확인한다. 필수 테스트의
생략을 집계 job 성공으로 바꾸지 않는다. 이 계획만으로 보호가 설정됐다고 보지 않는다.

## 순서·담당·진입 조건

담당은 역할이며 개인·일정은 아직 배정하지 않는다. 한 PR은 하나의 책임으로 나누고, 기간 추정보다
아래 완료 증거로 다음 단계 진입을 결정한다.

| 순서 | 우선순위·작업 | 담당 | 선행 조건 | 완료 증거 |
|---|---|---|---|---|
| 0 | P0: 기준 SHA 검증·병합 규칙 확인 | 개발·저장소 관리자 | 기준 커밋 고정 | 최신 main 필수 CI 완료, 원격 보호 규칙 적용 여부와 미적용 이유 기록 |
| 1 | P0: 취소 통합 CI 기동 실패 수정·실제 검증 | Ops·평가 실행기 | 병합된 skn-43의 실패 로그·artifact | 포트 조회 실패 재현·원인 수정, 아래 11개 시나리오와 수정 SHA의 필수 CI 통과 |
| 2 | P1: 장부 조회와 한도 변경 감사 | Ops·Web | 현재 예약 계산식·용어 확정 | 합계 불변식, 권한·페이지 조회, 변경 이력·원자성 테스트 통과 |
| 3A | P1: 종료 예약의 미사용 몫 정리 | Ops·실행기 | 1의 재현 fixture, 2의 조회·감사 | 향후 승인 차단 후 미승인 몫·확정 출력 차액 정리, 중복 요청·정산 경합·rollback 검증; 승인된 미확인 몫 유지 |
| 3B | P1: 증거가 있는 미확인 사용량 보정 | Ops·실행기 | 3A, 채택할 사용량 증거 계약 | 중복/충돌 증거·늦은 정산 검증, 원본 보존·불변 보정 이력과 잔액 일치 |
| Q | P1: 사람 검토 기준과 제한된 현재 모델 기준 | 제품·검토자·평가 담당 | 자료 검토는 즉시 준비; 새 호출은 1 통과 및 구체적 실행 승인 | 검토된 자료·전체 사례 판단·정책 판정·명시적 기준 지정, 호출/토큰/trace/보고서 대조 |
| 4 | P2: 입력·금액·기간 예산 | Ops·실행기 | 2·3, 대상 모델·통화·기간 정책 확정 | 전송 전 보수적 예약, 한도 경합·가격 변경·기간 경계·미확인 이월 검증 |
| 5 | P2: 운영 검증·품질 증거의 승격 연결 | Infra·Ops | 1~3·Q, 배포 범위 확정 | 스테이징 복원·롤백, 같은 생성/평가 계약의 유효한 품질 증거로 승격 차단 |
| 6 | 조건부: 실제 자료·전체 RAG 추적/평가 확대 | Core·AI·평가 | 실제 RAG 품질 진단이 제품 목표일 때, Q의 검토 절차 | 검색과 답변 지표 분리, 버전 고정, 한 요청의 전체 trace와 실패 위치 확인 |
| 7 | 마지막: 다중 실행기·정기 실행·알림 | Ops·Infra | 1~5, 주기·한도·대상 확정; RAG 자동화면 6도 완료 | 중복 tick·재시작·미확정 사용량·동시 실행·알림 실패를 검증한 뒤 활성화 |

Q의 사람 자료 검토는 1~3과 독립적으로 준비할 수 있다. 금액/기간 예산 4가 없더라도 명시적인
호출·출력 상한을 승인한 소규모 수동 평가는 가능하지만, 이를 금액 상한 보장이나 자동 운영으로
표현하지 않는다. 고정 근거만 배포한다면 6을 필수 의존성으로 묶지 않는다.

## 다음 구현 묶음의 구체적인 범위

### PR A — 기존 취소 통합 검증의 실패 수정

[skn-43 LLMOps CI 실패](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36467702501)의
`Verify real cancellation, process exit and budget accounting with offline model HTTP` 단계에서
`cancellation_smoke.py:100`의 `docker compose ... port cancellation-probe 8099`가 exit 1을 반환했다.
`Smoke.ready()`에서 실패했으며 보관 artifact는 `passed=false`, `failure=CalledProcessError`,
`scenarios=[]`다. 즉 **당시 CI의 시나리오 통과 건수는 0개**이며 취소 로직 자체의 결함이 입증된 것은 아니다.

최초 실패 artifact에는 subprocess의 stderr와 서비스 상태가 없어 포트 미노출·컨테이너 종료·
Compose/네트워크 동작 중 원인을 확정할 수 없었다. 아래 범위로 후속 수정을 진행했으며,
재현 결과와 검증 상태는 이 절의 구현 현황에 기록한다.

1. 실패한 서비스의 상태·건강 상태·포트 매핑과 비밀값을 제거한 stderr를 정리 전에 보존한다.
   서비스 환경변수 전체나 모델 요청 원문을 로그에 추가하지 않는다.
2. CI와 같은 Linux Docker/Compose에서 준비 단계만 먼저 재현한다. 반환 코드·빈 포트·예상 밖 주소를
   명시적 오류로 구별하고 해당 계약의 무료 테스트를 추가한다.
3. 확인한 원인만 수정한다. 외부 전송 차단과 테스트 전용 프로젝트 격리를 유지하고,
   외부 모델 연결·고정 sleep·테스트 skip으로 기동 실패를 우회하지 않는다.
4. 이후 기존 11개 시나리오 전체를 실행하고 이름 집합·중복 여부·단계별 증거까지 대조한다.
   준비 단계 성공이나 `passed` 플래그 하나만으로 완료 처리하지 않는다.

현재 `test_cancellation.py`의 MySQL 경합 테스트와 실제 Prefect·Ops·실행기 경로를 유지한다.
모델 응답과 인증 fixture만 테스트 대역이며 production에 provider 선택·fallback을 추가하지 않는다.

기존 [LLMOps CI](../.github/workflows/llmops-ci.yml)와 smoke 도구를 확장하고, 호출 승인 직전·전송 직후
등을 테스트용 동기화 지점으로 제어한다. 임의 sleep만으로 경합을 재현하지 않는다.
산출물은 실행/flow ID·단계별 상태·승인/전송/정산 횟수·예약 전후 값·종료 확인 결과의 JSON이다.
비밀값과 질문·응답 원문은 결과 로그에 넣지 않는다. 테스트는 외부 모델 API로 나갈 수 없어야 한다.

| 필수 시나리오 | 통과 조건 |
|---|---|
| 대기 중 취소 | 모델 대역 전송 0회, 실제 종료 확인, 미사용 예약 반환 |
| 첫 응답 정산 후 다음 사례 전에 취소 | 다음 승인·전송 0회, 기존 사용량 보존 |
| 승인/전송 직후 실행기 종료·응답 유실 | 미확인 호출 몫 유지, 자동 재호출 0회 |
| 취소 ACK 뒤 실행기가 아직 살아 있음 | CANCELLING 유지, 단순 HTTP 성공을 중단 완료로 판정하지 않음 |
| 완료와 취소 경합 | 실제 최종 상태 보존, 정상 close와 서버 정리 중복 환급 0회 |
| Prefect 접수/취소 응답 유실·재기동 | 같은 실행을 조회, 새로운 flow·추가 모델 호출 없음 |
| close/settle HTTP 실패 | 실패가 노출되고 예약이 보존되며 불확실 사용량을 0으로 처리하지 않음 |
| 중복 실행기 | 같은 예약을 둘이 소유하거나 같은 호출 번호를 재승인하지 못함 |

**탈락 기준:** skip, 시간 초과를 성공으로 처리, 강제로 CANCELLED를 기록해 중단을 흉내 냄,
기존 유료 호출 재시도 정책 변경. 이 PR에서 운영 스케줄·유료 평가는 활성화하지 않는다.

구현 현황: [취소 통합 도구](../infrastructure/llmops/cancellation_smoke.py)와
[테스트 실행 안내](../infrastructure/llmops/README.md#실제-취소예산-통합-검증)를 추가했다.
위 행렬을 승인 응답 유실·첫 승인 전 취소까지 포함한 11개 시나리오로 구성하고 기존 필수 LLMOps CI
job에 연결했다. 모델 응답과 Core 인증 fixture를 제외한 Ops·MySQL·Prefect·평가·Langfuse 경로를
실제로 실행한다. 병합 `baae7bd`의 CI는 시나리오 시작 전 호스트 포트 조회에서 실패했다.
후속 수정에서 내부 네트워크의 포트 게시 누락을 Docker 29.6.2로 재현하고, 공개 포트 없이 내부
HTTP를 호출하도록 바꿨다. 무료 관련 테스트 43개·Compose 격리 검사·Ruff는 통과했다.
Windows 호스트 + Docker Desktop Linux Engine 29.6.2에서 실제 11개 시나리오도 모두 통과했고
테스트 자원 정리를 확인했다. 최신 수정 SHA의 원격 필수 CI는 아직 검증 대기다.
무료 계약 테스트/설정 렌더링을 실제 통합 통과로 간주하지 않는다. PR B의 계약 설계는 독립적으로
준비할 수 있지만 유료 반복 실행·운영 준비 완료의 근거는 PR A의 완료 조건 충족 후 확보한다.

### PR B — 예산을 설명할 수 있는 운영 API·화면

구현됨: 세 GET API, React 목록·실행 상세, CLI 감사 migration을 추가했다. 적용·검증 상태는
문서 상단의 현재 구현을 따른다. 아래는 계산 계약과 완료 조건이며 예약 정리 기능은 PR C 범위다.

현재 관리자 인증을 재사용해 전체 한도·예약 유지분·확정 사용량·미확인 호출·잔여 한도와
실행별 상세를 조회한다. 취소 가능 여부와 비용 미확정 여부를 따로 표시한다.
관리자 전체 장부 조회와 요청자만 가능한 취소 권한을 혼동하지 않는다.

첫 구현은 기존 평가 목록의 예산 요약과 실행 상세의 예약 내역, 읽기 API, CLI 한도 변경 감사로
묶는다. 공개 경로 제안은 `GET /api/v1/ops/budget`, `GET /api/v1/ops/budget/reservations`,
`GET /api/v1/ops/evaluations/{id}/budget`이다. 기존 Core 관리자 인증을 사용하고 내부 실행기의
Bearer API를 브라우저에 노출하지 않는다. 한도 변경 화면·자동 환급·소유권 인계는 별도 범위다.

**중요한 계산 계약:** 현재 `settle`은 사용량만 기록하고 출력 여유를 돌려주는 시점은 `close`다.
따라서 실제 출력 합계를 `allocated_output_tokens`로 표시하면 한도를 잘못 안내한다.

| 장부 항목 | 제안하는 계산·표시 |
|---|---|
| 확정 사용량 | `settled_at`이 있는 호출의 입력/출력 합계. 입력 사용량은 참고이며 현재 한도 대상 아님 |
| 승인 후 사용량 미확인 | 미정산 승인 호출 수와 각 호출의 최대 출력 예약. 모델 전송 완료나 0원으로 표시하지 않음 |
| 아직 승인하지 않은 예약 | 열린 예약의 `max_calls - 승인 호출 수`; 출력은 이 값 × 호출당 최대 출력 |
| 종료 전 반환 대기 출력 | 열린 예약의 정산 완료 호출마다 `최대 출력 - 확정 출력` 합계 |
| 잔여 한도 | 한도에서 위 항목으로 설명한 할당량을 뺀 값. 미설정·불일치는 별도 상태로 표시 |

호출 할당량은 **정산 완료 호출 + 사용량 미확인 승인 호출 + 열린 예약의 미승인 호출**이다.
출력 할당량은 **확정 출력 + 미확인 최대 출력 + 미승인 예약 출력 + 종료 전 반환 대기 출력**이다.
예를 들어 6회×2,000을 예약하고 첫 호출이 50토큰으로 정산돼도 close 전 할당량은 12,000이다.
이 중 50은 확정, 10,000은 아직 미승인, 1,950은 종료 전 반환 대기다. 이 예시는 정책 설명이다.

- 현재 `allocated_*`에 대응하는 합계 정의를 API 계약에 먼저 적는다. 출력 토큰의 예약 유지분에는
  미승인 호출뿐 아니라 정상 종료 전 아직 반환하지 않은 출력 여유도 포함한다. 중복 합산하지 않는다.
- 모든 상태에서 `0 <= allocated <= limit`와 상세 합계 일치를 검증한다. 미확인을 0·무료로 표시하지 않는다.
- 한도 변경은 변경 주체·사유·이전/새 값·시각을 변경과 같은 transaction에 기록한다.
  기존 CLI도 같은 감사 경로를 사용하고, 사용량 초기화나 이미 할당된 값 미만으로의 축소는 거절한다.
  적용될 수 있는 기존 migration 0011/0012는 수정하지 않고 필요한 새 migration을 추가한다.
- API 인증·페이지 경계·누락된 과거 예약·동시 조회/정산·감사 기록 실패 rollback을 검증한다.
- 한 응답 안의 총계와 내역은 동일한 DB 조회 시점으로 계산하고 `as_of`를 제공한다. 페이지 합계를 전체 합계로
  표시하지 않는다. 과거 live 실행에 예약이 없으면 기록 없음으로 표시하고 사용량 0을 만들지 않는다.
- 새 감사 모델은 주체·경로(CLI)·사유·이전/새 한도·시각과 재요청 식별자를 보존한다. 기존 한도는
  migration에서 가짜 변경자/사유를 채우지 않는다. 새 한도 변경과 감사 저장을 같은 transaction으로 묶는다.
- 첫 화면에 자동 환급·강제 재시작 버튼을 넣지 않는다. 정리 계약은 PR C에서 추가한다.

호출 흐름은 `React → Ops 관리자 API → MySQL 장부/변경 이력`이다. 모델 호출은 없다.

### PR C — 종료된 예약의 안전한 정리와 사용량 보정

C1은 `cleanup_evaluation_budget`, C2는 `correct_evaluation_usage` CLI의 미리보기/명시적 적용과 감사 조회로 구현했다.
기존 취소 자동 정리는 유지하며 일반 종료 예약을 자동 정리하는 스케줄은 추가하지 않았다.
현재 완료·미검증 범위는 문서 상단을 따른다. 아래는 C1과 후속 C2의 구분 및 검증 기준이다.

구현은 C1(종료 증거에 따른 미승인 몫·확정 출력 차액 정리)과 C2(확인된 사용량의 감사 보정)로 나눈다.
C1만으로 승인 후 미확인 몫을 반환하지 않는다. C2는 위의 서명된 `WORKER_RESPONSE` 버전 1만 채택하며
증거가 없는 과거 기록을 소급 보정하지 않는다.

취소 요청 없는 FAILED/CRASHED, preflight 실패, claim 응답 유실, close 실패를 재현 대상으로 한다.
**예약 정리와 모델 실행 재개를 분리한다.** 첫 버전은 새 소유자에게 유료 실행을 넘기지 않는다.

- 종료 증거와 요청 UUID·flow ID·명세·소유자·호출 번호를 대조하고, 같은 DB 잠금 아래 향후 승인을
  닫은 뒤 미승인 몫과 이미 확인된 출력 차액만 정리한다. 상태를 모르면 유지하며 단순 시간 만료로 전액 환급하지 않는다.
- 승인 이력이 있는 미확인 호출은 최대 예약을 유지한다. 실제 사용량을 확인할 수 있을 때만
  증거 식별자/해시·담당자·사유·전후 값을 남겨 정산을 보정한다.
- closed 이후 늦은 정산은 현재 거절되므로 별도 보정 계약을 정의한다. 중복 증거는 멱등 처리하고
  충돌하는 사용량은 거절한다. 정리를 위해 reservation/call 원본을 삭제하거나 덮어쓰지 않는다.
- 정리 요청 중복, 정리와 authorize/settle 경합, 오래된 worker의 지연 요청, 감사 저장 실패 rollback,
  같은 요청 재전송을 MySQL 8.4에서 검증한다. 실제 서버 시나리오는 PR A의 fixture를 재사용한다.
- 미확인 호출이 남은 실행은 새 UUID 생성·소유권 교체로 자동 재실행하지 않는다.

완료 증거는 **추가 모델 전송 0회, 초과 승인 0회, 중복 환급 0회, 원본/보정 이력과 잔액 일치**다.

## 품질·금액·운영 확장의 기준

### Q — 실제 사람 검토 기준

기존 자료 검토·사례별 판단·품질 판정·기준 지정 화면을 사용한다. 먼저 6건의 기대 상태·인용·필수 사실·
금지 주장을 원문과 대조한다. 필요한 참조 수정은 새 버전으로 남기고 AI 작성 출처를 지우지 않는다.
그 뒤 승인된 자료·모델·프롬프트·최대 호출/출력 한도를 고정해 새 응답을 생성한다.
실패한 사례를 제외해 성공률을 높이거나 모델과 프롬프트를 동시에 바꿔 원인을 흐리지 않는다.

완료 기록은 사례 전체의 사람 판단·사유, 버전이 고정된 품질 판정, 별도의 기준 지정,
실제 호출/토큰/trace/점수/보고서 연결이다. `PASS`는 해당 고정 자료·정책 범위의 판단이다.
6건으로 일반 정확도·p95·전체 검색 품질을 보장하지 않는다. 추가 유료 호출은 그때의 실행 승인 범위를 따른다.

### 입력·금액·기간 예산

입력 상한 없이 호출·출력 토큰만으로 금액 한도를 보장할 수 없다. 대상 모델의 확인된 공식 단가와
단가 버전·통화·입력/출력 상한·예약 계산법·기간 경계를 먼저 계약으로 고정한다.
단가는 구현 시 확인하고 날짜·출처를 기록하며, 알 수 없는 모델/단가는 유료 접수를 차단한다.
금액은 float 대신 정밀한 표현을 사용하고, 검증하지 않은 캐시 할인·환율을 예약에서 선반영하지 않는다.

일별/월별 정책은 기존 누적 사용량 행을 0으로 리셋하는 방식으로 구현하지 않는다. 기간을 넘긴 실행과
늦은 정산의 귀속을 고정하고 미확인 금액을 다음 기간에도 보수적으로 고려한다.
Ops 명세·실행기 검증·웹 동의·migration·CI 양쪽 계약을 함께 갱신한다.

### 운영 검증과 품질에 근거한 승격

스테이징의 실제 프록시에서 관리자 인증·CSRF·일반 사용자 차단·로그아웃·Langfuse/Prefect 접근 제어를
확인한다. Ops DB와 결과 파일, Langfuse/Prefect 저장소의 일관된 백업을 실제 복원하고 활성 기준 자료가
보존/삭제 정책으로 먼저 사라지지 않는지 검증한다. 코드 rollback은 기존 migration·원본 이력 삭제와 구분한다.

기존 5개 CI gate는 유지한다. 생성/평가 동작이 바뀐 배포에는 유효한 품질 증거를 연결하고
누락·철회·다른 모델/프롬프트/자료/평가기·다른 범위의 근거는 승격에서 거절한다.
문서만 바뀐 SHA마다 유료 평가를 실행하지 않는다. 증거를 재사용하려면 계약 fingerprint의 호환성을
명시적으로 확인한다. 실제 발행·승격·배포 확인은 각각의 작업 결과로 판단한다.

### 자료·전체 RAG·자동화

실제 공고와 사람 작성 참조를 쓰려면 현재 synthetic/ai-authored 강제 계약을 버전 확장한다.
불필요한 인용, 조건의 AND/OR·예외·제외·근거 부족 등 검토 범주와 지표를 정하고, 자료 확대 시
[점수 등록](../evaluation/support-program-evidence/llmops.py)의 단일 100개 조회도 페이지 처리로 검증한다.

전체 RAG는 기존 [검색 평가](../evaluation/support-program-search/README.md)와 근거 답변 도구를 재사용한다.
문서 snapshot·청킹/임베딩/재정렬 버전과 검색 후보·순위·최종 인용을 고정하고,
`Core → 원문/청킹 → 색인·검색 → 답변`의 추적 문맥을 연결한다. 두 span만 허용하는 현재 export
정책도 필요한 범위만 확장한다. 검색 실패와 생성 실패, 고정 근거 점수와 전체 RAG 점수를 분리한다.

여러 호스트를 운영하기 전에는 `serve(limit=1)`과 로컬 FileLock을 전역 동시성 제한으로 취급하지 않는다.
증설이 필요해진 시점에 현재 DB 계약에 맞는 실행 수 제한·소유권 만료·늦은 요청 차단을 검증한다.
정기 실행은 중복 tick·재시작·한도 소진·미확인 사용량 때문에 중단된 실행을 몰아서 유료 재생성하지 않는다.
알림은 승인된 수신 대상과 실패 재처리를 먼저 정하며, 모든 push의 자동 유료 평가나 자동 기준 승격은 넣지 않는다.

## 범위와 검증 원칙

- 새로운 provider, 범용 Agent 프레임워크, Airflow/Celery, 평가 SDK의 Ops API 유입은 계획에 없다.
- 새 production 의존성·외부 서비스가 필요해지면 해당 변경의 책임과 이유를 먼저 알린다.
- 현재 실패한 실제 서버 검증을 먼저 수정하고, 실패 재현 없이 예산·취소 구조 전체를 다시 쓰지 않는다.
- 로컬은 변경한 기능의 무료 테스트·정적 검사만 실행한다. MySQL 경합과 전체 빌드·컨테이너는 CI에서
  검증하며 같은 코드를 커밋·설명만 바뀌었다고 반복 테스트하지 않는다.
- 모든 PR은 기준 SHA, 문제 재현, API/상태/장부 불변식, migration 영향, 로컬 결과, 최신 SHA의 CI 링크,
  미검증 범위, 배포/복구 절차를 남긴다. 유료·운영 검증 대기를 코드/CI 완료와 섞지 않는다.
- 작업량이 커지면 범위를 나누되 사용자 동작·예산 안전성에 필요한 생산자/소비자 변경과 테스트를 분리 배포하지 않는다.

## 현재 검토의 증거와 한계 — baae7bd

2026-09-29 04:02 KST 조회 기준이다. 이 표는 시간에 따른 실행 기록이며 최종 결과를 추정하지 않는다.

| 필수 CI | main / baae7bd |
|---|---|
| GovBiz | [실행 중](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36468708560) |
| Ops | [성공](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36468708516) |
| LLMOps | [실행 중](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36468708595) |
| Catalog | [실행 중](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36468708650) |
| Infra | [성공](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36468708423) |

- skn-43의 [실패 실행](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36467702501) 로그와
  `llmops-cancellation-fe39c03b8a00d211fa9a8a0498d95d36415cfbf8` artifact를 확인했다.
  포트 조회 exit 1·완료 시나리오 0건을 확인했으며 컨테이너 실패의 근본 원인은 아직 미확정이다.
- `git diff fe39c03 HEAD -- infrastructure/llmops .github/workflows/llmops-ci.yml backend/ops-service evaluation/support-program-evidence`
  는 비어 있다. 병합 전 실패 코드가 현재 main에도 있다는 근거이며 main의 동일 실패를 미리 확정하는 뜻은 아니다.
- 현재 main의 [이미지 후보 실행](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36468777870)은
  `gate=success`, `publish=skipped`였다. workflow success를 이미지 발행 완료로 해석하지 않는다.
- 원격 main의 `protected=false`·적용 rules 빈 목록을 확인했다. 이번 작업에서 보호 규칙을 변경하지 않았다.
- 이번 전략에서는 운영 DB·현재 실제 검토 이력·예산을 조회하거나 수정하지 않았다. 과거 UI 확인 결과로
  오늘의 모델 품질 기준 확보 여부를 단정하지 않는다. 로컬 컨테이너나 유료 평가도 실행하지 않았다.
- 변경은 이 전략과 문서 진입 링크뿐이다. 문서 경로·링크와 `git diff --check`를 확인하며
  애플리케이션 테스트는 반복하지 않는다. 문서 변경은 사용자 요청에 따라 `skn-44`에서 관리한다.

## 이전 검토 기록 — 9a72f77

`skn-40 / 86ccb76`의 [Ops CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36458646801)는
MySQL 8.4에서 132개 테스트와 Ops 컨테이너 검증을 통과했다. 기존 58개 로컬 선택 테스트에 대한
원격 보강 증거이며 실제 Prefect 취소 시나리오의 통과 증거는 아니다.
최신 main의 CI는 별도 SHA로 확인한다. 이 문서 작성으로 유료 평가·모델 품질·운영 배포가 완료되지 않는다.

2026-09-29 02:47 KST 조회 기록은 다음과 같다. skn-40은 필수 하위 job도 모두 success임을 확인했다.
main의 진행 중 상태는 통과로 간주하지 않는다.

| 필수 CI | skn-40 / 86ccb76 | main / 9a72f77 |
|---|---|---|
| GovBiz | [성공](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36458646502) | [실행 중](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36459600542) |
| Ops | [성공](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36458646801) | [성공](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36459600547) |
| LLMOps | [성공](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36458646687) | [성공](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36459600496) |
| Catalog | [성공](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36458646769) | [실행 중](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36459600495) |
| Infra | [성공](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36458646407) | [성공](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36459600504) |

조회한 [이미지 후보 실행 36459718400](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/36459718400)은
workflow success지만 `publish` job은 skipped였다. 이미지 발행·승격·클러스터 배포 성공으로 보고하지 않는다.
원격 API의 PR 번호 조회는 404였으므로 병합 포함 여부는 Git 커밋 ancestry와 코드 diff를 근거로 확인했다.

당시 변경은 문서 3개뿐이었다. 코드·실행 설정·의존성은 변경하지 않았고 애플리케이션 테스트를 반복하지 않았다.

</details>
