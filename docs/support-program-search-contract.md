# 지원사업 검색·상세 HTTP 계약

GovBiz Web은 공공데이터포털 키나 OpenAI 키를 보유하지 않습니다. 브라우저는 Core API만 호출하고,
Core는 정기 동기화된 MySQL 공고 카탈로그에서 후보를 읽어 AI Service에 점수화를 요청합니다.
전체 구성은 [기술 문서](technology.md), 구현 범위와 후속 과제는 [구현 현황](implementation-status.md)을 참고하세요.

```text
Browser
  → POST /api/v1/support-programs/search (Web의 조건 검색)
    GET /api/v1/support-programs/search (기존 단문·최신 목록 호환)
      → Core API
          → MySQL의 색인 준비된 제공처의 현재 노출 공고 조회·접수 상태 필터
          → 현재 공고 ID·내용 해시로 Qdrant 검색 범위 제한
          → 질의 임베딩에 가까운 후보 최대 20개 선택
          → POST /internal/v1/support-program-rankings/rank
              → LLM이 버전된 평가 기준으로 모든 후보 점수화
          → 본문 인용 검증 → 지원대상·지역 불일치 제외 + 최소 추천 기준 적용
          → 관련도 내림차순, 자격 확인 여부는 별도 표시
          → 0~5개를 Core가 검증해 반환
```

## 공개 요청

### 대화 조건 해석 — 확인 검색 전 단계

Web의 새 메시지는 `POST /api/v1/support-programs/conversation/interpret`로 현재 검색 의도·확정 조건과
선택적인 미확정 초안/마지막 질문 하나를 보냅니다. READY 제안은 사용자가 확인한 뒤 아래 기존 POST 검색에 전달합니다.
CLARIFICATION_REQUIRED는 보완 질문이며 검색 결과 없음이나 외부 서비스 장애와 구분합니다.
해석은 DB·후보 검색을 실행하지 않으며 같은 공개 요청 한도를 공유합니다. 기존 GET/POST 검색 계약은 유지합니다.
요청·응답·변경 목록·문자 규칙은 [C02 계약](conversation-condition-update.md)에 있습니다.

### 기업 조건 검색 — 사용자 확인 후 실행 경로

기업 조건을 URL query string에 넣지 않고 JSON body로 전송합니다. 회원가입·기업 조건 DB 저장은 없으며,
이 검색 요청은 입력 조건을 계정·기업 DB에 저장하지 않습니다. 비회원의 추가 결과가 있으면 로그인 후 복원을 위해
전체 결과와 조건을 Redis에 30분 보관합니다. [Redis 적용·복원 계약](redis-search-result-restoration.md)을 참고하세요.
POST와 기존 GET은 같은 요청량·동시 실행 한도를 공유합니다.

```http
POST /api/v1/support-programs/search
Content-Type: application/json
Accept: application/json

{
  "query": "사업화 지원을 찾아주세요",
  "acceptingOnly": true,
  "companyConditions": {
    "region": "서울특별시",
    "industry": "소프트웨어 개발",
    "establishedOn": "2024-09-01",
    "supportPurpose": "사업화 자금"
  }
}
```

| Body field | 필수 | 설명 |
|---|---|---|
| `query` | 예 | 최대 500 UTF-16 코드 단위. 앞뒤 공백 제거 후 빈 검색문은 POST에서 400. 기존 제어문자 거부 규칙 유지 |
| `acceptingOnly` | 아니요 | 기본 `true`. `false`는 전체 접수 상태이며 `UNKNOWN`을 `OPEN`으로 바꾸지 않음 |
| `companyConditions` | 아니요 | 등록 기업에서 불러오거나 사용자가 대화에서 확인한 조건. 생략·`null`·모든 필드 미입력은 조건 없는 검색 |
| `companyConditions.region` | 아니요 | 현재 소재지, 최대 50 UTF-16 코드 단위. 이전 예정 지역으로 추정하지 않음 |
| `companyConditions.industry` | 아니요 | 업종, 최대 100 UTF-16 코드 단위 |
| `companyConditions.establishedOn` | 아니요 | 최대 10자, 실제 달력의 `YYYY-MM-DD`, 1900-01-01부터 서울 기준 오늘까지. 상대 업력을 임의의 설립일로 바꾸지 않음 |
| `companyConditions.foundedYear` | 아니요 | 설립연도 정수, 1900부터 서울 기준 올해까지. 정확한 establishedOn과 동시 지정 불가. 특정 월·일을 임의로 만들지 않음 |
| `companyConditions.supportPurpose` | 아니요 | 원하는 지원 목적, 최대 100 UTF-16 코드 단위 |

조건 텍스트는 앞뒤 공백을 제거하고 빈 값은 미입력으로 처리합니다. 길이 상한은 공백 제거 전 요청값 기준이고,
제어문자는 제거 전부터 거부합니다. 설립일은 빈 문자열·ASCII 공백만 미입력으로 처리하며 날짜 주위 공백,
잘못된 일자·시간 포함 문자열·미래 날짜는 400입니다. `acceptingOnly`는 JSON boolean만 허용하고 `null`은 거부합니다.
공개 응답의 `programs`에는 아래의 `eligibilityReview`가 추가되며,
`query`는 원래 검색문입니다. 회사 조건을 붙인 내부 검색문을 공개 응답으로 돌려주지 않습니다.

Core는 입력 조건과 서울 기준 날짜를 원래 검색문에 덧붙여 **의미·키워드 후보 검색**에 사용하고,
**최종 AI 점수화**에는 원래 검색문과 구조화된 조건을 별도로 전달합니다. 공고의 지역·업종 표기가
불완전할 수 있으므로 단순 문자열 비교만으로 공고를 제외하지 않습니다. 이는 법적 신청 자격의 확정 필터가 아닙니다.
빈 조건은 적합을 뜻하지 않습니다. 적용 조건과 검색문이 명백히 충돌하면 사용자가 확인한 적용 조건을 우선하며,
이 검색 endpoint 자체는 대화에서 조건을 추출하거나 갱신하지 않습니다. C02는 별도 해석 endpoint에서 얻은
제안을 사용자가 확인한 후 이 endpoint를 호출합니다.

