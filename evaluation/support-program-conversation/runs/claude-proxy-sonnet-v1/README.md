# Claude 대리 검증 — Sonnet 기준선 (`claude-proxy-sonnet-v1`)

`claude-proxy-v1`(Haiku)과 같은 방법으로 Claude Sonnet이 답한 기준선이다. **OpenAI 운영 모델의 측정이 아니며**,
기대 라벨은 AI가 작성한 기대 동작이다.

- 실행일: 2026-10-11. 입력: 당시 `proxy/` 264줄(`inputs-manifest.json`), 유료 API 호출 0회.
- 대리 모델: Claude Sonnet 에이전트 4개가 66줄씩 블라인드로 한 번씩 답했다.
- `report.md`는 당시 라벨·검증 코드로 채점한 결과다(상태 98.9%, 통과 88.6%, 필드 F1 97.9%, 거부 0).
  이후 마침표 날짜 라벨(S033, M07)이 바뀌어 현재 기준으로 다시 채점하면 통과 87.9%다. 비교는
  [`claude-proxy-sonnet-v2`](../claude-proxy-sonnet-v2/README.md)를 본다.
- 실패 30건 중 21건은 결과 참조(“2번 자세히”, “1번이랑 3번 비교”)를 `OUT_OF_SCOPE`로 답한 것으로, 현재 스키마에
  턴 종류가 없는 구조 문제다.
