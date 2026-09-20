# 도우미 의도 분류 첫 측정 (2026-09-13, v1)

`questions.json` 50문항(sha256 `5a287d17…`)과 `helpContent.ts` 챗봇 표면 10항목(sha256 `a20aa1a2…`)으로
`evaluate.py --live`를 한 번 실행한 결과다. 모델은 `gpt-5.6-luna`, reasoning `none`, 문항당 한 번 호출, 평균 지연 1,967ms.
전체 보고서는 [report.json](report.json)이다.

| 지표 | 값 |
|---|---|
| `intentAccuracy` | 50/50 (dev 32/32, heldout 18/18) |
| `helpCitationAccuracy` | 30/30 |
| `accountTopicAccuracy` | 4/4 |
| `abstainRateOnUnanswerable` | 10/10 |
| `falseAbstainRateOnAnswerable` | 0/40 |
| 호출 실패 | 0 |

## 읽을 때 주의

- 질문은 도움말 항목을 보고 AI가 작성한 가상 표현이라 실제 사용자의 오타·긴 문장·복합 질문을 대표하지 않는다.
  만점은 "이 50문항에서 회귀가 없다"는 뜻이지 분류기의 일반 성능이 아니다.
- 이 실행으로 프롬프트나 문항을 조정하지 않았으므로 `heldout`은 아직 미사용 검증 자료다.
- 답 문장의 정확성·말투, Core의 상태 답, 프런트 표시는 측정하지 않았다.
- 이 디렉터리의 질문·보고서는 수정하지 않는다. 문항을 바꾸면 새 버전 디렉터리를 만든다.
