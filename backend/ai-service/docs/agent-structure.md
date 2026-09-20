# AI Agent 모듈 구조

## 현재 구조

이 문서는 AI 대화 검색과 상세 질의응답을 담당하는 세 Agent를 설명합니다. 공고 임베딩·Qdrant 색인·후보 검색과
상세 원문 청크 색인·근거 검색은 Service가 직접 처리하며 별도 Agent가 아닙니다.

```text
support_program_ranking/
├── router.py   # 내부 HTTP와 안전한 오류 변환
├── models.py   # 후보·점수 structured schema
├── prompt.py   # 평가 기준과 안전 지시
├── agent.py    # LangChain 프롬프트 체인 실행
├── service.py  # 후보 집합 검증과 최소 기준 필터
└── errors.py   # 기능 실행 실패 경계
```

이 Agent는 사용자 질문을 키워드 배열로 바꾸는 것이 아니라, Core가 전달한 공식 후보 전체를 버전된
규칙으로 점수화합니다.

```text
HTTP router
→ SupportProgramRankingService
→ SupportProgramRecommendationAgent
→ LangChain ChatPromptTemplate → ChatOpenAI → OpenAI Responses API (1회)
→ SupportProgramRankingOutput
→ exact candidate ID·공식 API 본문 인용·본문 절단 시 UNKNOWN 검증
→ 지원대상·지역 INCOMPATIBLE 제외
→ 의미 관련성 20점 기준 필터 후 관련도순 Response (합계 0~5개, UNKNOWN은 확인 필요 표시)
```

현재 계약 버전은 `govbiz-support-program-ranking-v5`입니다. 관련도는 `2 × (semanticRelevance + supportTypeFit)`로
계산하며 자격 미확인은 관련도 감점 사유가 아닙니다. 후보 `id`와 응답 `programId`는
`sourceCode:sourceProgramId` 형태의 정규 식별자이며, 서로 다른 제공처가 같은 원본 ID를 사용해도
별개 후보로 검증합니다. `targetEligibility`와 `regionEligibility`는
`MATCH`, `INCOMPATIBLE`, `UNKNOWN` 중 하나이며, 정보 부족을 뜻하는 `UNKNOWN`은 자동 제외하지 않습니다.
순위화 Agent는 공고 단위 점수·추천 이유와 SUMMARY/TARGET_DESCRIPTION 자격 인용·판정 설명을 반환합니다.
모델에는 전체 본문과 후보별 `evidenceOptions`를 전달하고 인용 문구 대신 번호만 받습니다.
`agent.py`의 `build_evidence_options`는 제어문자를 경계로 나누고 긴 연속 구간을 최대 240자·최소 60자 겹침의
원문 조각을 끝까지 생성합니다. `_assessment_selection_type`은 후보의 선택지 수로 번호 범위를
제한합니다. Agent가 모든 후보의 번호를 해당 후보의 정확한 field/quote로 복원한 뒤 기존 Service의
원문 검증을 수행하므로 기존 인용 형식은 HTTP v5에서도 그대로입니다. 잘못된 번호는 후보를 버리거나 보정하지 않고 오류로 반환합니다.
자격 UNKNOWN인 후보도 관련도순 정렬에 유지하며, 명백한 불일치와 의미 관련성 최소 기준으로만 제외합니다.
공식 API 요약의 자격 인용이며 첨부 PDF/HWP를 읽은 최종 자격 판정은 아닙니다. 상세 원문 검색과 근거 문단 인용 답변은
아래 `support_program_evidence` 수직 기능이 담당합니다.

## 상세 공고 근거 답변 Agent

`support_program_evidence`는 공식 상세 공고 원문 청크에서 질문에 필요한 근거를 찾고 답변하는 별도 수직
기능입니다. Qdrant에는 청크 벡터와 ID·내용 해시·문서 ID·순서·공식 원문 text를 저장하며, Agent에는 Core가 검색 결과로
선택한 공식 text 1~5개만 전달합니다.

```text
HTTP router
→ SupportProgramEvidenceService
→ OpenAI Embeddings + 별도 evidence Qdrant collection
→ 지정 eligibleChunks 안에서 최대 5개 근거 검색
→ Core가 해당 text만 answers API에 전달
→ SupportProgramEvidenceAnswerService
→ SupportProgramEvidenceAnswerAgent
→ LangChain ChatPromptTemplate → ChatOpenAI → OpenAI Responses API (1회)
→ SupportProgramEvidenceAnswerOutput
→ citationChunkIds가 입력 청크 ID의 부분집합인지 재검증
→ ANSWERED 또는 INSUFFICIENT_EVIDENCE 응답
```