### 기존 GET 검색 — 호환 경로

```http
GET /api/v1/support-programs/search?query=%EC%88%98%EC%B6%9C&acceptingOnly=true
Accept: application/json
```

| Query parameter | 필수 | 설명 |
|---|---|---|
| `query` | 예 | 사용자의 검색 문장. 요청값 최대 500 UTF-16 코드 단위. 탭·줄바꿈·CR을 제외한 Unicode `C` 범주 문자는 400으로 거부. 앞뒤 공백 제거 후 비어 있으면 임베딩·Qdrant·LLM을 호출하지 않고 최신 공고 최대 5개를 반환 |
| `acceptingOnly` | 아니요 | `true`이면 Core가 `OPEN` 공고만 AI 후보로 전달. 기본값 `true` |

## 공개 검색 준비 상태

제공처별 `sources`는 필수 필드이며 부분 검색 상태도 추가되었습니다. 이 계약을 사용하는 Core와 Frontend는
함께 갱신해야 합니다. 이전 응답에 없는 제공처 상태를 Frontend가 추정하지 않습니다.

채팅 화면은 검색 요청 전에 다음 endpoint로 현재 공개 스냅샷의 준비 상태를 조회합니다. 이 endpoint는
외부 API·AI Service·Qdrant를 호출하지 않고 MySQL에 기록된 마지막 전체 동기화·색인 준비 결과만 반환합니다.

```http
GET /api/v1/support-programs/readiness
Accept: application/json
```

```json
{
  "searchState": "SEARCHABLE_WITH_SYNC_FAILURE",
  "programCount": 128,
  "indexReady": true,
  "lastSuccessfulSyncAt": "2026-09-05T09:00:00+09:00",
  "lastFailedSyncAt": "2026-09-05T10:00:00+09:00",
  "sources": [
    {
      "sourceCode": "BIZINFO",
      "sourceName": "기업마당",
      "searchState": "SEARCHABLE_WITH_SYNC_FAILURE",
      "programCount": 128,
      "indexReady": true,
      "lastSuccessfulSyncAt": "2026-09-05T09:00:00+09:00",
      "lastFailedSyncAt": "2026-09-05T10:00:00+09:00"
    }
  ]
}
```

| 필드 | 설명 |
|---|---|
| `searchState` | `PREPARING`, `SEARCHABLE`, `SEARCHABLE_WITH_SYNC_FAILURE`, `SEARCHABLE_WITH_PARTIAL_SOURCES`, `UNAVAILABLE` 중 하나 |
| `programCount` | 검색 가능한 제공처들의 공고 수 합계. 접수 상태 필터 적용 전의 수이며 미준비 제공처는 포함하지 않는다. |
| `indexReady` | 한 제공처 이상의 공개 스냅샷 색인 준비가 확인되었는지. 실시간 Qdrant Health는 확인하지 않는다. |
| `lastSuccessfulSyncAt` | 제공처별 동기화 성공 시각 중 가장 최근 값. 없으면 `null` |
| `lastFailedSyncAt` | 제공처별 동기화 실패 시각 중 가장 최근 값. 없으면 `null` |
| `sources` | 필수 배열. 각 원소는 `sourceCode`, `sourceName`, `searchState`, `programCount`, `indexReady`, `lastSuccessfulSyncAt`, `lastFailedSyncAt`을 포함한다. |

`sources[].searchState`는 기존 네 상태만 사용하며 부분 준비 상태는 전체 집계에만 사용합니다.
제공처별 `programCount`는 저장된 공개 공고 수이므로 미준비 제공처도 0보다 클 수 있습니다.
제공처별 `indexReady`와 성공/실패 시각은 해당 제공처 스냅샷에만 적용합니다. 상태 행 없는 현재 공고도
해당 제공처를 `UNAVAILABLE`·`indexReady=false`·동기화 시각 `null`로 안내합니다. 초기 빈 DB에는 `BIZINFO`와
수집을 명시적으로 활성화한 `KSTARTUP`·`MSIT`·`CNTRADE_NOTICE`를 포함합니다. URL 허용만으로 출처를 등록하지 않습니다.

`SEARCHABLE`은 성공적으로 공개·색인된 스냅샷을 뜻하며 공고 수가 0인 경우도 포함합니다.
`SEARCHABLE_WITH_SYNC_FAILURE`은 이전 스냅샷은 계속 검색 가능하지만 더 최근 동기화가 실패한 경우입니다.
`SEARCHABLE_WITH_PARTIAL_SOURCES`는 검색 가능한 제공처와 미준비 제공처가 함께 있을 때 우선하는 집계 상태입니다.
이때 Frontend는 검색을 허용하고 준비된 제공처 이름과 각 제공처의 개별 실패 상태를 표시합니다.
준비된 제공처가 없으면 하나라도 `UNAVAILABLE`일 때 전체도 `UNAVAILABLE`, 그 외에는 `PREPARING`입니다.
`UNAVAILABLE`은 공개 스냅샷의 색인 준비가 확인되지 않은 경우이며, 상태 행 없는 기존 공고도 포함합니다.
`PREPARING`은 공개 공고가 없는 초기 상태나 성공·실패가 아직 기록되지 않은 첫 동기화 상태입니다. V4 상태 테이블을 도입하기 전부터
존재하던 **비어 있지 않은** 제공처별 공고는 해당 제공처 전체 복구 색인이 성공한 뒤에만, 그때 읽은 지문·공고 수를 sentinel
세대 `0`으로 조건부 채택해 `SEARCHABLE`이 될 수 있습니다. 빈 초기 DB는 `PREPARING`, 복구 전 legacy 공고는 `UNAVAILABLE`이며,
실제 새 스냅샷의 지문은 bootstrap이 바꾸지 않습니다. 시각은 `Asia/Seoul` 오프셋을 포함한 ISO-8601 문자열입니다.
제공처별 복구와 현재 미연동 범위는 [6단계 다중 제공처 준비](support-program-multi-source-preparation.md)에 정리합니다.

