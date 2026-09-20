# 도우미 의도 분류 측정 v3: gpt-5-nano / low (2026-09-14)

v2와 같은 50문항·도움말 14항목으로 `gpt-5-nano`를 추론 `low`로 돌린 결과다. 전체 보고서는 [report.json](report.json)이다.
이 설정을 서비스 기본값(`OPENAI_ASSISTANT_MODEL=gpt-5-nano`, `OPENAI_ASSISTANT_REASONING_EFFORT=low`)으로 채택했다.

| 지표 | 값 | v1 luna/none |
|---|---|---|
| `intentAccuracy` | 48/50 (dev 31/32, heldout 17/18) | 50/50 |
| `helpCitationAccuracy` | 28/30 | 30/30 |
| `accountTopicAccuracy` | 4/4 | 4/4 |
| `abstainRateOnUnanswerable` | 9/10 | 10/10 |
| `falseAbstainRateOnAnswerable` | 0/40 | 0/40 |
| 호출 실패 | 0 | 0 |
| 평균 지연 | 3,175ms | 1,967ms |

틀린 세 건: `H01-3`(취소하면 조건은 어떻게 되나 → 사용법이지만 다른 항목 인용), `H08-3`(기업 등록 안 하면 제안도 못 보내나 → 내 상태로 분류),
`N09`("안 돼요" → 불명확이 아니라 사용법). 셋 다 답이 엉뚱한 곳으로 가는 정도이며 없는 사실을 만들지는 않았다.

비용은 공개 단가 기준(2026-09) nano $0.05/$0.40, luna $0.20/$1.20(입력/출력 1M 토큰)이라 요청당 약 절반이다.
추론 `low`가 붙어 출력 토큰이 늘고 지연이 1초가량 길어진다. 정확도가 더 중요하면 `OPENAI_ASSISTANT_MODEL=gpt-5.6-luna`,
`OPENAI_ASSISTANT_REASONING_EFFORT=none`으로 v1 설정으로 돌아갈 수 있다.
