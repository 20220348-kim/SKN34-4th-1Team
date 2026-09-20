# 지역 OR 경로 회귀 재검증 — 2026-09-08

[v1](../region-conflict-20260908-v1/README.md) after에서 안산 소재 회사가 서울의 별도 지점·공장을 통해
신청할 수 있는 공고를 `INCOMPATIBLE`로 판단했습니다. 이 한 건의 회귀를 수정한 뒤 **동일한 54개
기대값과 공개 공고 20개**로 다시 확인합니다. v1의 결과와 기대값을 고치거나 실패를 삭제하지 않습니다.

## 고정 조건

- `run.py`는 v1 실행 함수를 재사용하는 작은 실행기입니다. production 추상화나 별도 평가 프레임워크를
  추가하지 않습니다. v1 fixture의 SHA-256까지 고정해 결과에 맞춘 라벨 수정을 거부합니다.
- 합성 지역 3회(서울·서울 강남구·경기 안산시) + 공개 서울 SW 지원금 질문 2회 = **추가 랭킹 최대 5회**.
- `gpt-5.6-sol` / `low` / `priority`, SDK 재시도 0, 최대 10,000 출력 토큰, HTTP/모델 45초·Agent 50초,
  `store=false`, 추적 비활성, 시도별 새 Agent/Service를 유지합니다.
- 임베딩·대화 해석·검색 API는 호출하지 않습니다. v1 원장과 공유하지 않고 이 폴더의 별도 원장에서
  시도 전에 fsync하며, 5회 초과와 단계 재실행을 거부합니다. 실패도 시도로 남깁니다.
- v1의 baseline과 after는 각각 당시 Agent·프롬프트 스냅샷에 고정돼 있습니다. v2도 실제 실행 당시의
  `after_agent.py`·`after_prompt.py` 스냅샷에 고정하며, 소스·입력·출력 schema·프롬프트 해시를 기록합니다.
  테스트는 현재 production 프롬프트가 달라져도 이 해시들이 v2 실호출 기록과 일치함을 검증합니다.

## 실행과 무료 확인

저장소 루트에서 실행합니다. 기본 실행은 API 0회 계획이며 키도 읽지 않습니다.

```bash
backend/ai-service/.venv/bin/python evaluation/support-program-search/runs/region-conflict-20260908-v2/run.py
backend/ai-service/.venv/bin/python -m pytest evaluation/support-program-search/runs/region-conflict-20260908-v1/test_region_conflict_runner.py evaluation/support-program-search/runs/region-conflict-20260908-v2/test_region_conflict_v2_runner.py
```

유료 실행은 **별도 추가 5회 승인** 아래에서만 `--execute --phase after --key-file .env`로 수행합니다.
모의 검증은 `--execute --offline`이며 실제 호출이나 모델 품질 측정이 아닙니다. 테스트는 임시 폴더에서
수행하고 v1의 실제 원장·결과가 바뀌지 않는지 확인합니다. 결과나 원장을 지워 재실행하지 마세요.

`output/after`의 파일 계약과 해석은 [v1 결과 읽기](../region-conflict-20260908-v1/README.md#결과-읽기)를
따릅니다. manifest의 실행 완료와 report의 품질 통과는 별개입니다. `report.json`의 합성 54개 판정과
`public-checks.json`의 안산 한정 공고 제외·대구 이전 허용 공고의 미확인 상태를 함께 확인합니다.

합성 기대값과 공개 공고 진단은 AI 개발 초안이지 사람이 검토한 정답이 아닙니다. 이 소규모 반복은
고정 사례의 회귀 확인이며 전체 검색 정확도·독립 heldout 성능·실제 신청 자격을 입증하지 않습니다.
# 실행 결과 요약

저장된 v2 결과는 합성 54/54 및 공개 안산 제외·이전 예외 UNKNOWN 각각 2/2입니다. 그러나 공개
여성창업 공고의 개인 주소를 회사 주소로 대입해 추천에서 빠지는 문제도 발견했습니다. 이후 최종 지침에
제한 대상 주체를 먼저 구분하도록 보완했고, [실제 검색 1회](../region-conflict-20260908-v1/search/capture.json)에서
해당 공고의 UNKNOWN 보존과 안산 제외를 확인했습니다. **v2의 54/54는 마지막 지침의 전체 합성 재검사 결과가 아닙니다.**
최종 배포·사용 15/15회·검증 범위는 [deployment.json](deployment.json)과
[최종 기록](../../../../docs/region-conflict-fast-20260908.md)을 참고하세요.
