# 검색 지연 비교 — 2026-09-08

기존 Sol/low 랭킹의 시간 초과를 재현하고 내부 출력 축약과 Fast 처리를 별도로 비교합니다.
결과·채택 여부·로컬 반영은 [개발 기록](../../../../docs/search-latency-20260908.md)에 정리합니다.

## 고정 조건과 호출 한도

- 공고: 기존 [v5 요청](../search-precision-v5-20260907-v1/request.json)의 공개 공고 20개.
- 조건: 서울 소재 가상 기업. 지원금·같은 의미의 비용 지원·컨설팅·영화 후반작업·넓은 사업화 질문 5개와 지원금 1회 반복.
- 모델: `gpt-5.6-sol`, reasoning `low`, 후보 20개, 기존 v5 점수·자격 검증.
- 제한: 모델/HTTP 45초, Agent 50초, 출력 최대 10,000토큰, 1턴, SDK 재시도 0, `store=false`, tracing 비활성.
- 비교: baseline 6회 + compact 6회 + fast 최대 6회. baseline/compact는 `service_tier=default`, fast는 `priority`.
- 실제 검색: 별도 동일 POST 최대 2회, 검색당 임베딩 최대 1회·랭킹 최대 1회. 조건 해석은 호출하지 않습니다.
- 사용자 승인 합계 최대 22회. 실패한 시도도 한도에 포함하며, 응답 없는 호출의 토큰·비용은 알 수 없습니다.

baseline은 변경 전 `agent.py`를 보관한 `baseline_agent.py`입니다. 각 랭킹 시도는 새 Agent/Service를
생성하므로 동일 질문 반복도 애플리케이션 캐시를 사용하지 않습니다. 과거 실행의 설정을 유지하도록
baseline은 baseline_agent, compact/Fast(full 포함)는 compact_agent 스냅샷과 고정된
prompt_at_execution을 사용합니다. 현재 production의 지역 지침이 바뀌어도 과거 입력·schema·지침 해시를
보존하는 오프라인 회귀를 포함합니다. Compact는 원문·조건·점수 기준을
삭제하지 않고 후보 ID와 출력 필드명만 줄여 원래 계약으로 복원합니다. Fast에서 선택한 형식은 manifest에
기록합니다. 서버 응답의 실제 tier, 토큰 사용량과 입력·프롬프트·schema 해시는 `usage.json`에 보존합니다.
Compact는 실제 비교에서 시간 초과가 증가해 서비스 코드/설정에서 제거했습니다. 실행 당시 코드는
`compact_agent.py`와 해당 테스트에만 보존하며 runner의 compact 단계도 이 스냅샷을 사용합니다.

## 재현

저장소 루트에서 실행합니다. 기본 실행은 계획 출력만 하며 키를 읽거나 API를 호출하지 않습니다.

```bash
backend/ai-service/.venv/bin/python evaluation/support-program-search/runs/search-latency-20260908-v1/run.py
backend/ai-service/.venv/bin/python evaluation/support-program-search/runs/search-latency-20260908-v1/run-search.py
backend/ai-service/.venv/bin/python evaluation/support-program-search/runs/search-latency-20260908-v1/compare.py
backend/ai-service/.venv/bin/python -m pytest evaluation/support-program-search/runs/search-latency-20260908-v1/test_runner.py evaluation/support-program-search/runs/search-latency-20260908-v1/test_search.py evaluation/support-program-search/runs/search-latency-20260908-v1/test_compare.py evaluation/support-program-search/runs/search-latency-20260908-v1/test_compact_output.py
```

유료 실행은 별도 승인 후 `--execute --phase baseline|compact|fast --key-file .env`가 필요합니다.
Fast의 출력 형식은 `--fast-format full|compact`로 지정합니다. 공식 `api.openai.com/v1/responses`만
허용하고 다른 주소·redirect·proxy·설정 변경을 거부합니다. 키·HTTP 헤더·원문 오류는 기록하지 않습니다.
`ledger-live.jsonl`은 시도 전에 fsync하며 이미 실행한 단계·총 18회 초과를 거부합니다. `run-search.py`도
고정 출력 디렉터리의 배타적 생성으로 재실행을 거부합니다. 결과/ledger를 지워 재시도하지 마세요.
새 유료 실험은 새 실행 기록과 별도 예산 승인이 필요합니다. 테스트는 임시 경로와 MockTransport를 사용합니다.
`--execute --offline`의 출력은 실제 API 기록과 분리하며 Git에는 포함하지 않습니다.

## 평가 한계

기존 `ai-review.json`은 **AI_DRAFT_NOT_HUMAN_GROUND_TRUTH**입니다. 사람이 검토한 정답으로 표시하지
않으며 `uncertain`을 오답으로 바꾸지 않습니다. 질문별 최종 추천과 후보 20개의 필터 전 판정을 따로
확인합니다. 단계당 6회는 운영 p95나 전체 품질 무저하를 입증하는 표본이 아닙니다. 순차 실험이라 서비스
부하·서버 캐시·시간대의 영향도 완전히 통제하지 못합니다. 실패를 제외한 중앙값은 성공 건수와 함께 읽고,
실패를 빈 추천/품질 0점으로 처리하지 않습니다. 동일 후보 평가이므로 전체 카탈로그 Recall/MRR이 아닙니다.
실제 검색 2회는 현재 날짜/DB의 확인 검색 왕복이며, 사용자의 문장을 먼저 해석하는 대화 시간은 제외합니다.