## 내부 LLM 점수화 요청

Core만 다음 FastAPI endpoint를 호출합니다.

```http
POST /internal/v1/support-program-rankings/rank
Content-Type: application/json

{
  "originalQuery": "서울 AI 창업기업이 받을 사업",
  "scoringVersion": "govbiz-support-program-ranking-v5",
  "resultLimit": 5,
  "candidates": [
    {
      "id": "BIZINFO:PBLN_001",
      "title": "서울 AI 창업기업 사업화 지원",
      "organization": "서울경제진흥원",
      "summary": "AI 창업기업의 사업화를 지원합니다.",
      "categories": ["AI", "창업"],
      "regions": ["서울"],
      "targetDescription": "서울 소재 창업기업",
      "applicationPeriod": "상시 접수",
      "status": "OPEN",
      "sourceTextTruncated": false
    }
  ]
}
```

AI Service의 버전 `govbiz-support-program-ranking-v5`는 검색 관련성과 신청 자격을 분리합니다.
`totalScore = 2 × (semanticRelevance + supportTypeFit)`이며 100점 만점의 관련도이지 자격 충족 확률이 아닙니다.
기존 v3/v4 평가 기록은 당시 결과로 보존하며 v5 품질 근거로 재사용하지 않습니다.

조건 검색에서는 위 요청에 선택 필드 `companyConditions`를 추가합니다. 공개 입력의 기존 네 필드 및 선택 foundedYear와 함께
Core가 생성한 `referenceDate`(`YYYY-MM-DD`, 서울 기준)를 전달합니다. 조건 없는 요청에서는 이 필드를
생략합니다. 원문 우선 자격 판정은 조건 유무에 관계없이 모든 비어 있지 않은 검색에 적용합니다.
조건이 있는 경우에는 기존 Agent에 조건 해석 지침도 보충하며 Agent 수·LLM 호출 횟수·점수 배점은 늘리지 않습니다.

후보의 `summary`는 공식 API의 사업개요 본문(최대 6,000 Unicode code point), `targetDescription`은
공식 API 지원대상(최대 2,000 code point)입니다. Core는 어느 쪽이든 절단되면 `sourceTextTruncated=true`를
전달하고, 이 경우 누락된 예외·제한을 확인했다고 간주하지 않도록 대상·지역 모두 `UNKNOWN`만 허용합니다.
`regions`는 태그에서 가져온 검색 보조 정보이며 자격 근거가 아닙니다. 태그의 `전국`은 본문의 지역 제한이나
이전·확장 확약 조건을 무효화하지 않습니다. 첨부 PDF/HWP를 자동으로 수집·판독하는 기능은 포함하지 않습니다.

`originalQuery`의 500자 제한은 그대로입니다. 조건을 합친 **내부 색인 검색**의 `query`만 최대
1,000 Unicode code point를 허용합니다. 사용자 질문과 지역·업종·지원 목적의 **값**만 연결합니다.
표제·서버 기준일·서울 시간대·설립일을 검색어로 추가하지 않으며, 사용자가 질문에 직접 쓴 날짜는 보존합니다.
전체 대화 이력을 이 문자열에 이어붙이지 않습니다.
AI는 설립일과 `referenceDate`를 참고하되 공고에 별도 업력 기준일·예외가 있으면 이를 구분하고,
판단 근거가 부족하면 `UNKNOWN`으로 남겨야 합니다. 입력 조건과 공고 본문은 데이터이지 실행 지시가 아닙니다.

| 평가 항목 | 배점 | 의미 |
|---|---:|---|
| `semanticRelevance` | 40 | 사용자 질문과 공고 목적·내용의 의미적 관련성 |
| `supportTypeFit` | 10 | 자금·기술·수출·교육 등 원하는 지원 유형의 적합성 |

LLM은 입력 후보를 정확히 한 번씩 모두 평가합니다. 후보 문장은 데이터일 뿐 지시가 아니며,
후보에 없는 자격·금액·상태를 만들어서는 안 됩니다. 점수와 별도로 모든 후보의 `targetEligibility`와
`regionEligibility`를 필수로 반환합니다. `MATCH`는 제공된 정보와 일치, `INCOMPATIBLE`은 명백한 조건
불일치, `UNKNOWN`은 정보 부족입니다. 하나라도 `INCOMPATIBLE`이면 총점과 관계없이 추천에서 제외합니다.
`UNKNOWN`은 확인 필요 배지·설명으로 구분하지만 관련도 감점이나 제외 사유가 아닙니다.
`semanticRelevance >= 20`을 통과한 공고를 관련도 총점 내림차순(동점은 입력 후보 순서)으로
최대 `resultLimit`개 반환합니다. 과거 총점 60점 컷과 MATCH 절대 우선 정렬은 제거했습니다.
프론트엔드도 서버 순서를 유지합니다. 접수 중 필터는 기존처럼 Core에서 접수 상태로 적용합니다.
통과 공고가 없으면 `rankings`는 빈 배열입니다.

