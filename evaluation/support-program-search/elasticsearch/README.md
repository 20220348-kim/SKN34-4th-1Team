# Elasticsearch + Nori 후보 검색 비교 실험

**이 디렉터리는 운영 검색과 분리한 로컬 비교 실험이다.** 기존 MySQL·Qdrant·Redis·AI Service와
Frontend를 변경하거나 재시작하지 않는다. Elasticsearch는 공유된 공개 공고 스냅샷의 복사본만
색인하며 OpenAI API 키·임베딩·LLM 호출이 필요 없다. 회원·기업·대화 데이터는 읽지 않는다.

별도로 Core 자연어 검색에 Nori·BM25가 연결되었다. [운영 경로 구현·배포 주의사항](../../../docs/elasticsearch-lexical-search.md)은
이 실험 Compose가 아닌 `infrastructure/compose.yaml`을 기준으로 한다. 과거 실험 결과를 소급 변경하지 않는다.

## 비교 범위

호출 흐름은 `고정 fixture → 내용·해시 검증 → 실험 Elasticsearch 색인 → 후보 검색 → 오프라인 지표`다.
MySQL은 여전히 운영 원본이고 Qdrant는 여전히 운영 의미 검색을 담당한다.

| 방식 | 분석·순위 |
| --- | --- |
| `keyword` | 기존 평가기의 NFC·소문자 정규화, 영문/숫자/한글 토큰 정확 일치 개수. 운영 Core 키워드 후보의 비교 기준 |
| `standard_bm25` | Elasticsearch standard 분석기 + BM25 |
| `nori_bm25` | Elasticsearch Nori 분석기(`mixed` 복합어 처리) + 같은 BM25 |

세 방식에 **동일 공고·질문·K=20**을 적용한다. ES의 두 필드는 동일 원문으로 한 인덱스에 색인한다.
ES는 NFC 정규화 후 색인·질의하며 BM25 `k1=1.2`, `b=0.75`, `discount_overlaps=true`,
샤드 1개, 복제본 0개를 고정한다. 동점은 원본 `sortTimestamp` 문자열 내림차순·복합 ID 오름차순이다.
질의는 `match` OR이고 분석 후 토큰이 없으면 빈 결과를 반환한다. 별도 동의어·필드 가중치·지역
자격 필터는 넣지 않았다. **일반 BM25와 Nori BM25의 차이가 분석기 영향**이며,
기존 키워드와 Nori 비교에는 점수 공식 변경 영향도 함께 포함된다.

