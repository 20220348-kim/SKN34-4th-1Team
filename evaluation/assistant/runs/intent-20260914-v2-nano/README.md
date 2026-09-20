# 도우미 의도 분류 측정 v2: gpt-5-nano / minimal (2026-09-14)

v1과 같은 50문항·도움말 14항목(sha256 `a20aa1a2…` 이후 항목 4개 추가 버전, 보고서의 `helpContentSha256` 참고)으로
가장 싼 모델 `gpt-5-nano`를 추론 `minimal`로 돌린 결과다. 전체 보고서는 [report.json](report.json)이다.

| 지표 | 값 |
|---|---|
| `intentAccuracy` | 26/46 (호출 실패 4건 제외) |
| `helpCitationAccuracy` | 14/27 |
| `abstainRateOnUnanswerable` | 4/9 |
| `falseAbstainRateOnAnswerable` | 4/37 |
| 호출 실패(`AssistantAnswerError`) | 4 |
| 평균 지연 | 1,482ms |

사용법 질문을 공고 질문·범위 밖으로 보내고, 범위 밖·불명확 질문을 사용법으로 답하는 오류가 절반 가까이였다.
같은 nano를 추론 `low`로 올린 [v3](../intent-20260914-v3-nano-low/README.md)가 48/50이므로 **nano/minimal은 채택하지 않는다.**
