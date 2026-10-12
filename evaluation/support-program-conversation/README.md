# AI 대화 검색 조건 해석 평가 세트 (v2)

[문서 목록](../../docs/README.md) · [C02 대화 조건 계약](../../docs/conversation-condition-update.md) ·
[AI Service 개발](../../backend/ai-service/README.md)

AI 대화 검색의 조건 해석(`POST /internal/v1/support-program-conversation/interpret`)이 사용자 메시지와 작은 대화
상태로 상태(`READY`·`CLARIFICATION_REQUIRED`·`ANSWERED`), 조건 변경(`updates`), 확인 질문·안내 종류를 고르는
동작을 재는 평가 세트와 무료 검증 도구다. 검색 결과 품질은 [검색 평가](../support-program-search/README.md)가 다룬다.

- **기대 라벨은 AI(Claude)가 현재 프롬프트·스키마를 기준으로 작성한 기대 동작이다. 사람이 검토한 정답이 아니다**
  (`labelSource: ai-authored-expected-behaviour`, `humanReviewed: false`).
- 운영 모델 대신 Claude가 같은 입력에 답한 실행은 **Claude 대리 검증**이다. OpenAI 운영 모델의 측정이 아니며 이
  도구는 유료 API를 호출하지 않는다. 실제 OpenAI 평가는 사용자가 승인한 전송 자료·예산으로 따로 수행한다.
- 직전 결과(`lastResults`)의 공고 번호·제목은 가상 자료다(`dataType: synthetic`).

## 구성

| 파일 | 내용 |
|---|---|
| `cases.json` | 단일 턴 188문항, 여러 턴 25시나리오 76턴(전체 264개 채점 단위)과 기대 라벨 |
| `validate_cases.py` | 형식·일관성 검사와 라벨 의미·채점 규칙(judge). 모델을 부르지 않음 |
| `export_proxy_inputs.py` | 모델이 실제로 받는 입력을 `proxy/`로 내보냄(기대 라벨 없음) |
| `proxy/` | `INSTRUCTIONS.md`(대리 모델 지침), `system-instructions.txt`, `response-format.json`, `inputs.jsonl`, `manifest.json` |
| `replay.py` | `runs/<run>/outputs.jsonl`을 실제 AI Service HTTP 경로로 재생·채점 |
| `runs/example/` | 도구 테스트용 손 작성 출력 3건(측정 결과 아님) |
| `runs/claude-proxy-*/` | Claude 대리 검증 실행(Haiku `v1`, Sonnet `sonnet-v1`·`sonnet-v2`). 각 폴더 README에 방법·비교 |
| `test_*.py` | 도구 테스트(모델·네트워크 없음) |

## 문항 구성

단일 턴 범주와 최소 문항 수는 설계 문서의 평가 계획을 따른다(후속 수정은 v2에서 추가). 검사기가 최소 수를 강제한다.

| 범주 | 키 | 최소 | 문항 |
|---|---|---:|---:|
| 지역(복수·권역·시군구·공고 지역 충돌·영문) | `region` | 12 | 18 |
| 업종(구어·실제 업종 vs 찾는 분야) | `industry` | 8 | 12 |
| 업력(상대 업력·두 자리 연도·점 날짜·완전 날짜) | `establishment` | 10 | 16 |
| 대상·청년(예비창업·여성·장애인·사회적기업) | `target` | 10 | 12 |
| 규모·금액 | `scale_amount` | 6 | 8 |
| 지원 분야 | `support_field` | 10 | 14 |
| 마감·접수 상태 | `deadline` | 6 | 11 |
| 약어·오타·영어 | `alias_typo_english` | 10 | 13 |
| 제외·여러 의도 | `exclusion_multi_intent` | 8 | 14 |
| 모호·회사 기반 | `ambiguous_company` | 6 | 11 |
| 비검색·주입·개인정보 | `non_search_injection` | 8 | 17 |
| 결과 참조 | `result_reference` | 4 | 15 |
| 후속 수정 | `followup_edit` | 6 | 12 |
| 기타·표현 다양성(의미 없는 입력 포함) | `other` | 10 | 15 |

설계 문서가 지목한 약점 문장(`부산에서 하는 수출 지원`, `서울 AI 창업지원`, `이번 주 마감하는 자금 지원`,
`상시 접수만`, 두 번 묻는 `서울 지원사업`, `예비창업자인데 청년 대상 거 있어?`, `직원 5명 소상공인`, `교육 말고 자금`,
`컨설팅 빼고`, `7년차예요`·`21년 설립`·`2021.3.15`, `두 번째 거 자세히`·`더 보여줘`·`예비창업자도 신청 돼?`,
`중기부 알앤디`·`코트라 해외진출`, 0건 뒤 `왜 못 찾아?`, 잡담·사용법·주입·개인정보)은 `known-weak:*` 태그로
모두 포함한다. 반말·존댓말·짧은 키워드·긴 문장·오타·띄어쓰기 없음·영어 혼용·이모지·숫자 표기는 `style:*` 태그로
각각 3개 이상이다.