각 대상·지역 판정에는 `explanation`(1~160 code point)과 `evidence`(0~1개)가 필수입니다. `MATCH`와
`INCOMPATIBLE`에는 반드시 인용 1개가 있어야 하며, `UNKNOWN`은 정보 부족·사용자 확인 사항을 설명합니다.
인용은 `{ "field": "SUMMARY" | "TARGET_DESCRIPTION", "quote": "…" }`이고 `quote`는 1~240 code point입니다.
AI와 Core가 실제 전달한 해당 후보·해당 본문 필드의 정확한 부분 문자열인지 검사합니다. 다른 후보의 문장이나
태그·제목·기관명은 인용 원천으로 허용하지 않습니다. 이 검사는 인용의 존재를 검증하며 의미 판정의 정확성을 보장하지 않습니다.

Agent ↔ OpenAI의 내부 출력에서만 `evidence`는 후보별 원문 조각 번호 배열입니다. Agent가 번호의 범위를
검증하고 해당 후보의 `{field, quote}`로 복원한 뒤 전체 후보의 기존 검증을 수행합니다. HTTP 호출자는
원문 조각이나 번호를 보내지 않으며 기존 인용 계약은 바뀌지 않습니다. 전체 본문도 모델에 함께 제공하고,
원문 조각의 존재만으로 자격 충족을 추정하지 않습니다.

```json
{
  "originalQuery": "서울 AI 창업기업이 받을 사업",
  "scoringVersion": "govbiz-support-program-ranking-v5",
  "rankings": [
    {
      "programId": "BIZINFO:PBLN_001",
      "semanticRelevance": 38,
      "targetEligibility": "MATCH",
      "targetEvidence": [{ "field": "TARGET_DESCRIPTION", "quote": "서울 소재 창업기업" }],
      "targetExplanation": "사용자가 밝힌 창업기업 조건과 제공된 지원대상이 일치합니다.",
      "regionEligibility": "MATCH",
      "regionEvidence": [{ "field": "TARGET_DESCRIPTION", "quote": "서울 소재 창업기업" }],
      "regionExplanation": "본문이 서울 소재 기업을 지원대상으로 명시합니다.",
      "supportTypeFit": 8,
      "totalScore": 92,
      "recommendationReasons": ["서울 소재 AI 창업기업의 사업화를 지원"]
    }
  ]
}
```

Core는 다음 불변식을 다시 검사합니다.

- `originalQuery`와 `scoringVersion`이 요청과 정확히 일치
- `programId`가 전달한 후보의 제공처 포함 식별자와 정확히 일치하고 중복되지 않음
- 세부 점수가 각 배점 범위 안에 있음
- `targetEligibility`·`regionEligibility`가 누락 없이 허용 값이며 어느 쪽도 `INCOMPATIBLE`이 아님
- `totalScore`가 `2 × (semanticRelevance + supportTypeFit)`과 정확히 일치
- 자격 상태에 관계없이 총점 내림차순, 합계 0~5개
- 판정 설명·인용 개수·문자 상한과 실제 전달한 본문 내 인용의 정확한 존재 여부
- 절단된 본문 후보는 대상·지역이 모두 `UNKNOWN`
- 반환한 공고마다 `semanticRelevance >= 20`을 충족
- 추천 이유가 1~3개이고 각 1~120 Unicode code point. Core와 AI가 같은 기준으로 검사하며 보조 평면 문자도 하나로 셈

하나라도 위반하면 성공 결과를 만들지 않고 `AI_SERVICE_INVALID_RESPONSE`로 거부합니다.

## 공개 성공 응답

```json
{
  "query": "서울 AI 창업기업이 받을 사업",
  "programs": [
    {
      "id": "PBLN_001",
      "sourceCode": "BIZINFO",
      "title": "서울 AI 창업기업 사업화 지원",
      "organization": "서울경제진흥원",
      "summary": "AI 창업기업의 사업화를 지원합니다.",
      "categories": ["AI", "창업"],
      "regions": ["서울"],
      "targetDescription": "서울 소재 창업기업",
      "applicationPeriod": "상시 접수",
      "applicationStartDate": null,
      "applicationEndDate": null,
      "status": "OPEN",
      "sourceName": "기업마당",
      "sourceUrl": "https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_001",
      "matchedReasons": ["서울 소재 AI 창업기업의 사업화를 지원"],
      "recommendationScore": 95,
      "eligibilityReview": {
        "status": "MATCH",
        "basis": "OFFICIAL_API_TEXT",
        "target": {
          "status": "MATCH",
          "explanation": "사용자가 밝힌 창업기업 조건과 제공된 지원대상이 일치합니다.",
          "evidence": [{ "field": "TARGET_DESCRIPTION", "quote": "서울 소재 창업기업" }]
        },
        "region": {
          "status": "MATCH",
          "explanation": "본문이 서울 소재 기업을 지원대상으로 명시합니다.",
          "evidence": [{ "field": "TARGET_DESCRIPTION", "quote": "서울 소재 창업기업" }]
        }
      }
    }
  ]
}
```

기존 GET의 빈 검색어 조회는 AI Service를 호출하지 않으므로 `matchedReasons`는 빈 배열이고 `recommendationScore`는
`null`이며 `eligibilityReview`도 `null`입니다. 상세 GET도 사용자별 판정을 다시 실행하지 않으므로
`eligibilityReview`는 `null`입니다. 검색 결과의 판정은 DB에 저장하지 않습니다.

`eligibilityReview.status`는 두 축이 모두 `MATCH`일 때만 `MATCH`, 하나라도 `UNKNOWN`이면 `REVIEW_REQUIRED`입니다.
공개 추천에는 `INCOMPATIBLE`을 포함하지 않습니다. Frontend는 관련도순을 유지하고 각 카드에 자격 확인 상태를 표시합니다.
`basis=OFFICIAL_API_TEXT`는 수집한 공식 API 본문 기준이라는 뜻이며 첨부파일 검증·법적 신청 자격 확정이 아닙니다.

