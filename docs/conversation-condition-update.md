# C02 — 후속 대화의 조건 변경 제안과 확인 검색

[개발 전략](development-strategy-20260907.md) · [C01](company-conditions-search.md) · [검색 계약](support-program-search-contract.md)

기준일: 2026-09-07. C02 최초 구현의 시작 커밋 `f5da456`, 작업 브랜치 `skn-35`.
사용자 흐름은 후속 UI 간소화를 반영한 현재 계약이며, 아래 검증 기록은 C02 최초 구현 당시의
자동 테스트·가상 브라우저·실제 모델 검증을 구분해 보존한다.

## 등록 기업 기본 조건과 설립연도

새 대화에서 등록 기업의 소재지·업종·설립연도를 기본 조건으로 읽습니다. 이후 대화에서 바꾸거나 지운 값은 유지하며,
대화 기록 복원 시 현재 프로필을 다시 합치지 않습니다. 회사 조회 실패는 조건 없는 검색으로 대체하지 않습니다.
companyConditions의 선택 정수 foundedYear는 설립연도만 알 때 사용하며 정확한 establishedOn과 동시에 지정하지 않습니다.
FOUNDED_YEAR SET은 현재 발화의 네 자리 연도(또는 연도+년) 인용이 필요합니다. 둘 중 하나를 변경·해제하면
기존의 다른 정밀도 값은 제거합니다. updates 상한은 7개입니다. 이전 네 조건만 담은 기록·요청도 계속 지원합니다.

## 사용자 흐름과 범위

새 메시지를 확정 검색 의도·조건, 직전 미확정 제안 또는 질문, 최근 완료 검색 요약과 함께 해석한다.
조건 변경에는 변경안을, 검색 결과에 대한 질문에는 설명을 보여준다. 사용자가 `이 조건으로 검색`을 눌러야
적용 조건을 바꾸고 기존 POST 검색을 실행한다. 기존 GET/POST 단문 검색은 그대로 유지한다.
명확하지 않은 요건은 질문하고 검색하지 않는다. 단문 검색으로 몰래 우회하는 장애 fallback은 없다.

기업 조건 수동 입력 패널·조건 적용/전체 초기화 버튼·조건 칩의 개별 해제·접수 상태 선택 상자와
상시 장문 안내는 제거했다. 기업 조건과 접수 상태는 대화에서 변경·해제를 요청하고 제안 확인 후 적용한다.
기본은 접수 중만 검색하며, 새 대화·새로고침 시 기업 조건과 접수 상태를 초기화한다.
검색 당시 조건 스냅샷, 구조화 조건 전송과 백엔드 자격 검증은 유지한다.

확인 카드도 간소화했다. READY는 검색 의도 제목·실제 변경할 조건 칩·검색/취소 버튼만 표시한다.
해제할 조건은 해제로 명시하고, 변경 없는 유효 조건은 한 줄로 유지됨을 알린다. 미입력 항목·전후
비교표·상시 장문 안내는 표시하지 않는다. CLARIFICATION_REQUIRED는 질문과 답변 안내·취소만 남긴다.
이는 표시 방식의 변경이며 확인 전 자동 검색이나 조건 자동 적용을 추가하지 않는다.

- `지원금 위주`는 기존 지역·업종·설립일을 유지하면서 지원 목적과 검색 의도를 조정한다.
- `부산으로 변경`은 현재 소재지만 바꾸며 기존 서울이 검색 의도에 남지 않도록 한다.
- `설립 2년`만으로 정확한 설립일을 계산하지 않는다. 필요하면 정확한 날짜를 묻는다.
- `지역 조건 해제`는 지역 해제안을, `마감된 공고도 포함해 전체로 검색`은 접수 상태 변경안을 확인한다.
- READY 제안은 후속 메시지 입력 중에도 카드를 유지한다. 보내지 않은 메시지가 있으면 이전 제안의
  확인 검색은 막고 이유를 안내하며, 입력을 비우면 같은 제안을 확인할 수 있다. 제안의 조건은 pendingProposal로
  보관하여 `대구로`, `설정해` 같은 후속 발화가 이어받는다. 확인 전에는 확정 조건을 바꾸지 않는다.
