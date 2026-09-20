# Nori v2 한국어 분석·유사 표현 개선 비교

## 결과

2026-09-06 기준 공개 기업마당 공고 **1,422건**의 같은 스냅샷을 사용했다.
기존 질문 300개·목표 공고·원문·라벨·v1 보고서는 변경하지 않았다. 실제 로컬 ES 9.5.3 + Nori로
v1과 v2를 각각 새 격리 인덱스에 색인한 뒤 비교했다. **유료·외부·모델·임베딩 API 호출은 0회**다.

| 기존 300개 질문 지표 | v1 | v2 |
| --- | ---: | ---: |
| 목표 공고 Hit@1 | 258/300 | 268/300 |
| 목표 공고 Hit@5 | 292/300 | 295/300 |
| 목표 공고 Hit@15 | 295/300 | 298/300 |
| 목표 공고 Hit@20 | 295/300 | 299/300 |
| 목표 공고 MRR@20 | 0.906111 | 0.933764 |

기존에 놓쳤던 5개 중 **4개를 회복**했고, 기존에 찾던 목표 공고가 20위 밖으로 밀린 경우는 없었다.
별도 공고로 작성한 추가 16개 질문은 Hit@20이 양쪽 모두 16/16, Hit@1은 15/16→16/16이다.
추가 질문도 AI가 원문을 보고 작성했으며 사람 검증 또는 독립적인 실제 사용자 테스트가 아니다.

| 기존 누락 질문 | v1 | v2 |
| --- | ---: | ---: |
| Q041 경북 제조기업 현장 기술 문제 해결 | 20위 밖 | 20위 밖 |
| Q044 제주 음식점 시설 개선 융자 | 20위 밖 | 16위 |
| Q198 횡성 소상공인 대출이자 | 20위 밖 | 1위 |
| Q240 화천 관광객 유치 여행사 | 20위 밖 | 1위 |
| Q271 여수 관광객 유치 여행사 | 20위 밖 | 1위 |

**운영 후보는 20개로 유지한다.** v2에서도 15개로 줄이면 Q044를 놓친다.
Q041을 억지로 찾게 하려고 `전문가=현장애로` 같은 부정확한 동의어는 추가하지 않았다.

순위가 내려간 9개 질문도 숨기지 않는다. 목표 공고 순위 기준으로 Q001 5→6, Q024 2→4,
Q048 1→2, Q065 2→3, Q088 1→2, Q214 1→2, Q219 5→6, Q253 1→2, Q288 1→3이다.
전체 Hit/MRR가 개선되어도 모든 질문이 좋아지는 변경은 아니다. 이 순위는 최종 AI 추천 순위가 아니다.

## 변경 내용과 경계

운영 정의는 [v1](../../../../backend/core-api/src/main/resources/elasticsearch/support-program-lexical-v1.json)과
[v2](../../../../backend/core-api/src/main/resources/elasticsearch/support-program-lexical-v2.json)를 그대로 로드한다.

- Nori `mixed` → `discard`: 겹치는 원형/분해 토큰의 구문 분기 대신 분해된 단어로 검색한다.
- 사용자 사전 6개: `횡성`, `소상공인`, `여행사`, `여행업체`, `현장애로 현장 애로`, `대출이자 대출 이자`.
- 검색 분석기에만 `여행사, 여행업체` 동의어 그래프를 적용한다. 원문·색인 토큰에 동의어를 삽입하지 않는다.
- `음식점=식품접객업소`, `융자=보조금` 등 자격·범위를 바꾸는 규칙은 추가하지 않는다.
- BM25 상수, OR 질의, 동점 정렬, 본문 해시, Qdrant, RRF, AI 점수화, 후보 20개는 유지한다.

초기 프로토타입에서 같은 299/300 결과가 나왔지만 합성 회귀 테스트에서 `소상공인`이 앞뒤 문맥에 따라
다르게 분석되어 횡성 공고보다 안양 공고가 높게 나왔다. `소상공인`을 사전에 보존한 뒤 최종 설정으로
전체 비교를 다시 실행했다. 최종 보고서에는 수정된 설정을 저장했다.
추가 테스트에서 단독 `소상공인의`의 `의` 토큰까지 제거된다고 가정한 기대값도 바로잡았다.
사용자 사전의 보장 범위는 업종명 보존이며, 모든 한국어 조사·중의성 해결이 아니다.

## 입력·보고서

- 원본 스냅샷: [fixture-labeled.json](../support-program-catalog-20260906-v1/review-final-v1/fixture-labeled.json)
- 기존 질문: [100개](../candidate-budget-100-20260913-v1/questions.json) + [200개](../candidate-budget-300-20260913-v1/questions-added.json)
- 추가 질문: [questions-added.json](questions-added.json). 기존 샘플링 seed 순서의 301~316번째 공고를 선택했다.
- 결과: [report.json](report.json). 두 설정 원문·입력/소스 해시·엔진 정보·후보 ID·지표·하락 목록·시간을 포함한다.
- 도구: [compare_lexical_v2.py](../../compare_lexical_v2.py), [회귀 테스트](../../test_compare_lexical_v2.py)