해석할 수 없는 시작·종료일은 각각 `null`입니다. 접수 상태는 파싱된 날짜와 서울 기준
오늘 날짜로 먼저 판단하고, 날짜만으로 판단할 수 없으면 접수 예정·종료·상시 접수 등의 문구를 사용합니다.
따라서 날짜가 `null`이어도 상태가 `OPEN`, `UPCOMING`, `CLOSED`일 수 있으며, 판단 근거가 없을 때 `UNKNOWN`입니다.
적격 공고가 없으면 `programs`는 빈 배열입니다. 원본에 없는 지원금액은 생성하지 않으며 `sourceUrl`로
공식 원문을 확인할 수 있습니다.

Frontend의 원문 URL 검증은 `BIZINFO`에 `bizinfo.go.kr`, `KSTARTUP`에 `k-startup.go.kr`, `MSIT`에
`msit.go.kr`, `CNTRADE_NOTICE`에 `cntrade.chungnam.go.kr`와 각 하위 도메인의 HTTP(S) URL을 허용합니다.
제공처/호스트 불일치, 위장 호스트, userinfo, 비표준 포트, 다른 스킴은
거부합니다. 알 수 없는 제공처나 잘못된 URL이 한 건이라도 포함되면 전체 응답을 거부하며 일부 공고만
남겨 성공으로 처리하지 않습니다. URL 허용은 원문 질문 지원이나 실제 제공처 정상 동작을 뜻하지 않습니다.
`CNTRADE_NOTICE` API에는 상세 URL이 없어 `sourceUrl`은 확인된 공식 공지 목록이며, 화면 링크도
**공식 공지 목록**으로 표시하고 제목으로 해당 글을 찾도록 안내합니다.

## 저장된 공고 필터 검색의 제공처

`GET /api/v1/support-programs/catalog`의 `sourceCode`는 빈 값(전체), `BIZINFO`, `KSTARTUP`, `MSIT`,
`CNTRADE_NOTICE`만 허용합니다. `startupStage`·`applicantType`·`founderAge`는 `KSTARTUP`에서만 유효합니다.
`status=OPEN`이 기본이며 MSIT·CNTRADE_NOTICE처럼 접수 기간이 없는 공고는 `status=UNKNOWN` 또는 `ALL`로
검색합니다. 출처 선택만으로 사용자의 접수 상태 필터를 자동으로 바꾸지 않습니다.
두 새 출처는 게시일을 접수 시작일로 쓰지 않고, API에 없는 지역·분야는 빈 배열을 유지합니다.
목록은 공개된 MySQL 스냅샷을 읽으며 제공처 API나 LLM을 요청마다 호출하지 않습니다.

## 공개 상세 조회

검색 결과의 `id`는 제공처 안에서의 원본 공고 ID입니다. 제공처가 다르면 같은 `id`가 존재할 수 있으므로,
상세 조회는 검색 응답의 `sourceCode`와 `id`를 각각 전달합니다. 두 값을 `{sourceCode}:{sourceProgramId}`처럼 하나의
문자열로 합치지 않아 URL 인코딩·구분자 충돌 없이 MySQL의 복합 원본 식별자와 정확히 대응합니다.

```http
GET /api/v1/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN_001
Accept: application/json
```

| Query parameter | 필수 | 설명 |
|---|---|---|
| `sourceCode` | 예 | 제공처 코드. `[A-Z][A-Z0-9_]{0,63}` 형식이며 최대 64자입니다. |
| `sourceProgramId` | 예 | 제공처가 부여한 원본 공고 ID. 공백일 수 없고 최대 255자입니다. 검색 응답의 `id`를 전달합니다. |

성공하면 `SupportProgramDetailResponse` 객체를 반환합니다. 검색 결과 한 건과 같은 공고 필드(`id`, `sourceCode`,
`title`, `organization`, `summary`, `categories`, `regions`, `targetDescription`, `applicationPeriod`,
`applicationStartDate`, `applicationEndDate`, `status`, `sourceName`, `sourceUrl`)에 `evidenceQuestionSupported`를
더한 형태입니다. 상세 조회에는 검색 질의가 없으므로 검색 전용 `matchedReasons`·`recommendationScore`·`eligibilityReview`는
포함하지 않습니다. `evidenceQuestionSupported`는 공식 원문 근거 질문을 지원하는 제공처(현재 `BIZINFO`)인지 서버가 정한 값이며,
화면은 제공처 코드를 직접 비교하지 않고 이 값으로 질문 입력을 보여 줍니다. `is_source_present = FALSE`인
과거 공고와 존재하지 않는 복합 식별자는 모두 다음의 안정적인 404 오류로 처리합니다.

```json
{
  "type": "urn:govbiz:problem:support-program-not-found",
  "title": "Support Program Not Found",
  "status": 404,
  "detail": "The requested support program does not exist or is no longer available.",
  "instance": "/api/v1/support-programs/detail",
  "code": "SUPPORT_PROGRAM_NOT_FOUND"
}
```

## 공개 공식 원문 근거 질문

목록 검색이나 상세 GET은 기업마당 상세 페이지를 수집하지 않습니다. 사용자가 특정 공고에 질문을 제출할 때만
다음 endpoint가 기업마당 공식 HTML 원문을 사용합니다. 현재 지원 제공처는 `BIZINFO`뿐이며, 현재 공개된
공고가 아닌 경우에는 원문 수집 전에 상세 조회와 같은 404를 반환합니다.
Frontend는 기업마당 상세에서 별도 `/support-programs/detail/question` 페이지로 이동해 명시적으로 질문을 제출합니다.
`KSTARTUP`을 포함한 비 `BIZINFO` 상세에서는 질문 링크 대신 미지원 설명과 기존 원문 링크를 표시하며,
질문 페이지에 직접 접속해도 근거 질문 HTTP 요청을 보내지 않습니다. 서버의 미지원 제공처 422 계약도 유지합니다.