여러 턴 시나리오는 이전 턴의 **기대 출력**이 만든 상태를 다음 요청에 싣는다(teacher forcing). 전이는 웹
`chatSlice`와 같다. READY는 `pendingProposal`, CLARIFICATION_REQUIRED는 Service가 정한 질문과 초안을
`pendingClarification`에 두고, ANSWERED는 상태를 바꾸지 않는다. 턴의 `after.action`이 `confirmAndSearch`면 제안을
확정해 `lastSearch`(`resultCount`)와 화면 결과를 남기고, `cancel`이면 제안·질문을 지운다. 검사기는 다음 턴 요청이
이 전이와 정확히 같은지 확인한다. 따라서 턴별 채점이며 앞 턴 오류가 뒤로 번지는 영향은 재지 않는다.

## 라벨 형식

- `request`: Core가 AI Service에 보내는 실제 요청 그대로다(`schemaVersion`, `referenceDate`, `message`, `context`,
  `pendingClarification`, `pendingProposal`, `lastSearch`; 미입력 null, `foundedYear`는 값이 있을 때만).
  검사기는 AI Service 요청 모델로 검증하고 Core 직렬화 모양과 같은지 확인한다. 기준일은 `2026-10-08`이다.
- `expected`: 현재 계약에서 가장 맞는 출력이다.
  - `status`, `updates`(모델 출력과 같은 모양의 기준 변경. 각 `evidence`는 메시지의 연속 부분 문자열),
    `answerKind`·`clarificationKind`(허용 코드 목록).
  - `match`: 자유 문장 필드의 허용 범위. `includes`는 낱말 묶음 목록(묶음마다 하나 이상 포함), `excludes`는 넣으면
    안 되는 낱말, `anyOf`는 허용 값 목록이다. 공백·대소문자·NFKC 차이는 무시한다.
  - `optional`: 기대하지 않았지만 허용하는 변경(예: 찾는 분야로 업종을 추정하지 않아도 되는 문항의 업종).
- `alternatives`: 프롬프트상 둘 다 타당한 경우의 허용 대안(예: 권역을 지역으로 둠 또는 하나로 묻기).
- `mustNot`: `unchanged`(보호 필드, 예: 회사 소재지), `notContains`(병합 뒤 값에 넣으면 안 되는 문구),
  `noEcho`(개인정보를 값·근거에 복사 금지).
- 라우팅 기대값: `route`(`pipeline`, `clarify`, `answer`, `result_question`, `compare`, `more_results`,
  `multi_intent`, `zero_result_help`)와 `routeAlternatives`, 결과 질문·비교의 대상 번호 `targetIndexes`,
  여러 의도의 감지 의도 `intents`(최대 2개, `label`·`keywords`). 해석 호출이 경로를 정하고 Core가 정해진 처리로
  보내는 설계를 기준으로 하며, 도구 호출 순서·횟수 같은 구현 의존 값은 넣지 않는다. 현재 출력에는 route가 없으므로
  재생 보고서는 상태로 추정한 경로 일치율만 낸다.
- `lastResults`: 결과가 있는 `lastSearch`에서 화면에 보인 앞 5건(`rank`와 Core `SupportProgramResponse`의
  `id`·`sourceCode`·`sourceName`·`title`·`organization`·`status`·`applicationEndDate`). 현재 AI 요청 계약에는
  실리지 않으므로 대리 모델 입력에도 없다.
- `userGoal`(시나리오): τ-bench처럼 Claude가 사용자 역할을 할 때 쓰는 목표다. `persona`, 숨은 회사 조건
  `hiddenCompany`, 찾는 것 `seeking`, 거절할 제안 `rejectProposals`, 종료 조건 `successWhen`, `maxTurns`.
  현재 도구는 이를 실행하지 않으며 이후 사용자 시뮬레이터 재생에 쓴다.
- `v2-gap:<주제>`: 현재 스키마로 표현할 수 없는 의도다(공고 지역, 대상, 규모·금액, 마감 기간, 제외, 여러 목적,
  업력 조건, 결과 참조·비교, 0건 도움 등). 라벨은 가장 가까운 현재 동작이며 이후 버전의 개선 폭을 재는 기준이다.

## 실행

AI Service 개발 환경에서 실행한다. 외부·유료 API와 DB를 쓰지 않는다. Windows에서는 `PYTHONUTF8=1`을 둔다.

```bash
cd backend/ai-service
uv run --locked --extra dev python ../../evaluation/support-program-conversation/validate_cases.py
uv run --locked --extra dev python ../../evaluation/support-program-conversation/export_proxy_inputs.py --check
uv run --locked --extra dev python -m pytest ../../evaluation/support-program-conversation
```

`cases.json`·프롬프트·출력 스키마를 바꾸면 `export_proxy_inputs.py`(옵션 없이)로 `proxy/`를 다시 쓴다.
테스트가 커밋된 `proxy/`와 Core 재생 고정 자료가 최신인지 확인한다. CI의 AI Service 작업도 같은 pytest를 실행한다.

