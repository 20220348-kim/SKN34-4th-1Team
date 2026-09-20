# 총점·자격 점수 수정 후 첫 실제 실행 — 실패 기록

2026-09-06 17:00~17:01 KST에 고정 16개 질문의 캡처를 시도했으나 Q01에서 중단됐다.
이 디렉터리는 **실패 이력**이며 성공한 검색 캡처나 정답 라벨이 아니다. Q02~Q16은 호출하지 않았다.

- MySQL 공고 1,422개와 고정 스냅샷의 ID·내용·해시·정렬 시각이 일치했고 Qdrant 동일 버전 1,422개를 확인했다.
- AI 총점 생성을 제거하고 `INCOMPATIBLE + 양수 점수`를 출력 스키마에서 차단한 첫 버전이다.
- 질문 임베딩 1회, 추천 1회 모두 OpenAI HTTP 200이었다. 추천 응답은 19.917초에 완료됐다.
- 20개 항목의 개별 점수·자격 검증은 모두 통과했지만 고유 ID는 15개였다. 5개 ID가 각각 두 번 등장했고 5개가 빠졌다.
- 기존 내부 중복 ID 검증이 오류를 반환했으며, 빈 결과로 바꾸거나 누락 공고를 임의로 채우지 않았다.
- 제한시간은 평가용 모델 25초·Agent 30초·Core 읽기 35초다. 운영 기본 제한시간은 변경하지 않았다.

[실패 요약](failed-attempt.json), [관측 사용량](api-usage.jsonl), [실제 모델 출력](ranking-output.json)을 보존한다.
모델 출력은 공개 공고의 판단 내용만 추출했으며 API 인증 헤더·키·DB 비밀번호·요청 본문을 포함하지 않는다.

후속 수정은 배열 개수 제한 대신 **실제 후보 ID를 각각 필수 객체 키로 고정**하는 것이다. 후보가 바뀌면
키도 그 요청에서 생성하며, 지역·업종별 하드코딩이나 실패를 숨기는 fallback을 추가하지 않는다.
AI의 판단 기준은 유지하고 Agent가 검증한 ID별 평가를 기존 내부 목록으로 변환한다.

아래는 API 없이 중복을 확인하는 명령이다(저장소 루트에서 실행).

```bash
python3 -B - <<'PY'
import json
from collections import Counter
from pathlib import Path
path = Path('evaluation/support-program-search/runs/support-program-catalog-20260906-v1/actual-capture-v2/ranking-output.json')
rows = json.loads(path.read_text())['rankings']
counts = Counter(row['programId'] for row in rows)
assert len(rows) == 20 and len(counts) == 15
print({key: count for key, count in counts.items() if count > 1})
PY
```