```http
POST /api/v1/support-programs/detail/answers
Content-Type: application/json
Accept: application/json

{
  "sourceCode": "BIZINFO",
  "sourceProgramId": "PBLN_001",
  "question": "신청 대상은 누구인가요?"
}
```

| Body field | 필수 | 설명 |
|---|---|---|
| `sourceCode` | 예 | 상세 조회와 같은 제공처 코드. 현재 공식 원문 질문은 `BIZINFO`만 지원 |
| `sourceProgramId` | 예 | 상세 조회와 같은 최대 255자 원본 공고 ID |
| `question` | 예 | 요청값 최대 500 UTF-16 코드 단위. 앞뒤 공백을 제거해 처리하며 비어 있을 수 없음 |

성공 응답은 다음 형태입니다. 예시의 문장은 형식 설명용이며, 실제 `answer`는 해당 요청에서 검색된 공식 원문
청크에만 근거합니다.

```json
{
  "answer": "공식 원문에 적힌 신청 대상을 안내합니다.",
  "answerStatus": "ANSWERED",
  "citations": [
    {
      "excerpt": "공고 원문에서 답변 근거가 된 발췌문",
      "sourceUrl": "https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_001",
      "chunkOrder": 0
    }
  ]
}
```

| 응답 필드 | 설명 |
|---|---|
| `answer` | 한국어 근거 답변 또는 근거 부족 안내. 최대 1,200자 |
| `answerStatus` | `ANSWERED` 또는 `INSUFFICIENT_EVIDENCE` |
| `citations` | 최대 5개. `excerpt`는 선택한 원문 청크 전체(최대 1,500 UTF-16 코드 단위), `sourceUrl`은 기업마당 공식 원문 URL, `chunkOrder`는 0부터 시작하는 원문 청크 순서 |

`ANSWERED`에는 하나 이상의 `citations`가 반드시 있고, `INSUFFICIENT_EVIDENCE`에는 인용이 없습니다.
Core는 인용 청크가 이 질문에서 실제로 검색된 최대 5개 청크 중 하나인지 확인합니다. 따라서 답변은
전달되지 않은 원문 구간이나 다른 공고의 원문을 인용할 수 없습니다.

원문 캐시가 없거나 같은 URL의 수집 시각이 6시간보다 오래된 경우에만 Core가 공식 HTTPS 기업마당 상세 HTML을
다시 읽습니다. 리디렉션은 각 이동 URL의 공식 HTTPS 호스트와 동일한 `pblancId`를 검증해 최대 3회 따르며,
순환 이동·HTML 이외 응답·공식 호스트가 아닌 URL·비 HTTPS URL·크기 제한 초과 원문은 거부합니다.
HTML은 최대 500KB로 읽고 jsoup `1.23.2`로 파싱합니다. `.support_project_detail`의 `.title_area .title`이
요청 공고 제목과 일치할 때 `.view_cont` 본문만 추출하며, 정규화 본문은 최대 30,000자입니다.
성공적으로 정규화한 텍스트만 MySQL에 저장하고, 최대 50개 결정적 청크를 일반 공고 검색과 분리된 Qdrant evidence
컬렉션에 색인합니다. 이 작업은 공고 동기화와 목록 검색에 포함되지 않습니다. 첨부파일·PDF·OCR·다른 제공처
원문은 현재 지원하지 않습니다.

### 내부 원문 근거 API

Core만 아래 AI Service endpoint를 호출합니다. 브라우저에 공개하지 않으며, 일반 공고 검색의
`/internal/v1/support-program-index/*` 컬렉션·계약과 분리됩니다.

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `PUT /internal/v1/support-program-evidence/chunks` | `chunks`: `{id, contentHash, documentId, order, text}` 1~50개 | `indexedCount` |
| `POST /internal/v1/support-program-evidence/search` | `question`, `eligibleChunks`: `{id, contentHash, documentId, order}` 1~50개, `limit` 1~5 | `question`, `matches`: 청크 ID·해시·문서 ID·순서·유사도 |
| `POST /internal/v1/support-program-evidence/answers` | `question`, 검색 완료 청크 `{id, documentId, order, text}` 1~5개 | `answer`, `answerStatus`, `citationChunkIds` |

청크 `id`와 `contentHash`는 각각 소문자 SHA-256 64자리이고 `documentId`는
`{sourceCode}:{sourceProgramId}`입니다. AI Service와 Core는 같은 청크 ID·해시·문서 ID·순서가 유지되는지,
검색 결과 수·점수 순서·인용 범위를 다시 검증합니다. 답변 Agent는 전달받은 청크의 텍스트 밖 정보를 사용하지
않도록 지시되며, Core도 `ANSWERED`의 인용 누락과 `INSUFFICIENT_EVIDENCE`의 인용 포함을 계약 위반으로 거부합니다.

LLM 전용 입출력은 HTTP 계약과 다릅니다. Agent는 해시 ID 대신 요청 배열의 `index`와 텍스트를 전달하고,
모델의 `citationChunkIndexes`를 범위·중복·상태 검증 후 원래 64자리 `citationChunkIds`로 복원합니다.
클라이언트는 계속 위 HTTP 계약을 사용하며 `index`를 보내거나 받을 필요가 없습니다.

## 전체 카탈로그 후보 검색

