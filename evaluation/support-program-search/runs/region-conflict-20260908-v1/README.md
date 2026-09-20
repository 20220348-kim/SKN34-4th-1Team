# 지역 충돌 판정 회귀 검증 — 2026-09-08

결과는 baseline 54/54, 1차 보완 53/54입니다. 별도 사업장 미확인을 잘못 제외한 실패를 보존하고
[v2](../region-conflict-20260908-v2/README.md)로 이어갑니다. `search/`는 최초에 예약한 실제 검색
1회 자리를 최종 주체 우선 보완 뒤 사용한 결과입니다. `final_agent.py`·`final_prompt.py`는 그때의
소스이며 v1/v2 합성 평가 소스와 다릅니다. 최종 HTTP 200·36.517초, 안산 제외·전국 공고 유지·
개인 지역 UNKNOWN 보존을 확인했습니다. 전체 변경·한계는 [최종 기록](../../../../docs/region-conflict-fast-20260908.md)에 있습니다.

회사 소재지가 서울인데 안산 한정 공고를 `UNKNOWN`으로 남기는 오류와, 그 수정이 기존 지역 판정을
훼손하는지 확인하는 개발용 고정 실험입니다. 합성 기대값은 AI가 사전에 작성했으며 사람 검증 정답이나
독립 heldout 평가가 아닙니다. 결과를 보고 기대값을 바꾸지 않습니다.

## 고정 자료와 예산

- `fixture.json`: 합성 공고 18개, 확인된 회사 지역 3개(서울·서울 강남구·경기 안산시), 총 54개 지역 기대값.
- 포함 관계와 명백한 타지역 충돌, `관내` 지원대상, 전국 태그와 본문 불일치, 원문 미기재, 행사·기관 주소,
  이전 허용 OR, 본점·공장의 별도 경로, 개인 거주지, 원문 절단, 복수 허용 지역을 구분합니다.
- 공개 검증은 기존 [v5 공개 요청](../search-precision-v5-20260907-v1/request.json)의 공고 20개를 그대로 사용합니다.
- baseline: 합성 질문 3회. after: 동일 합성 질문 3회 + 서울 SW 사업화 지원금 공개 후보 평가 2회.
- 모델은 `gpt-5.6-sol` / `low` / `service_tier=priority`로 고정합니다. 후보 수나 기존 v5 점수 기준은 줄이지 않습니다.
- 랭킹 시도 최대 8회, 재시도 0회, HTTP/모델 제한 45초, Agent 50초, 최대 출력 10,000토큰, 1턴,
  `store=false`, 추적 비활성입니다. 요청별 새 Agent와 Service를 사용해 정확 응답 캐시를 우회합니다.
- 별도 실제 검색 확인은 `run-search.py`에서 공개 확인 검색을 최대 1회 수행하며, 이에 필요한 임베딩
  최대 1회·랭킹 최대 1회를 사용합니다. `run.py`는 임베딩이나 검색 API를 호출하지 않습니다.
  승인 총 10회를 각각 랭킹 8회와 실제 검색 2회로 나눕니다.

`baseline_agent.py`와 `baseline_prompt.py`는 수정 전 스냅샷이며, `after_agent.py`와 `after_prompt.py`는
v1 수정 후 실제 실행 당시 스냅샷입니다. 각 모듈의 두 프롬프트 상수를 해당 저장 프롬프트로 고정하므로
상대 import가 이후 production 프롬프트를 읽는 문제를 방지합니다. 테스트는 after의 소스 해시 및
모의 재실행 입력·프롬프트·schema 해시가 v1의 실제 실행 기록과 모두 같은지 확인합니다.
합성 정답·판정 이유·필수 근거 라벨은 기존 `evaluate-region-eligibility.py`의 `build_requests`에서 제거하며,
모델에는 production 요청 필드와 후보 원문의 인용 선택지만 전송합니다.

## 무료 검증

저장소 루트에서 실행합니다. 기본 실행은 계획만 출력하며 API 호출과 자격증명 읽기가 없습니다.

```bash
backend/ai-service/.venv/bin/python evaluation/support-program-search/runs/region-conflict-20260908-v1/run.py
backend/ai-service/.venv/bin/python evaluation/support-program-search/runs/region-conflict-20260908-v1/run-search.py
backend/ai-service/.venv/bin/python -m pytest evaluation/support-program-search/runs/region-conflict-20260908-v1/test_region_conflict_runner.py
backend/ai-service/.venv/bin/python -m pytest evaluation/support-program-search/runs/region-conflict-20260908-v1/test_search.py
backend/ai-service/.venv/bin/python -B -m unittest discover -s evaluation/support-program-search -p 'test_*.py'
```

`--execute --offline`은 MockTransport만 사용합니다. offline 출력과 원장은 live 기록과 분리되며 Git에
포함하지 않습니다. 테스트는 임시 경로에서 모의 호출하고 결과·가드·실패 보존만 확인하므로, 모델 품질을
검증한 것으로 표시하지 않습니다.

유료 실행은 승인된 한도 안에서만 `--execute --phase baseline` 또는 `--execute --phase after`와
`--key-file .env`로 수행합니다. 공식 HTTPS `api.openai.com/v1/responses` POST만 허용하고 다른 주소,
redirect, proxy, 변경된 모델·토큰·tier·입력·프롬프트·schema를 거부합니다. 키와 헤더 또는 외부 오류 원문을
저장하지 않습니다. `ledger-live.jsonl`은 시도 전에 fsync하며, 단계 재실행과 8회 초과를 거부합니다.
실패 시도도 소모된 시도로 보존하며 결과나 원장을 삭제해 재실행하지 않습니다.

## 결과 읽기

- `output/{phase}/manifest.json`: 실행 설정·소스 해시·시도와 실제 호출 수. `status=completed`는 모든 API
  실행이 끝났다는 뜻이며 품질 통과를 의미하지 않습니다.
- `requests.json`, `capture.json`: 실제 입력과 모든 후보의 필터 전 판정, 최종 추천을 보존합니다.
- `usage.json`: 허용된 토큰 수·실제 응답 tier·응답 상태·시간·전송 해시만 기록합니다.
- `regional-capture.json`, `report.json`: 기존 지역 평가기로 54개 기대 자격과 원문 근거를 비교합니다.
  보고서 `passed`를 별도로 확인해야 합니다. 실행 실패를 무결과 추천이나 품질 0점으로 바꾸지 않습니다.
- `public-checks.json`: 안산 한정 `BIZINFO:PBLN_000000000125900`의 지역 `INCOMPATIBLE` 및 추천 제외를
  확인하고, 대구 소재 **또는 이전** 허용 `BIZINFO:PBLN_000000000124940`은 `UNKNOWN`을 유지하는지
  분리합니다. 이전 가능 공고를 도시 태그만으로 일괄 제외하면 안 됩니다.

고정 후보의 소규모 개발 회귀 검사입니다. 전체 카탈로그 Recall, 실제 신청 자격, 운영 p95 또는 모든
질문의 정확도를 입증하지 않습니다. 합성 기대값과 공개 공고의 AI 초안 판정은 사람 검토 정답이 아닙니다.

v1에서 발견한 명시적 별도 사업장 OR 경로의 회귀는 [v2](../region-conflict-20260908-v2/README.md)에서
동일 기대값으로 재검증합니다. v1의 실제 캡처·보고서·원장은 그대로 보존합니다.