총 316개 질문 × 2개 설정 × 2회 반복 = **로컬 ES 검색 1,264회**다.
같은 질문을 반복했을 때 순위가 같아야 하며, 새로 측정한 v1의 기존 300개 상위 20개 ID가 과거 보고서와
하나라도 다르면 성공 보고서로 저장하지 않는다. 각 공고 내용 해시와 전체 스냅샷 지문도 검증한다.
Hit@1/5/15는 실제 K=20 결과의 접두부를 사용한다. K=15 지연을 따로 측정한 결과는 아니다.

## 재실행 — 저장소 루트

Docker와 Python 3.11 이상이면 된다. `.env`나 프로젝트 API 키를 읽지 않는다.
클러스터 이름·버전·Nori를 확인하고 연결을 `127.0.0.1:19200`으로 제한한다.

```bash
docker compose --env-file /dev/null -f evaluation/support-program-search/elasticsearch/compose.yaml up -d --build --wait

python3 -B evaluation/support-program-search/compare_lexical_v2.py \
  --output /tmp/govbiz-lexical-v2-new-report.json

docker compose --env-file /dev/null -f evaluation/support-program-search/elasticsearch/compose.yaml down
```

출력 파일은 존재하지 않는 경로를 지정한다. 기존 보고서나 인덱스를 덮어쓰지 않는다.
종료 명령은 전용 실험 컨테이너·임시 색인·네트워크만 제거하고 기존 개발 DB·볼륨에는 접근하지 않는다.

Docker·API 없이 저장된 지표와 입력 일치를 재검사하려면:

```bash
backend/ai-service/.venv/bin/python -B evaluation/support-program-search/compare_lexical_v2.py \
  --verify-report evaluation/support-program-search/runs/lexical-v2-20260913-v1/report.json

backend/ai-service/.venv/bin/python -B -m unittest discover -s evaluation/support-program-search
```

마지막 명령은 기존 ES 통합 2건을 환경변수 없이 실행하면 건너뛴다. 실제 ES 검증까지 실행하려면
실험 컨테이너를 띄운 상태에서 `LOCAL_ES_INTEGRATION_URL=http://127.0.0.1:19200`을 지정한다.
기본 CI의 평가 도구 전체 테스트가 새 지표 재검사·변조 거부 테스트 8건도 실행한다.

## 구현 검증

- JDK 21 `JAVA_TOOL_OPTIONS='-Dspring.test.context.cache.maxSize=2' ./gradlew clean build --no-daemon`:
  **1,261건 통과**, 실패·오류·skipped 0건. 실제 ES·Nori 통합 9건과 MySQL 8.4 통합 테스트를 포함한다.
  기본 제외 태그인 `live-source` 실제 외부 API 검사는 실행하지 않았다.
- `LOCAL_ES_INTEGRATION_URL=http://127.0.0.1:19200`을 지정한 검색 평가 도구 전체 테스트:
  **139건 통과**, 기존 실제 ES 통합 2건을 포함하며 skipped 0건이다.
- 오프라인 검토 도구 108건, 기존 100/300개 비교 도구 10+5건, 인프라 스크립트 25건 통과.
  인프라 테스트는 최초 샌드박스의 로컬 HTTP 바인딩 차단 후 해당 권한으로 재실행했다.
- 이전 공유 평가 자료·과거 ES 비교 보고서 재검사 통과. 별도 Node.js 계산으로 새 보고서의 소스 해시,
  질문별 순위·Hit·MRR와 문서 링크도 확인했다.
- 격리 Compose `govbiz-verify-lexical-v2-20260913` 전체 검증 통과: 4개 제공처의 스텁 공고 저장·색인·검색,
  ES 중단 시 명시적 503·MySQL 목록 보존·동일 ES 볼륨 재생성 후 하이브리드 검색 복구를 확인했다.
  Core 재시작, Redis 결과 복원, RabbitMQ 재연결, Qdrant·AI Service 장애/복구도 통과했다.
  OpenAI는 로컬 스텁만 사용했고 검증용 컨테이너·볼륨은 종료 시 정리했다.

## 해석 한계와 배포

- 기존 300개는 개발 중 확인한 자료다. 추가 16개도 초기 설정 선택 후 작성하고 최종 회귀 검증에 재사용했다.
  새로운 블라인드 heldout 또는 사람 검증 정답으로 표시하지 않는다.
- 질문마다 목표 공고 한 건만 지정했다. 다른 관련 공고 전체를 라벨링하지 않았으므로 전체 Recall/Precision,
  신청 가능성, 다른 공고 오추천율을 증명하지 않는다. 합성 비동의어 테스트 통과도 실데이터 오추천율은 아니다.
- 한 날짜의 기업마당 스냅샷만 사용했다. 다른 제공처·최신 데이터·실제 사용자 표현은 후속 측정이 필요하다.
- 운영 버전 필터·가시성 집계·Qdrant·RRF·AI 랭킹·동시 부하를 실행하지 않았다. 로컬 HTTP 시간으로 전체 채팅
  속도나 AI 토큰·비용 개선을 주장하지 않는다.
- 구현 검증과 실제 개발 서버 배포는 별개다. [v1→v2 업그레이드·롤백](../../../../docs/elasticsearch-lexical-search.md#v1--v2-분석기-업그레이드)을 따른다.
  이번 검증을 위해 기존 개발 Docker·DB·Qdrant를 재시작하거나 실 API 동기화를 켜지 않았다.