검색어가 있으면 Core는 `findSearchablePresent`에서 현재 노출 공고와 `support_program_sync_status`를
`source_code`로 JOIN하여 `index_ready=true`인 제공처의 공고만 읽고 접수 상태를 적용합니다.
그 전체 허용 목록의 ID·검색 텍스트 해시를 AI Service에 보내고, Qdrant의 의미 검색으로 최대 20개를
선택합니다. 최신순 21번째 이후의 공고도 후보가 될 수 있습니다. 빈 검색어만 최신순 최대 5개를 반환합니다.
신규 평가 fixture/capture도 같은 색인 준비 범위를 사용합니다. 빈 검색어 최신 목록은 `findPublishedPresent`로
공개 세대·지문이 있는 DB 스냅샷을 읽으며, 공개 이후 색인 장애가 나도 기존 목록을 유지합니다. 아직 공개되지
않은 제공처나 미채택 legacy 데이터는 최신 목록에도 포함하지 않습니다. 자연어 검색에서 모든 제공처의 색인이
불가하고 이전 공개 스냅샷 또는 미복구 legacy 공고가 있으면 빈 결과 대신 `503 AI_SERVICE_UNAVAILABLE`입니다.
최초 빈 DB나 준비된 제공처의 정상 0건 스냅샷은 기존 빈 결과를 유지합니다. 일부 제공처만 준비되었으면 준비된
제공처만 검색하며 그 범위 안에서 발생한 AI·벡터 오류도 기존처럼 명시적으로 반환합니다.
기존 고정 평가 스냅샷·판정 원표·캡처의 의미와 지표는 변경하지 않습니다.

내부 색인 API는 다음 세 가지입니다. 공개 브라우저 API가 아니며 FastAPI 내부 포트에서만 제공합니다.

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `PUT /internal/v1/support-program-index/batch` | `documents`: `{id, contentHash, text}` 최대 50개 | `indexedCount`: 이미 존재하는 버전 포함 확인된 개수 |
| `POST /internal/v1/support-program-index/prune` | `sourceCode`, 현재 `documents`: `{id, contentHash}` | `retainedCount` |
| `POST /internal/v1/support-program-index/search` | `query`, `eligibleDocuments`: `{id, contentHash}`, `limit`(1~20) | `query`, `matches`: `{id, contentHash, score}` |

색인·점수화 경계의 `id`와 `programId`는 `{sourceCode}:{sourceProgramId}`로 구성합니다. 첫 번째 `:` 앞의
`sourceCode`는 `[A-Z][A-Z0-9_]{0,63}` 형태의 안정적인 제공처 코드이고, 뒤의 원본 ID는 전체 문자열로 유지합니다.
원본 ID는 비어 있거나 앞뒤 공백이 있을 수 없고, 최대 255개 Unicode code point이며 Unicode `C` 범주 문자를 포함할 수
없습니다. 첫 번째 구분자 뒤의 추가 `:`는 원본 ID의 일부로 유지합니다.
`contentHash`는 전달한 검색 텍스트의 UTF-8 SHA-256 소문자 64자리이며 공개 응답 ID나 DB `content_hash`와는
별개의 색인 계약입니다. 검색 텍스트는 최대
12,000자로 제한하고 임베딩 입력은 모델 토큰 제한 내에서 잘라 사용합니다. 검색·정리 허용 목록은 최대 20,000개입니다.
오늘 날짜에 따라 달라지는 상태는 텍스트에 고정하지 않고 Core가 조회 시 계산합니다.

기업마당 동기화는 수집 전에 MySQL에서 시작 세대를 발급받고, 전체 수집·검증 및 모든 색인 배치를
성공한 뒤 최신 시작 세대일 때만 새 MySQL 카탈로그를 공개합니다. 공개 transaction은 공고 교체와 함께
공개 세대·카탈로그 지문·공고 수·`indexReady=true`·성공 시각도 기록합니다. 더 최근에 시작한 작업이 있으면
이전 작업의 공개·실패 기록을 모두 건너뜁니다. 현재 세대의 수집 또는 사전 색인 실패는 이전 공개 스냅샷을
바꾸지 않고 실패 시각만 기록합니다. 별도 기본 `PT1M` 스케줄러는 이미 공개된 공고의 누락 벡터만 복구합니다.
복구는 제공처별로 수행하며 한 제공처 실패 이후에도 다른 제공처를 처리하고, 완료 후 실패를 오류로 전달합니다.
복구의 성공·실패는 자신이 읽은 세대·지문·공고 수가 상태 행과 아직 같을 때만 `indexReady`를 바꾸므로,
늦게 끝난 복구가 새 스냅샷 준비 상태를 덮지 못합니다.
두 경로 모두 `prune`을 호출하지 않으며, 정확한 현재 ID·해시 필터가 오래된 벡터를 검색에서 제외합니다.
`prune` API는 남아 있지만 다중 인스턴스·동시 실행의 안전한 정리를 보장하지 않습니다. 이전 버전·미공개
세대의 벡터 정리는 진행 중인 작업과 검색을 보호하는 보존·삭제 수명주기를 마련한 뒤 구현할 후속 과제입니다.

Core는 반환된 ID가 허용 목록에 있고 내용 해시가 일치하는지, 중복·비정상 점수·질의 echo
불일치가 없는지 검증합니다. 현재는 관련성 탈락 기준이 없으므로 결과 개수도 `min(20, 허용 공고 수)`와
정확히 같아야 합니다. Qdrant 유사도 점수는 내부 후보 선정에만 사용하며, 공개 `recommendationScore`는
기존 Agent 평가 점수입니다. 둘 다 선정 확률이 아닙니다.