Answer Agent는 한 번의 typed structured output 호출만 사용하며 tool·handoff·외부 검색을 사용하지
않습니다. 프롬프트는 청크에 포함된 명령을 데이터로 취급하고, 제공된 text로 직접 확인할 수 없는
외부 지식·추측을 쓰지 않도록 요구합니다. `ANSWERED`에는 하나 이상의 고유 인용 ID가 필요하고,
`INSUFFICIENT_EVIDENCE`에는 인용이 없어야 합니다. Service는 상태 규칙 외에도 Agent가 입력에 없던
청크 ID를 인용하지 않았는지 확인합니다.

## 확인 전 검색 조건 해석 Agent

`support_program_conversation`의 구체 `SupportProgramConversationAgent`는 순위화나 상세 근거 답변과
구분되는 역할입니다. router/models/prompt/agent/service/errors 배치는 기존 기능과 같습니다.

`HTTP API → SupportProgramConversationService → SupportProgramConversationAgent → LangChain → OpenAI → Response`

현재 메시지·확정 context·선택적인 마지막 질문과 draftContext 또는 pendingProposal·최근 성공 검색 요약
lastSearch·Core 기준일을 입력합니다. LangChain 단일 호출은 최대 7개 SET/CLEAR 패치와
READY/CLARIFICATION_REQUIRED를 선택하거나 변경 없는 ANSWERED로 검색 결과를 설명합니다.
Service는 현재 메시지 exact evidence·명시적 전체 날짜·패치 중복·병합 후 날짜 및 READY query를 검증합니다.
ANSWERED는 빈 updates와 유효한 answer만 허용하며 검색·조건 적용을 실행하지 않습니다. 결과 수만으로
공고 부재·마감 같은 원인을 창작하지 않으며, 실제 자연어 해석 품질은 고정 모델 테스트와 별도로 검토합니다.
부재 필드는 코드로 보존하며 보류 중인 초안이 있으면 그 상태에서 이어갑니다. 모델이 전체 상태를 다시 쓰거나
다른 Agent·임베딩·검색을 호출하지 않습니다. 사용자 확인 후 기존 검색 API를 별도로 호출하는 책임은 Web/Core에 있습니다.
같은 client/model을 사용하고 store=false/tracing 비활성입니다. 조건 해석과 근거 답변의 모델·HTTP 제한은
25초, 전체 Agent 제한은 30초입니다. 순위화의 별도 제한은 공유 client의 기본 timeout을 변경하지 않습니다.
대화 세션·graph·handoff·provider는 없습니다.
패치 인용 검증은 의미 정확도를 보증하지 않으며 옛 지역 query 제거 등의 의미 회귀는 별도 실제 모델 평가가 필요합니다.

세 Agent가 공유하는 `support_program_llm.py`는 프롬프트 템플릿·모델 바인딩·실행과 응답 검증만 담당합니다.
LangChain `ChatPromptTemplate`에 시스템 지침과 JSON payload를 별도 메시지로 넣고 `ChatOpenAI`에 연결합니다.
OpenAI의 strict 스키마 변환은 `$defs`를 유지해 후보별 동일 스키마의 중복 전송을 피합니다.
반환은 완료 상태·거부·도구 호출을 검사한 뒤 원문 JSON 전체를 Pydantic strict 모드로 검증합니다.
부분 JSON 자동 복구, 인용 번호 형변환, 재시도나 정상 응답을 가장하는 fallback은 없습니다.
검색·생성 경계는 Core에 남아 있고 검색 결과만 생성 프롬프트에 전달하는 RAG입니다.

## 계층 규칙

- `router`는 HTTP와 안전한 오류 변환만 담당합니다.
- `service`는 Agent를 주입받고 후보 집합·정렬 규칙을 검증한 뒤 최소 기준을 통과한 결과만 반환합니다.
- `agent`는 LangChain 실행·timeout·모델 오류 변환을 담당합니다.
- `models`는 요청과 structured output 불변식을 담당합니다.
- `prompt`는 LLM에 전달할 평가 지시를 담습니다. 점수 범위·합계는 `models`, 반환 최소 기준은 `service`에서도 검증합니다.
- `bootstrap`만 OpenAI client, model, Agent와 Service를 조립합니다.

상세 근거 기능에서는 `SupportProgramEvidenceService`가 OpenAI 임베딩과 Qdrant를 직접 사용하고,
`SupportProgramEvidenceAnswerService`만 Answer Agent를 주입받습니다. 이 분리는 벡터 검색 결과의
현재 ID·내용 해시·문서 ID 검증과, 답변 인용 집합 검증의 책임을 명확히 하기 위한 현재 기능 범위의 분리입니다.
두 색인 Service의 입력 토큰 상한 처리는 `support_program_embedding.py`의 함수 하나를 공유하며,
이 CPU 작업은 `asyncio.to_thread`로 실행합니다. 외부 API 호출·응답 검증·오류 경계는 각 Service가 유지합니다.