설정 원본은 [index.json](index.json), 실행 도구는 [compare_elasticsearch.py](../compare_elasticsearch.py)다.
공식 [Nori 구성](https://www.elastic.co/docs/reference/elasticsearch/plugins/analysis-nori-analyzer)과
[BM25 설정](https://www.elastic.co/docs/reference/elasticsearch/index-settings/similarity)을 기준으로 했다.
Elasticsearch [9.5.3 공식 이미지](https://www.docker.elastic.co/r/elasticsearch/elasticsearch:9.5.3)의
멀티 아키텍처 digest를 고정하고 같은 버전의 Nori 플러그인을 설치한다.

## 실행 — 저장소 루트

Docker Compose와 Python 3.11 이상이면 된다. `.env`·프로젝트 서비스·추가 Python 패키지는 필요 없다.
첫 이미지 다운로드와 Nori 설치는 인터넷이 필요하며 디스크·메모리를 사용한다.
JVM heap은 512MiB, 컨테이너 메모리 상한은 2GiB다.

```bash
docker compose --env-file /dev/null -f evaluation/support-program-search/elasticsearch/compose.yaml config --quiet
docker compose --env-file /dev/null -f evaluation/support-program-search/elasticsearch/compose.yaml up --build -d --wait --wait-timeout 180

LOCAL_ES_INTEGRATION_URL=http://127.0.0.1:19200 python3 -B -m unittest discover \
  -s evaluation/support-program-search -p 'test_compare_*.py'

python3 -B evaluation/support-program-search/compare_elasticsearch.py \
  --fixture evaluation/support-program-search/runs/support-program-catalog-20260906-v1/review-final-v1/fixture-labeled.json \
  --output /tmp/govbiz-lexical-comparison-new.json
```

출력 파일은 아직 존재하지 않아야 한다. 기존 보고서를 덮어쓰지 말고 새 이름을 사용한다.
실행 실패 시 출력은 `status: failed`로 남으며 성공 지표로 쓰지 않는다. `--k`는 1~100,
`--repeats`는 1~10(기본 3)이며 비교 시 같은 값을 고정한다.
실험 URL은 `http://127.0.0.1:19200`이다. 다른 로컬 포트는 `--endpoint`로 지정할 수 있으나
원격 호스트·인증정보·프록시·리디렉션은 허용하지 않는다. 전용 클러스터 이름·버전·Nori 설치도 확인한다.

실험 Compose는 별도 bridge 네트워크와 localhost 포트만 사용한다. Docker Desktop의 internal-only
네트워크에서는 호스트 포트가 게시되지 않아 일반 bridge를 사용한다. **네트워크 차원의 외부 통신 차단
환경은 아니다.** 애플리케이션 네트워크·볼륨·환경변수를 연결하지 않는다.
인증 비활성은 로컬 공개 자료 실험에만 허용하며 이 Compose를 운영·공용 서버에 배포하면 안 된다.

색인은 실행마다 임의의 새 이름으로 만든다. 기존 인덱스·alias에 쓰거나 삭제하는 API는 없다.
전체 공고 내용 해시·카탈로그 지문·색인 건수·bulk 개별 성공·검색 응답의 ID/해시·부분 실패를 검증한다.
중간 실패를 빈 검색 결과나 품질 0점으로 숨기지 않는다.

## 종료와 공유

```bash
docker compose --env-file /dev/null -f evaluation/support-program-search/elasticsearch/compose.yaml down
```

이 명령은 **해당 실험 컨테이너·네트워크만** 제거한다. 데이터는 tmpfs라 중지/종료 시 실험 색인이
사라진다. 저장한 JSON 보고서와 Git의 공고 스냅샷은 남으므로 재색인할 수 있다. 운영 볼륨은 연결하지 않는다.

공유 자료는 [첫 실행 폴더](../runs/elasticsearch-nori-20260912-v1/README.md)에 보관한다.
새 결과를 공유하려면 `runs/`에 별도 실행 폴더를 만들고 필요한 파일만
`runs/.gitignore` 허용 목록에 추가한다. 공고 원문을 중복 복사하지 않고 기존 고정 fixture를 재사용한다.
비밀정보·새 라벨·실패 출력 포함 여부를 확인하고 커밋한다.

## 보고서 해석과 검증

- 후보 ID와 split별 Recall@K를 저장한다. `null` 라벨 질문은 실행하되 지표에서는 제외한다.
  후보 단계의 `noMatchFalsePositiveRate`는 무관 참조 질문에 후보가 생겼는지일 뿐, 최종 오추천율이 아니다.
- 사용한 2026-09-06 스냅샷은 공고 1,422건·질문 16개다. AI-only 풀 기준으로 평가 가능 6개,
  양성은 2개뿐이다. 새 후보는 별도로 판정하지 않았고 기존 라벨을 그대로 사용한다.
  점수를 사람 검증 정확도나 전체 카탈로그 Recall로 설명하면 안 된다.
- `dev`·`heldout`과 정답을 바꾸지 않는다. 이미 여러 번 확인한 자료라 새로운 독립 검증 세트도 아니다.
- 첫 패스와 동일 질의 반복 패스의 HTTP 왕복 및 ES `took` 시간을 각각 기록한다.
  반복 순위가 바뀌면 실패한다. 첫 패스도 완전히 cold한 실행을 보증하지 않는다.
  작은 카탈로그·순차 warm 질의 시간은 운영 동시 부하나 전체 채팅 응답시간이 아니다.
- Python 키워드 기준은 공고 토큰을 미리 계산하므로 그 시간을 Kotlin 운영 경로와 비교하지 않는다.
  Qdrant·RRF·AI 랭킹은 실행하지 않았으므로 **운영 하이브리드 개선율·최종 MRR·AI 지연 개선은 미측정**이다.
- `_analyze`의 실제 토큰도 저장한다. Nori가 조사를 처리해도 동의어, 지원 대상, 지역 자격을 자동 해결하지 않는다.

저장된 지표는 Docker/API 없이 재계산할 수 있다. 이 검사는 파일의 지표 일치만 확인하며 ES 호출의 진위나
라벨의 정확성을 인증하지 않는다. `sourceSha256`, 엔진 버전, `indexDefinition`, 검색 설정을 함께 확인한다.

```bash
python3 -B evaluation/support-program-search/compare_elasticsearch.py \
  --fixture evaluation/support-program-search/runs/support-program-catalog-20260906-v1/review-final-v1/fixture-labeled.json \
  --verify-report evaluation/support-program-search/runs/elasticsearch-nori-20260912-v1/report.json

backend/ai-service/.venv/bin/python -B -m unittest discover -s evaluation/support-program-search
python3 -B -m unittest discover -s evaluation/support-program-search/review -p 'test_*.py'
python3 -B evaluation/support-program-search/review/verify-shared-run.py \
  --run-dir evaluation/support-program-search/runs/support-program-catalog-20260906-v1 --with-capture
```

기본 CI는 단위 테스트·공유 지표 재검사를 수행한다. 실제 ES 통합 검증은
[전용 수동 워크플로](../../../.github/workflows/elasticsearch-experiment.yml) 또는 위 opt-in 명령으로 실행한다.
기본 단위 테스트에서 ES 통합 2건(기존 비교·한국어 질문 확장)은 환경변수 없으면 건너뛰며,
통합 실행에서는 건너뛰면 안 된다.

## 운영 도입 전 기준

한국어 표현을 늘린 [16개 목표 공고·48문장 진단](../runs/elasticsearch-korean-queries-20260912-v1/README.md)도
별도 제공한다. 원문에서 AI가 만든 질문으로 목표 공고 Hit@1/5/20을 측정하며, 기존 AI 합의 라벨을
확장하거나 미확정 질문을 확정한 작업은 아니다. 전체 관련 공고 Recall·신청 자격 평가와 혼동하지 않는다.

이 실험만으로 운영 전환하지 않는다. 유의미한 후보 누락 감소를 확인한 뒤
Qdrant 의미 후보와의 **동일 조건 RRF 비교**가 먼저다. 그 이후에만 MySQL 공개 세대·ID/해시와 ES 색인의
일치, 누락 복구·재색인·실패 시 상태 표시, 검색 시 전체 MySQL 조회 비용을 포함한 실제 경로를 설계한다.
운영 API, 제공처 동기화, 공개 준비 상태에 ES를 연결하는 작업은 이번 범위가 아니다.