- 확인 질문에 답할 때는 미확정 초안과 마지막 질문 하나를 사용한다. 초안은 적용 조건과 구분한다.
- `왜 못찾아?` 같은 결과 설명은 ANSWERED로 대화에 표시하고 검색·조건 변경을 실행하지 않는다.
  최근 검색 요약이 없으면 결과를 확인할 정보가 없다고 안내하며, 0건의 원인을 추측하지 않는다.
- 새 대화·새로고침은 초기화한다. 로그인·DB·localStorage·모델 대화 세션 저장을 추가하지 않는다.

## 공개 해석 API

`POST /api/v1/support-programs/conversation/interpret`

```json
{
  "message": "부산으로 변경",
  "context": {
    "query": "사업화 지원",
    "acceptingOnly": true,
    "companyConditions": {
      "region": "서울", "industry": "SW", "establishedOn": null, "supportPurpose": "사업화"
    }
  },
  "pendingClarification": null,
  "pendingProposal": null,
  "lastSearch": null
}
```

context의 `query`는 작은 검색 의도다. 과거 사용자 발화나 공고 본문을 이어붙이지 않는다.
현재 적용된 구조화 조건과 중복되는 지역·업종·설립일은 가급적 query에 두지 않는다.
context와 내부 companyConditions 객체 및 모든 내부 필드는 필수이며 미입력 값은 null이다.
초기 query는 null, acceptingOnly는 true다. pendingProposal과 lastSearch는 생략/null을 허용한다.
pendingProposal은 확인 전 READY 제안의 ConversationContext이며 pendingClarification과 동시에 보낼 수 없다.
lastSearch는 `{ "context": <실제로 검색한 조건>, "resultCount": 0 }` 형태의 최근 성공 검색 요약이다.
resultCount는 0 이상의 JSON 정수이며 boolean·소수·문자열은 거부한다. 전체 공고 본문이나 제외 사유는 포함하지 않는다.
새 검색을 시작하면 이전 요약을 지우고 성공한 결과만 저장한다. 실패·취소를 0건으로 기록하지 않는다.

pendingClarification은 생략/null 또는 다음 객체다.

```json
{
  "question": "정확한 설립일을 YYYY-MM-DD 형식으로 알려주세요.",
  "draftContext": {
    "query": "사업화 지원",
    "acceptingOnly": true,
    "companyConditions": {
      "region": "서울", "industry": "SW", "establishedOn": null, "supportPurpose": "사업화"
    }
  }
}
```

새 메시지가 `2024-01-01`이면 직전 질문과 이 초안에서 이어간다. 질문이 다시 필요한 경우에도 전체 이력 대신
새 초안과 마지막 질문 하나로 교체한다. 초안을 취소하면 기존 적용 조건으로 돌아간다.

응답:

```json
{
  "status": "READY",
  "proposedContext": {
    "query": "사업화 지원",
    "acceptingOnly": true,
    "companyConditions": {
      "region": "부산", "industry": "SW", "establishedOn": null, "supportPurpose": "사업화"
    }
  },
  "clarificationQuestion": null,
  "answer": null,
  "changedFields": ["REGION"]
}
```

- status는 READY, CLARIFICATION_REQUIRED 또는 ANSWERED다. READY는 비어 있지 않은 query가 필수이고 질문은 null이다.
- CLARIFICATION_REQUIRED는 질문이 필수다. proposedContext는 미확정 초안일 뿐 검색에 사용하지 않는다.
- ANSWERED는 비어 있지 않은 answer가 필수이고 clarificationQuestion은 null이다. 변경 updates는 허용하지 않으며
  확정 조건과 보관 중인 제안·질문을 바꾸지 않는다. READY/CLARIFICATION_REQUIRED에서는 answer가 null이어야 한다.
  answer는 UTF-16 1,000자 이내이며 LF/CR/tab 외 제어·형식 문자는 거부한다. 기존 응답의 answer 생략은 null로 처리한다.
- changedFields는 Core가 요청의 확정 context와 최종 proposedContext를 비교하여 계산한다.
  순서는 QUERY, REGION, INDUSTRY, ESTABLISHED_ON, FOUNDED_YEAR, SUPPORT_PURPOSE, ACCEPTING_ONLY다.