후보 원문은 신뢰할 수 없는 데이터입니다. 프롬프트는 후보 안의 명령을 따르지 않도록 명시하고,
Agent는 tool이나 handoff 없이 LLM을 한 번 호출합니다. Core와 AI Service는 모두 존재하지 않는 공고 ID와
잘못된 점수 합계를 거부합니다.

순위화는 모델·요청별 HTTP 45초, 전체 실행 50초의 제한을 기본 사용합니다. `AgentTimeoutError`를
안전한 504로, 그 밖의 `AgentExecutionError`를 기존 503으로 반환합니다. router는 실패 종류·고정
`AgentFailureCode`·오류 클래스명·후보 수·경과 시간만 기록하며 입력·응답·원문 예외·traceback을 로그에 넣지 않습니다.
고정 코드는 후보 집합·절단 본문 판정·근거 누락·원문 인용 불일치·출력 타입·인용 번호 복원의 실패 지점을 구분할 뿐,
판정 규칙·정합성 검증·공개 응답을 변경하지 않습니다.
클라이언트 자동 재시도와 fallback은 추가하지 않습니다.

## 새 Agent를 추가하는 기준

파일을 나누기 위해 Agent를 추가하지 않습니다. 다음처럼 독립된 목표·입력·도구·평가 기준이 생길 때
새 수직 슬라이스를 만듭니다.

- 여러 공고를 비교해 차이를 설명하는 비교 Agent
- 검색된 상세 공고와 사용자의 기업 정보를 함께 읽어 준비 서류를 정리하는 안내 Agent

지역 Agent, 카테고리 Agent, API 출처별 Agent처럼 단순 함수나 adapter를 억지로 Agent로 만들지
않습니다. 위 예시는 향후 분리 여부를 판단할 기준이며 현재 구현 기능이 아닙니다. 대화 상태, 분기·반복,
중단·재개가 실제로 필요해질 때 상태 관리와 실행 조율 방식을 검토합니다. 이 세 Agent는 tool·handoff·graph를 사용하지 않습니다. 별도 도우미 도구 Agent는 LangGraph를 사용합니다.

## 테스트 배치

```text
tests/
├── support_program_index/
│   ├── conftest.py
│   ├── test_router.py
│   └── test_service.py
├── support_program_ranking/
│   ├── test_agent.py
│   ├── test_evidence_options.py
│   ├── test_evidence_selection.py
│   └── test_router.py
├── support_program_evidence/
│   ├── conftest.py
│   ├── test_agent.py
│   ├── test_router.py
│   ├── test_service.py
│   └── test_langchain_rag.py
├── support_program_conversation/
│   ├── test_models.py
│   ├── test_agent.py
│   ├── test_service.py
│   ├── test_router.py
│   └── test_compose_stub.py
├── langchain_stub.py
├── test_support_program_llm.py
├── test_bootstrap.py
├── test_config.py
├── test_support_program_embedding.py
└── test_health.py
```

- Agent 테스트: 실제 LangChain 체인 + Responses HTTP 스텁, strict OpenAI wire 계약
- 인용 선택 테스트: 원문 조각의 전체 구간·Unicode 보존, 후보별 번호 범위 및 원문 복원, 20개의 서로 다른 선택지 수를 가진 전송 스키마
- 순위화 API 테스트: 요청 검증, 정렬, 후보 ID 위조·누락 거부, 자격 불일치 제외, timeout 504/기타 503와 안전한 실패 로그
- 색인 테스트: 고정 임베딩 HTTP 응답과 Qdrant로 색인·현재 해시 필터·누락 및 장애 처리 검증
- 상세 근거 테스트: 별도 collection, 현재 청크 전량 색인, 교차 문서 ID 재사용 차단, strict Agent 출력·인용 집합 검증
- 조건 변경 테스트: UTF-16·날짜·필수 nullable 키, 실제 LangChain strict schema, 현재 메시지 인용, 부재 필드 보존·초안 병합, 안전한 오류·대역 계약
- bootstrap 테스트: 단일 client/model/Agent/Service 객체 그래프와 종료 시 client close, 순위화 전용 시간 제한 주입
- 공유 임베딩 전처리 테스트: 두 Service의 토큰화가 이벤트 루프 밖에서 실행되고 입력 순서·토큰 상한을 유지하는지 확인

테스트의 고정 모델 응답과 임베딩 벡터는 동작·계약 검증용입니다. 실제 한국어 질문의 검색 정확도나
모델의 자격 판단 정확도를 측정한 결과는 아닙니다.
실제 LangChain과 MockTransport로 순위화 HTTP 제한 45초 및 같은 client/model의 해석·근거 요청 25초 보존을 검증합니다.
