# 지역 범위 개선 1차 실제 평가 — 의미 불합격

2026-09-07 UTC 10:52:35~10:53:06, `gpt-5.6-luna`/추론 none/랭킹 45·50초.
사용자 승인 아래 합성 3요청을 각 1회 호출했다. 임베딩 0회, 자동 재시도 0회.

3회 모두 API 200과 production Service 검증을 통과했지만, 지역 평가 **24개 중 22개**만
기대값과 일치해 전체 결과는 `quality_failed`/exit 1이다.

- 서울만 입력한 서초구 한정 공고는 UNKNOWN이었다.
- 본문 전국 허용, 지역 태그만 존재, 행사·기관 위치만 존재하는 사례는 기대와 일치했다.
- `REGION_SEOUL`의 `SYNTH:REGION_07`: 현재 서울 소재 경로를 이미 충족하는데 UNKNOWN으로 판정했다.
- `REGION_BUSAN`의 같은 공고: 서울 이전 여부가 미확인인 대안을 무시하고 INCOMPATIBLE로 판정했다.

같은 인용의 문자 일치는 두 오류 모두 통과했다. 따라서 exact quote 통과나 API 200은 의미 품질
합격과 다르다. 이후 OR 대안 규칙을 보강하더라도 이 1차 실패 기록과 기대값을 수정하지 않는다.

사용량: 입력 17,027토큰, 출력 3,280토큰(합계 20,307), cached/reasoning 0.
API 소요 시간은 8.875·9.281·8.734초다. 이 수치는 8개 합성 후보의 랭킹이며 실제 검색 20후보의
응답 시간이나 운영 성능으로 해석하지 않는다.

`fixture.json`, `capture.json`, `report.json`, `api-usage.json`, `execution-manifest.json`은 실행기가
기록했다. `changed-sources-at-execution.json`은 이후 보완 전에 보존한 prompt/agent 원문이며
UTF-8 바이트로 복원한 해시가 manifest의 해당 sourceSha256과 일치함을 확인했다.
합성 개발 데이터이며 독립 heldout·실제 공고 정확도·개선 전후 우열의 증거는 아니다.