## Claude 대리 검증 절차

1. 대리 모델 역할의 Claude는 `proxy/INSTRUCTIONS.md`와 같은 폴더의 `system-instructions.txt`·`response-format.json`·
   `inputs.jsonl`만 읽고 `runs/claude-proxy-v1/outputs.jsonl`에 줄마다 `{"caseId", "turn", "output"}`을 쓴다.
   `cases.json`, 이 README, 도구 코드, 다른 실행 결과는 보지 않는다.
2. 운영자는 `proxy/manifest.json`을 `runs/claude-proxy-v1/inputs-manifest.json`으로 복사한다(입력 지문 확인용).
3. 재생·채점:

   ```bash
   cd backend/ai-service
   uv run --locked --extra dev python ../../evaluation/support-program-conversation/replay.py --run claude-proxy-v1
   ```

4. `runs/claude-proxy-v1/`에 `report.md`(사람용), `metrics.json`, `ai-responses.jsonl`(Core가 받는 HTTP 상태·본문)이
   생긴다. 보고서는 Claude 대리 검증 결과이며 OpenAI 운영 모델 품질이나 사람 검토 정답으로 쓰지 않는다.

## 채점 방법

`replay.py`는 출력을 `FastAPI 라우터 → SupportProgramConversationService → SupportProgramConversationAgent →
LangChain·OpenAI SDK` 경로로 보낸다. 모델의 HTTP 응답만 출력 문자열로 바꾸므로 strict JSON 파싱, 출력 모델 검증,
인용·병합·READY 검증을 운영과 똑같이 통과해야 한다. 거부된 출력은 503으로 기록하고 실패로 센다. 출력이 없거나
줄이 잘못되었거나 같은 id가 두 번 나오면 그 문항은 출력 없음으로 채점한다.

수락된 출력은 실제 Service 병합 결과를 병합 기준(질문 초안 → 미확정 제안 → 확정 조건)과 비교해 바뀐 필드를 구한다.
시·도 표기만 다른 지역(`서울특별시`↔`서울`)과 공백·대소문자만 다른 문장은 변경으로 보지 않는다(Core 지역 사전의
시·도 별칭만 옮긴 채점용 정규화). 시·군·구까지의 Core 표기 유지 규칙은 Core 재생 테스트가 확인한다.

| 지표 | 정의 |
|---|---|
| 상태 정확도 | 고른 기대(기본 또는 허용 대안)와 상태가 같은 비율 |
| 사례 통과율 | 상태·종류·필드 변경·금지 규칙이 모두 맞은 비율 |
| READY 정확한 제안 일치율 | 기본 기대가 READY인 문항의 통과율 |
| 필드 정밀도·재현율·F1 | 바뀐 필드 단위. 값이 틀리면 FN과 FP, 기대에 없는 변경은 FP(허용 optional 제외) |
| 확인 질문·안내 종류 정확도 | 기대가 확인 질문·안내인 문항에서 종류까지 맞은 비율 |
| 잘못된 변경률 | 수락된 출력의 금지 규칙 위반 수 / 검사 수. 회사 소재지 보호 위반은 따로 센다 |
| 검증기 거부율 | 출력이 있는 문항 중 AI Service가 거부한 비율 |
| 현재 구조 경로 일치율 | READY→pipeline, CLARIFICATION_REQUIRED→clarify, ANSWERED→answer로 추정한 경로가 기대 경로와 같은 비율 |

보고서는 범주·경로·`v2-gap`·`known-weak`·`style`별 표, 시나리오별 통과 턴, 실패 목록과 이유를 함께 낸다.

## Core 재생 테스트

`backend/core-service/src/test/resources/support-program-conversation/example-ai-responses.json`은 `runs/example`을
재생한 AI Service 응답이다. `SupportProgramConversationEvaluationReplayTest`가 실제 Client·Service에 넣어 Core가 보내는
요청이 기록과 같은지, 표기만 다른 지역을 바꾸지 않는지, 확인 질문 종류를 전달하는지, AI Service 거부를
`AI_SERVICE_UNAVAILABLE`로 드러내는지 확인한다. 예시 출력을 바꾸면 다음 명령으로 다시 만든다.

```bash
cd backend/ai-service
uv run --locked --extra dev python ../../evaluation/support-program-conversation/replay.py --run example \
  --out-dir <임시 폴더> --core-fixture ../core-service/src/test/resources/support-program-conversation/example-ai-responses.json
```

## 한계

- 라벨은 AI가 쓴 기대 동작이다. 사람 검토 전에는 정답 기준이나 합격선으로 쓰지 않는다.
- 대리 모델의 점수는 OpenAI 운영 모델의 점수와 다를 수 있다. 프롬프트 개선 방향을 고르는 무료 신호로만 쓴다.
- 턴별 채점이므로 대화 전체의 오류 누적, 사용자 시뮬레이터 대화, 실제 검색·랭킹 결과는 재지 않는다.
- route·targetIndexes·intents는 현재 출력으로 측정할 수 없어 라벨만 둔다.