- 해석 요청도 기존 검색·원문 질문과 같은 주소별/전역/동시 요청 제한을 공유한다.
  해석과 확인 검색은 HTTP 요청 2건으로 각각 계산한다.

## 내부 AI 계약

`POST /internal/v1/support-program-conversation/interpret`

공개 요청과 같은 message/context/pendingClarification/pendingProposal/lastSearch에 Core가 정한 서울 날짜 referenceDate와
`schemaVersion: "govbiz-support-program-conversation-v1"`을 추가한다.

AI는 전체 상태를 재작성하지 않고 변경 목록만 반환한다.

```json
{
  "schemaVersion": "govbiz-support-program-conversation-v1",
  "status": "READY",
  "updates": [
    {"field": "REGION", "operation": "SET", "value": "부산", "evidence": "부산"}
  ],
  "clarificationQuestion": null
}
```

- updates 최대 7개, 동일 field 중복 금지. 위 changedFields와 같은 7개 field만 허용한다.
- SET은 비어 있지 않은 value, CLEAR는 null이다. ACCEPTING_ONLY의 SET은 문자열 true/false만 허용한다.
  CLEAR는 문자열 필드를 null로, ACCEPTING_ONLY를 기본 true로 되돌린다. KEEP은 목록에 넣지 않는다.
- 각 변경의 evidence는 현재 message의 정확한 연속 부분 문자열이며 필수다. 짧은 동의의 대상이 직전 제안·질문에서
  하나로 분명하면 그 맥락으로 뜻을 해석하고 `설정해` 같은 현재 발화를 근거로 인용할 수 있다.
  대상이 불명확하면 추측하지 않는다. 설립일 SET에는 아래의 완전한 날짜 인용 규칙을 그대로 적용한다.
- pendingClarification이 있으면 draftContext, 아니면 pendingProposal, 둘 다 없으면 context를 기준으로 변경 목록을 병합한다.
  목록에 없는 필드는 코드로 그대로 유지한다. AI와 Core는 변경 목록·병합 후 상태·READY query를 검증한다.
- ESTABLISHED_ON SET은 evidence 자체가 완전한 날짜여야 한다. YYYY-MM-DD 또는 YYYY년 M월 D일
  (년·월 뒤 공백 허용)만 인용하고 ISO 날짜로 정규화한 값이 value와 같아야 한다. 날짜 앞뒤의 다른 문구는
  이 인용에 넣지 않으며 상대 업력으로 날짜를 생성할 수 없다.