색인 누락·임베딩·Qdrant 장애는 정상 빈 결과나 최신 목록으로 대체하지 않고 오류로 반환합니다. AI 점수화는
지원대상·지역의 명백한 불일치를 제외하고 의미 관련성 20점 최소 기준을 통과한 공고를
최대 5개 반환하며, 적격 공고가 없을 때의 빈 목록은
정상 성공 응답입니다. 원문 근거 질문은 위의 별도 endpoint이며 이 목록 검색 경로의 동작을 바꾸지 않습니다.
후보·최종 추천 비교를 위한 [검색 평가 자료와 실행 도구](../evaluation/support-program-search/README.md)를
추가했습니다. `evaluation-fixture-export`는 공개 API가 아닌 비웹 실행 프로필이며, 현재 MySQL에서 색인 준비된
제공처의 `OPEN` 공고를 운영 색인과 같은 ID·내용 해시·검색 문서로 미라벨 fixture 초안에 기록합니다.
`evaluation-capture`는 사람이 fixture에 질문·정답을 라벨링한 뒤 fixture와 같은 `referenceDate`에서 현재 Search
Service가 만든 후보 최대 20개와 최종 추천 최대 5개의 ID를 기록합니다. 기준 날짜는 실행 시점의 오늘이 아니라
신청 시작·종료일로 접수 상태를 다시 계산하는 날짜이며, fixture와 capture가 다르면 평가기가 거부합니다.
실제 공고·임베딩 모델을 사용한 추천 품질의 **측정 결과**는 사람이
검토한 정답 라벨을 아직 만들지 않았으므로 아직 없습니다.

## 비밀정보와 오류 처리

검색과 근거 답변은 같은 공개 요청 한도를 사용합니다. 기본값은 한 Core 프로세스에서 접속 주소별
최근 60초 6건·전체 60건·동시 4건입니다. 요청량 초과는 429, 동시 한도 초과는 503이며
`Retry-After` 헤더와 `retryAfterSeconds` 본문 필드(동일한 정수 1~60)를 제공합니다.
두 오류는 `Cache-Control: no-store`이고, 거절된 요청은 DB·외부 호출을 시작하지 않습니다.
상세 정책과 프록시·다중 서버 한계는 [요청 제한 계약](support-program-request-limits.md)에 있습니다.

`DATA_GO_KR_SERVICE_KEY`는 기업마당 동기화를 위해 Core에, `OPENAI_API_KEY`는 AI Service에만
주입합니다. 기업마당 동기화 실패는 사용자 검색 요청의 오류가 아니라 백그라운드 동기화 실패로
처리하며, 이전 MySQL 카탈로그가 있으면 계속 검색합니다. 첫 동기화 전이거나 카탈로그가 비어 있으면
검색은 HTTP 200과 빈 `programs` 배열을 반환합니다. 외부 오류 본문, 사용자 질의나 인증키는 공개 오류에
포함하지 않습니다.

| 상황 | HTTP | `code` |
|---|---:|---|
| 검색·근거 답변의 주소별 또는 전체 요청량 한도 초과 | 429 | `SUPPORT_PROGRAM_RATE_LIMITED` |
| 검색·근거 답변의 동시 처리 한도 초과 | 503 | `SUPPORT_PROGRAM_BUSY` |
| `query`가 500자를 초과함 | 400 | `REQUEST_VALIDATION_FAILED` |
| `query`에 NUL·제로폭 문자 등 허용되지 않은 제어·형식 문자가 있음 | 400 | `REQUEST_VALIDATION_FAILED` |
| POST 검색문이 비어 있거나 회사 조건의 길이·제어문자·설립일 검증을 위반함 | 400 | `REQUEST_VALIDATION_FAILED` |
| 상세 조회의 `sourceCode`·`sourceProgramId`가 누락·형식·공백·길이 제한을 위반함 | 400 | `REQUEST_VALIDATION_FAILED` |
| 원문 근거 질문의 `sourceCode`·`sourceProgramId`·`question`이 누락·형식·공백·길이 제한을 위반함 | 400 | `REQUEST_VALIDATION_FAILED` |
| 상세 조회 대상이 없거나 현재 제공처 목록에서 사라짐 | 404 | `SUPPORT_PROGRAM_NOT_FOUND` |
| 현재 공고의 제공처가 원문 근거 질문을 지원하지 않음 | 422 | `SUPPORT_PROGRAM_EVIDENCE_NOT_SUPPORTED` |
| 기업마당 공식 원문 수집·검증 실패 | 503 | `SUPPORT_PROGRAM_EVIDENCE_UNAVAILABLE` |
| AI Service의 예상하지 못한 HTTP 응답·응답 계약 위반 | 502 | `AI_SERVICE_UPSTREAM_ERROR` / `AI_SERVICE_INVALID_RESPONSE` |
| AI Service 연결 불가·내부 503 응답 | 503 | `AI_SERVICE_UNAVAILABLE` |
| Elasticsearch 연결 실패·색인 버전 누락·잘못된 키워드 응답 | 503 | `SUPPORT_PROGRAM_SEARCH_INDEX_UNAVAILABLE` |
| AI Service 호출 시간 초과·내부 408/504 응답 | 504 | `AI_SERVICE_TIMEOUT` |
| 현재 허용 공고의 색인 미완료 또는 Qdrant·임베딩 실패 | 503(내부 시간 초과 분류에 따라 504) | `AI_SERVICE_UNAVAILABLE` / `AI_SERVICE_TIMEOUT` |

랭킹의 모델·Agent 시간 초과는 내부 504로 구분한다. Web은 검색 응답의 유효한
`504 AI_SERVICE_TIMEOUT` Problem 계약에 한해 시간 초과를 안내하며, 수동 재시도 시 확인한 조건을
유지한다. 잘못된 오류 계약이나 출처 불명의 504 응답은 기존 일반 오류로 처리한다.
기본 시간 예산과 검증 범위는 [랭킹 시간 초과 수정](support-program-ranking-timeout-fix.md)을 참고한다.

테스트는 가짜 Agent·임베딩과 HTTP mock을 사용하며 실제 OpenAI 호출을 수행하지 않습니다. CI에서는
실제 Qdrant 서버와 MySQL로 저장·검색·미노출·복구 경로를 검증합니다. 이는 실제 임베딩 모델의 검색 품질 측정과 다릅니다.