- CLARIFICATION_REQUIRED에서도 명확한 항목은 초안에 넣을 수 있지만 모호한 필드는 바꾸지 않는다.
  형식이 맞아도 의미 정확도를 보증하지 않으므로 모든 READY 결과는 사용자가 확인한다.
  [OpenAI Docs](https://developers.openai.com/api/docs/guides/structured-outputs#handling-mistakes)의 구조화 출력에도
  내용 오류가 남을 수 있다는 한계를 반영한다. 스키마 통과를 자연어 해석 정확도로 보고하지 않는다.
- ANSWERED는 조건 변경 없이 현재 제공된 정보로 설명한다. lastSearch는 사용자 화면에서 전달된 요약이며 DB에서
  원인을 검증한 자료가 아니다. `모든 공고가 마감됨`, `대구에 해당 사업이 없음` 같은 원인을 만들어내지 않는다.
  결과가 없다는 질문만으로 접수 상태·지역·분야를 자동 완화하지 않는다.
- 단일 구체 Agent/Service, 기존 모델·store=false·tracing 비활성·모델/실행 timeout을 유지한다.
  역할은 검색 후속 대화의 조건 제안·설명이며 기존 공고 랭킹 Agent와 구분된다. graph/handoff/provider/새 의존성은 추가하지 않는다.

### 모델 출력의 범위 제한 (2026-09-22)

C02 모델의 내부 구조화 출력과 AI Service의 HTTP 응답을 구분한다. 모델은 `status`, `updates`,
`answerKind`, `clarificationKind`만 출력하며 자유 `answer`·`clarificationQuestion` 필드는 허용하지 않는다.

- `READY`: 두 종류 코드는 null이며 기존 조건 변경안을 검증한다.
- `ANSWERED`: updates는 비어 있고 answerKind가 필수이며 clarificationKind는 null이다.
  허용 코드는 `RESULT_SUMMARY`, `SEARCH_HELP`, `OUT_OF_SCOPE`, `CANCEL_GUIDANCE`다.
- `CLARIFICATION_REQUIRED`: clarificationKind가 필수이며 answerKind는 null이다.
  허용 코드는 `QUERY`, `REGION`, `INDUSTRY`, `ESTABLISHMENT`, `SUPPORT_PURPOSE`, `ACCEPTING_ONLY`, `CHANGE_TARGET`이다.

AI Service는 선택된 코드를 정해진 존댓말 안내·확인 질문으로 변환한다. 결과 요약은 `lastSearch`의
검증된 resultCount만 사용하며, 요약이 없으면 완료 검색 정보가 없다고 안내한다. 사용자·모델 자유문자열을
안내에 삽입하거나 검색 실패 원인·공고 내용·자격 충족 여부를 만들어 붙이지 않는다.
`duckduckgo에 관해 자세히 말해줘`처럼 범위 밖인 요청은 `OUT_OF_SCOPE`로 분류하도록 지시한다.
이 분류 자체가 틀려도 허용된 안내·질문 코드만으로 임의의 검색엔진 설명이나 반말을 생성할 수 없다.

OpenAI 호출은 계속 필수다. 형식 위반·알 수 없는 코드·상태 불일치·모델 장애를 정상 안내로 숨기지 않고
기존 503/504 오류로 반환한다. 별도 판정 모델·외부 서비스·새 의존성은 추가하지 않는다.
AI Service → Core → Web의 공개 응답 키와 v1은 유지한다. 모델 스키마·프롬프트·Service 문구 및
Compose 검증용 OpenAI 대역은 함께 반영해야 한다. 기존 실행 중 이미지에는 소스 수정만으로 적용되지 않는다.

이 경계는 검색 대화의 자유 안내문·확인 질문에 대한 것이다. 모델의 범위 분류나 검색 조건 제안의 의미 정확도,
추천 점수·인용 해석·RAG 답변 전체의 무오류를 뜻하지 않는다. 조건 제안은 기존처럼 사용자 확인 후에만 검색한다.
고정 모델·Compose 대역 테스트는 이 출력 경계를 검증하며 실제 모델의 한국어 분류 품질 평가를 대신하지 않는다.

이번 변경의 로컬 검증은 AI 선택 417건(C02 전체·랭킹 Agent·공유 LLM 호출), Core C02 소비자 93건,
Web C02 소비자 105건이 통과했다. AI 수치는 최초 통과 범위와 수정된 테스트 재검증을 중복 없이 합한 값이다.
이전 모델·Service에 임의 DuckDuckGo 설명을 입력하면 그대로 반환되는 것을 재현했고, 새 모델 계약이
동일 자유 답변을 거부하는 것을 확인했다. 허용된 11개 안내·질문 코드, 모든 상태의 자유문자 필드 주입,
알 수 없는 코드·상태 조합, 검색 조건 보존과 자동 검색 방지를 고정 응답으로 검증했다.
실제 OpenAI 의도 분류 평가는 실행하지 않았으며 새 이미지 배포·클러스터 반영·원격 CI는 미실행이다.

### 배포와 검증 범위

추가 요청 필드와 answer는 생략 호환을 유지하고 내부 schemaVersion은 v1을 유지한다. 새 ANSWERED 응답과
미확정 제안·검색 요약을 사용하려면 Frontend·Core API·AI Service를 함께 반영해야 한다.
자동 테스트는 계약·상태 전달·고정 모델 응답을 검증한다. 실제 자연어 해석 품질은 별도 실모델 평가로 확인해야 한다.

## 검증·문자·실패 규칙

- 새 계약의 길이 제한은 UTF-16 코드 단위다. message/query 최대 500, region 50, industry/supportPurpose 100,
  날짜 10, question/evidence 160. question/evidence는 공백뿐인 값과 Unicode C 문자를 거부한다.
- message는 비어 있으면 안 된다. query는 null 또는 비어 있지 않은 값이다. message/query는 기존 검색처럼
  LF/CR/tab 외 Unicode C 문자를 거부한다. 조건 문자열은 모든 Unicode C를 거부한다.
- 날짜는 실제 달력 날짜이며 1900-01-01부터 서울 기준 오늘까지다. boolean은 문자열/숫자로 강제 변환하지 않는다.
- AI 필드 누락·지원하지 않는 값·허위 인용·날짜 창작·잘못된 READY는 명시적 상위 응답 오류다.
  사용자 정보 부족 응답이나 검색 0건으로 숨기지 않는다. 요청 검증 실패는 400, 기존 요청 제한/AI 오류 정책을 유지한다.
  내부 AI API의 요청 검증 실패는 기존 FastAPI 정책대로 422다.
- 조건 해석의 모델·HTTP·전체 실행 시간 초과는 내부 504 → 공개 `504 AI_SERVICE_TIMEOUT`으로 구분한다.
  다른 모델 실행·패치 검증 실패는 내부 503 → 공개 `503 AI_SERVICE_UNAVAILABLE`을 유지한다.
  프런트는 검증한 공개 오류 종류에 맞춰 시간 초과·일시 이용 불가를 안내하며 서버 원문 오류는 노출하지 않는다.
  실패 로그는 실패 종류·오류 클래스명·소요 시간만 기록하며 요청 문장·기업 조건·모델 응답은 기록하지 않는다.
- C02 최초 검증 당시 Frontend 해석 timeout은 40초, 확인 검색은 70초였다.
  후속 [랭킹 시간 초과 수정](support-program-ranking-timeout-fix.md)에서 확인 검색만 90초로 조정했다.
  취소·늦은 응답·중복 제출을 막고 검색 재시도는
  이미 확인한 요청으로 실행한다. 다시 해석과 검색 재시도를 구분한다.
- 실제 흐름: `HTTP API → Service → Agent → OpenAI → Response`로 변경안을 얻고, 사용자 확인 후
  기존 `Web → Core 검색 → 후보 조회 → AI 랭킹 v4 → 검색 응답`을 실행한다.

## 검증 기록

다음 수치와 관찰은 C02 최초 구현 당시의 기록이다. 후속 수동 입력 UI 제거의 테스트 결과나
최신 화면 배포 상태로 해석하지 않는다.

### 자동 테스트

- AI Service 전체 `pytest`: **459개 통과**, 실패 0. 기존 319개에 C02 140개 추가.
  실제 SDK structured schema·필수 nullable 키·부재 필드 보존·초안 병합·허위 인용·날짜 창작 거부·
  UTF-16 상한·요청 422·명시적 503·로컬 OpenAI 스텁 8개 시나리오를 포함한다.
- Frontend 전체 `vitest run --maxWorkers=1`: **29개 파일, 287개 통과**, 실패 0.
  `tsc -b`, `oxlint`, `vite build`도 통과했다. 병렬 Core 검증과의 로컬 자원 경합을 줄여 실행했으며
  테스트 timeout을 늘리거나 테스트를 제외하지 않았다.
- Core JDK 21 전체 `./gradlew clean test --no-daemon --no-watch-fs`: **47개 스위트, 508개 통과**,
  실패·오류·건너뜀 0. 기존 433개와 신규 Client 28·Controller 15·Service 32개를 모두 실행했다.
  MySQL 8.4.11 Testcontainers 통합 43개를 포함하며 H2 대체·테스트 제외는 없다.
  기존 Gradle 캐시 볼륨을 사용한 `--project-cache-dir /root/.gradle/core-audit-project`만 지정했다.
  결과는 `backend/core-service/build/test-results/test`, 최종 실행 6분 22초다.
- 검증 중 테스트 대역의 Kotlin nullable matcher, 시간 의존, 화면 테스트 갱신 문제를 수정해 전체를 다시 실행했다.
  Windows bind 경로의 일시적인 `clean` 잠금은 같은 명령 재시도로 해소했다. production 검증 규칙 완화나
  별도 buildDirectory/init-script는 사용하지 않았다. `git diff --check`도 통과했다.
- Core↔AI 별도 읽기 전용 교차 검토에서 재현 가능한 계약 불일치는 발견하지 못했다.

### 가상 브라우저 연결 검증

별도 로컬 서버의 가상 공고만 사용했다. 모든 `/api` 요청은 이 서버에서 끝나며 실제 모델·검색 서비스로
우회하지 않았다. UI 조작과 서버의 요청 기록을 함께 대조했다.

- 첫 조건 제안 확인 전에는 해석 요청만 1건이고 검색은 0건이었다. 확인 후에만 POST 검색이 전송됐다.
- `지원금 위주`에서 서울·SW를 유지하고 지원 목적/의도만 바꿨다.
- `부산으로 변경`에서 지역만 바뀌고 이전 검색 결과의 서울 조건 스냅샷은 그대로 남았다.
- `설립 2년`은 정확한 날짜를 질문했다. `2024-01-01` 답변에는 미확정 초안과 마지막 질문이 전달됐다.
- 날짜 READY를 확인하지 않고 새 메시지를 쓰면 그 날짜와 이전 pending 초안이 폐기됐다.
- 지역 해제 제안을 취소하면 적용 지역 부산이 유지됐고 추가 검색은 없었다.
- 확인 검색의 첫 503 뒤 `다시 검색`은 같은 POST body로 검색만 다시 실행했다. 해석 요청은 추가되지 않았다.
- 새 대화에서 적용 조건·검색 의도·대화가 초기화됐다. 좁은 화면에서도 전후 비교와 확인/취소 버튼을 확인했다.
- 검증용 탭·서버를 종료했고 임시 포트 5178/18081의 리스너가 없음을 확인했다.

### 실제 모델 검증 범위와 사전 기대

사용자가 가상의 조건으로 **최대 3회**만 승인했다. 각 요청은 공개 해석 API를 통해 수행하며 자동 재시도·
실제 공고 검색은 하지 않았다. 다음 기대를 먼저 정하고 최종 재빌드 후 실행했다.

| 메시지 | 확정 상태 | 사전 기대 |
|---|---|---|
| 지원금 위주 | 서울 / 소프트웨어 개발 / 2024-01-01 / 사업화 / 사업화 지원 | READY, 지역·업종·설립일·접수 필터 유지, 지원금 의도를 목적 또는 query에 반영 |
| 부산으로 변경 | 서울 / 소프트웨어 개발 / 2024-01-01 / 지원금 / 사업화 지원금 | READY, REGION만 부산으로 변경, 나머지 조건·query 유지 |
| 설립 2년 | 부산 / 소프트웨어 개발 / 설립일 null / 지원금 / 사업화 지원금 | CLARIFICATION_REQUIRED, 정확한 날짜 질문, 날짜 창작 없이 나머지 조건 유지 |

공통 acceptingOnly는 true, pendingClarification은 null이다. 세 요청은 독립된 가상 확정 상태를 사용한다.
단회 3건은 연결·대표 동작 확인이며 일반 해석 정확도, 실제 추천 품질, Q01 사람 검토 게이트의 합격 증거가 아니다.

### 실제 모델 관찰 결과 — 2026-09-07

기존 `gpt-5.6-luna`, `api.openai.com`을 사용했다. 호출 경로는
`Web 프록시 → Core 공개 해석 API → AI Service → Agent → OpenAI → 검증된 변경 제안`이다.
`max_retries=0`, `max_turns=1`, `store=false`를 유지했다. 해석 검증은 **3회로 종료**, 재시도·추가 검색 0회다.
프롬프트 파일 SHA-256은 `a4568b7740e6ff9e4101d2323b3173f62d02002623e6681d629b1fb41c24efcf`다.

| 메시지 | HTTP·상태 | 관찰 결과 | 왕복 시간 |
|---|---|---|---:|
| 지원금 위주 | 200 / READY | query가 `사업화 지원` → `지원금`, 지원 목적이 `사업화` → `지원금`. changedFields는 QUERY, SUPPORT_PURPOSE. 서울·업종·설립일·접수 필터 유지 | 4.622초 |
| 부산으로 변경 | 200 / READY | REGION만 서울 → 부산. query `사업화 지원금`·지원 목적·업종·설립일·접수 필터 유지 | 1.430초 |
| 설립 2년 | 200 / CLARIFICATION_REQUIRED | changedFields는 빈 배열, 설립일 null 및 나머지 상태 유지. `정확한 설립일을 YYYY-MM-DD 또는 YYYY년 M월 D일 형식으로 입력해 주세요.` 질문 | 1.629초 |

사전 상태·필드 보존 검사는 모두 통과했다. 다만 첫 응답은 **사업화 목적이 검색 의도에서 사라지는 의미 축약**을
관찰했다. 지원금 형태로 좁히더라도 `사업화 지원금`처럼 원래 목적을 유지하는 편이 더 안전하다.
이는 프롬프트의 기존 의도 보존 지침에 부분적으로 미달하는 잔여 품질 문제이며, HTTP/스키마 성공과 구분한다.
사용자 확인으로 자동 적용 위험을 낮췄을 뿐 의미 정확도를 보증하지 않는다. 예산을 소진한 뒤 추가 호출이나
후속 프롬프트 변경은 하지 않았다. 추가 개선 시 이 사례와 다른 목적 변경 사례를 함께 재평가해야 한다.
왕복 시간은 로컬 Web/Core/AI를 모두 포함하며 순수 모델 지연·토큰 사용량·요금은 이번 공개 API에서 측정하지 않았다.

### 반영과 남은 범위

검증 후 사용자 승인 범위에서 로컬 Core·AI를 재빌드·재시작했다. Core는 기존 Compose 빌드,
AI는 이전 uv 공유 캐시 문제를 피하도록 두 `uv sync`에 `--no-cache`만 더한 임시 Dockerfile을 사용했다.
원본과의 차이가 이 옵션뿐임을 확인했으며 production Dockerfile·의존성·잠금 파일은 변경하지 않았다.
`up --detach --no-deps --no-build --pull never`로 대상 서비스만 교체했다.

| 서비스 | 반영 후 컨테이너 ID | 보존/변경 |
|---|---|---|
| Core | f366a212e995 | 새 이미지 `sha256:b52be694a5df1ce07e1c797b81e420356c458b2ed2e61587165963058b5de07a` |
| AI | 122ee60f6360 | 새 이미지 `sha256:5354ed089c01fd136d0e575a5ebada5c0f69aafbdc66878f9006f06159630a18` |
| Web | b529a34d6ed1 | 기존 컨테이너·소스 bind·web-node-modules 볼륨 유지 |
| MySQL | 505a1af7beec | 기존 컨테이너·govbiz_mysql-data 유지 |
| Qdrant | 7c0e50e0ebe7 | 기존 컨테이너·govbiz_qdrant-data 유지 |

재시작 전 기존 컨테이너와 Compose의 환경변수 키별 값이 일치함을 비밀값을 출력하지 않고 확인했다.
Web 프록시를 통한 Core health·Core→AI health는 HTTP 200, 잘못된 해석 body `{}`는 모델 호출 없이 400이었다.
최종 readiness는 `SEARCHABLE`, `indexReady=true`, 공고 1,550건, 최근 성공 동기화
`2026-09-07T16:46:43.086462+09:00`, 최근 실패 없음이었다.
승인된 기존 자동 수집·색인이 재시작 후 실행됐으므로 **볼륨 보존이 DB 내용 불변을 뜻하지는 않는다**.
수집·색인 비용은 위 수동 해석 검증 3회와 별도이며 이번에 그 사용량을 측정하지 않았다.
테스트용 JDK runtime·MySQL·Ryuk는 자동 정리됐고, 기존 Gradle 캐시 볼륨은 보존했다.

로그인·영구 조건 저장·전체 대화 이력·기업 단계 구분·첨부 자격 대조·Q01 사람 검토는 이번 구현 범위가 아니다.
검증·재시작 단계에서는 커밋·push를 수행하지 않았다.
