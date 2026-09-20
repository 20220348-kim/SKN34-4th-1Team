# 지원사업 후보 검색 회귀 평가

최신 v5 실데이터 **고정 후보의 목적·모델 비교**는
[2026-09-07~08 진단 기록](runs/search-precision-v5-20260907-v1/README.md)을 참고한다.
사전 AI 초안, 채택하지 않은 설정, 전체 응답과 사용량을 함께 보존하며 아래 가상 fixture의 평가와 구분한다.

한국어 키워드 후보의 별도 [Elasticsearch + Nori 비교 실험](elasticsearch/README.md)은
고정 실데이터에 기존 키워드·standard BM25·Nori BM25를 적용한다. 실험 실행은 운영 색인·AI 랭킹을 변경하지 않으며,
실제 ES 실행은 opt-in이다. 공유된 지표는 Docker·API 없이 재계산할 수 있다.

Core 자연어 검색에는 별도로 Nori·BM25가 통합되었다. [적용·배포·검증 범위](../../docs/elasticsearch-lexical-search.md)를
참고한다. 새 하이브리드 평가에는 고정 공고만 색인한 새 ES 인덱스와 코드 revision·설정도 함께 보존하고,
구현 전 보고서를 새 경로에서 측정한 결과로 해석하지 않는다.

추가 [한국어 질문 48개 진단](runs/elasticsearch-korean-queries-20260912-v1/README.md)은
실제 공고 16개를 각 3개 표현으로 찾는 AI 작성 known-item 테스트다. 기존 16개 질문·미확정 라벨은
보존하며, 새로운 사람 검증 정답·전체 관련 공고 Recall 측정으로 취급하지 않는다.

[질문 100개 후보 15/20 비교](runs/candidate-budget-100-20260913-v1/README.md)는 서로 다른 공고
100건에 질문을 하나씩 작성한 추가 진단이다. 고정 공고 1,422건의 로컬 Nori 검색에서 목표 공고 포함은
양쪽 모두 98/100이었고 축소로 추가 누락된 목표는 없었다. 외부·유료 API는 호출하지 않았으며,
Qdrant·RRF·최종 AI 추천의 품질이나 지연을 검증한 결과는 아니다. 운영 후보 한도는 20개로 유지했다.

후속 [질문 300개 비교](runs/candidate-budget-300-20260913-v1/README.md)는 기존 100개를 그대로
유지하고 새 목표 공고 200건의 질문을 추가했다. 같은 1,422건을 대상으로 목표 공고 포함은 양쪽 모두
295/300, 신규 질문만은 197/200이었다. 15개 축소로 추가 목표 누락은 없었으나 최종 AI 추천의
품질 보장은 아니며, 이 결과로 운영 한도를 변경하지 않았다.

[Nori v2 전후 비교](runs/lexical-v2-20260913-v1/README.md)는 기존 300개와 추가 16개 질문으로
사용자 사전·단어 분해·검색용 동의어 변경을 검증한다. 기존 300개 목표 Hit@20은 295→299,
추가 16개는 양쪽 모두 16개이며, 순위 하락과 남은 누락도 보고한다. v2의 Hit@15는 298이므로
운영 후보 한도는 20개로 유지한다. 기존 v1 보고서·질문·라벨을 수정하지 않는다.

`compare_lexical_v2.py`와 `compare_korean_queries.py`의 저장 보고서 재검증은
MRR·적중률·응답 시간 중앙값 같은 소수점 지표에만
`math.isclose(rel_tol=1e-12, abs_tol=1e-12)`를 적용한다. 적중 건수·질문별 순위·목록 순서·
입력 및 설정 해시는 정확히 비교하며 NaN·무한대·잘못된 자료형은 거부한다.
Nori v2 검증기 자체의 소스 해시는 현재 버전 또는 기존 캡처 당시의 명시된 SHA-256만 허용한다.
이 호환 처리는 원본 보고서를 다시 쓰지 않으며 다른 소스 해시는 예외 없이 비교한다.
파일 해시는 바이트 기준이므로 과거 보고서는 캡처 당시와 같은 줄바꿈을 보존한 체크아웃에서 검증한다.

이 자료는 **실제 운영 공고가 아닌 수작업 가상 공고 40개와 질문 30개**다. 최신순 20개 제한 때문에 오래된 관련 공고가 누락되는 문제를 재현하고, 같은 자료에서 후보 검색 방식을 비교하는 데 사용한다. 실제 사용자의 추천 정확도, 신청 자격, 운영 데이터 성능을 입증하는 자료가 아니다.

현재 실행기는 production의 LangChain Agent를 사용합니다. 고정 HTTP 응답으로 실행 경로와 계약을
검증하며, 이 전환으로 새 유료 평가나 의미 품질 측정을 수행한 것은 아닙니다. `runs/`의 과거 코드·
캡처·보고서는 당시 구현과 설정에 대한 기록으로 유지합니다.

## 실행

실제 공고의 검토표 생성과 AI-only·혼합·사람 판정 선택 절차는 [검토 도구 안내](review/README.md)를 참고한다.
기본 AI-only는 프로젝트 API 키 없이 Codex 하위 에이전트의 독립 판정을 수집한다. 실제 검색 캡처와는 별개이며,
AI 합의 참조 기준을 사람 검증 정답으로 표시하지 않는다. 보고서의 `labelReference`에서 모드·출처·제외 범위를 확인한다.
이 페이지의 기본 fixture는 아래 설명과 같이 가상 데이터이며 실데이터 평가 완료를 뜻하지 않는다.

프로젝트 루트에서 Python 표준 라이브러리만으로 실행한다. 외부 API 호출, 유료 모델 호출, DB 쓰기를 하지 않는다.

```bash
python3 evaluation/support-program-search/evaluate.py
python3 evaluation/support-program-search/evaluate.py --split dev
python3 -m unittest discover -s evaluation/support-program-search -p 'test_*.py'
```

출력은 JSON이다. `semantic: null`은 수동으로 저장한 의미 검색 후보가 없다는 뜻이고, `capture: null`은
실제 Core 검색 흐름을 캡처한 결과가 없다는 뜻이다. 어느 쪽도 0점이나 검증 성공을 뜻하지 않는다.

## 데이터와 비교 규칙

- `fixture.json`의 `name`, `docs`: `id`, 검색에 사용할 `text`, 고정된 `sortTimestamp`를 가진 공고 40개. 모든 공고는 노출·접수 조건을 만족한다고 가정한다. 날짜와 자격 필터는 이 평가의 범위 밖이다. 기존 의미 검색 비교에서 `dataType`이 없으면 결과에는 `unspecified`로 표시한다.
- `cases`: `id`, `query`, `relevantIds`, `split`을 가진 질문 30개. 관련 공고가 있는 질문 26개, 관련 공고가 없는 질문 3개, 추가 정보가 필요해 관련성을 확정하지 않은 질문 1개다.
- `relevantIds: []`는 이 고정 자료에서 정답이 없다고 라벨링한 경우다. `null`은 미라벨 상태이며 모든 점수 계산에서 제외한다. Q30은 중복 수혜 규정이 공고에 없어서 자격 관련 정답을 임의로 붙이지 않았다.
- 오래된 20개에는 개발비·설비비 등의 지원사업이, 최신 20개에는 유사 주제의 교육·행사 등과 일부 관련 사업이 있다. 목적에 맞는 오래된 공고를 검색하는지 확인하는 **의도적인 난례 구성**이다. 실제 공고의 연령·주제 분포를 대표하지 않는다.
- 질문 Q01~Q20은 개발용(`dev`), Q21~Q30은 검증용(`heldout`)으로 구분했다. 검증용 질문으로 임계값이나 검색 설정을 조정하면 더 이상 미사용 검증 자료가 아니다. 같은 공고나 주제가 양쪽에 있으므로 독립적인 일반화 성능을 입증하는 분리도 아니다. 실제 사용자 질문은 별도로 확보해야 한다.

기준 검색 방식은 다음과 같다.

1. `latest`: 모든 질문에 `sortTimestamp` 내림차순, ID 오름차순의 첫 K개를 반환한다. 과거 구현의 검색어와 무관한 후보 제한을 재현한다. 현재 운영 검색 경로는 전체 허용 공고를 대상으로 Qdrant 후보 검색을 사용한다.
2. `keyword`: NFC 정규화·소문자 처리 후 영문/숫자/한글 토큰의 **정확한 일치 개수**로 정렬한다. 0개 일치는 제외하고, 동점은 최신순과 ID 순으로 처리한다. 형태소 분석, 동의어 확장, 부정문 이해가 없는 단순 비교 기준이며 운영 fallback이 아니다.
3. `semantic`: 외부에서 실제 의미 검색을 실행해 저장한 후보 ID 목록을 읽는다. 스크립트가 모델 결과를 만들거나 라벨에서 정답을 생성하지 않는다.

`keyword` 비교는 실행 한 번 안에서 공고별 토큰을 한 번만 계산해 여러 질문에 재사용한다. 실행 사이의
전역 캐시는 없으며 점수·동점 정렬·평가 결과는 동일하다. 이는 오프라인 평가 도구 최적화이고 운영 검색의
검색 품질이나 API 응답속도 개선을 뜻하지 않는다.

기본 K는 20이다. `macroRecallAtK`는 답이 있는 질문별로 `상위 K개에 포함된 관련 공고 수 / 전체 관련 공고 수`를 계산한 뒤 평균한다. 정답이 여러 개인 Q28에서는 두 공고 모두 찾아야 1이다. 답이 있는 질문이 없으면 `null`로 표시한다.

수동 `semantic` 비교는 후보 단계의 `macroRecallAtK`와 `noMatchFalsePositiveRate`를 계산한다.
`--capture`는 실제 검색 흐름을 두 단계로 나눠 계산한다.

- `candidate`: 실제 점수화에 전달한 후보 최대 20개의 `macroRecallAtK`, `noMatchFalsePositiveRate`
  (현재는 Qdrant 의미 검색·키워드 순위를 결합한 후보이며 과거 캡처는 당시 검색 방식 유지)
- `final`: AI 최종 추천 최대 5개의 `macroRecallAt5`, `mrrAt5`, `noMatchFalsePositiveRate`

`MRR@5`는 첫 관련 공고가 앞에 있을수록 높다. 이진 관련성 라벨만 있으므로 nDCG나 지원대상·지역
자격 판단 정확도는 계산하지 않는다. 응답 시간·비용도 이 도구의 지표가 아니다.

무결과 질문은 Recall 분모에 섞지 않는다. `noMatchFalsePositiveRate`는 정답이 없는 질문 중 후보를 1개 이상 반환한 비율이다. 이 수치는 **후보 검색 단계**의 무결과 처리만 측정한다. 후보 검색이 넓게 찾고 이후 순위화에서 제외하는 설계라면, 최종 추천의 오추천 비율을 별도 측정해야 한다. 이 소규모 자료만으로 점수 임계값을 결정하면 안 된다.

`perQuery`에서 누락된 정답과 반환 ID를 확인할 수 있다. 후보 20개와 최종 5개는 서로 다른 단계이므로
하나의 Recall 수치로 합치지 않는다.

이 가상 자료에서 최신 20개 기준의 Recall@20은 약 0.077, 단순 키워드 기준은 1.0이다. 40개 중 최대 20개를 고르는 작은 자료이므로 키워드 기준도 모든 관련 공고를 포함할 수 있다. 이는 벡터 검색의 우월성을 입증하지 않으며, Recall이 높아도 불필요한 후보가 함께 포함되거나 최종 추천 순서가 나쁠 수 있다. 의미 검색 결과와 더 현실적인 자료를 확보하기 전에는 개선 수치를 주장하지 않는다.

## 기존 의미 검색 후보 파일 비교

현재 4단계의 동일 캡처 전후 비교는 `compare-captures.py`를 사용한다.
같은 fixture·질문·카탈로그·기준일·후보 한도를 검증하고 기존 양성 질문만으로 Recall/MRR을 비교한다.
검토 CSV의 연결 해시를 확인하며 missing/blank/unclear를 무관으로 처리하지 않는다.
출력 덮어쓰기는 금지한다. [실데이터 전후 비교와 실행 명령](runs/support-program-catalog-20260906-v1/stage4-v1/README.md)을 참고한다.

최종 추천 프롬프트만 비교할 때는 `replay-ranking.py`와 `evaluate-ranking-replay.py`를 사용한다.
기존 캡처의 후보 20개와 전체 요청을 고정하고 전후를 각각 호출한 뒤, 동일 후보 분모로 기존 판정의
관련 공고 유지율·무관 공고 선택률을 따로 계산한다. 미판정·unclear와 기존 공식 제외 질문을 유지한다.
실행기는 기본 dry-run(API 0회)이며 `--execute`에서만 실제 API를 최대 32회 호출한다.
저장된 보고서 재계산에는 API 키·DB가 필요 없다.
[4단계 2차 자료와 재현 명령](runs/support-program-catalog-20260906-v1/stage4-v2/README.md)을 참고한다.
실행기의 모의 HTTP·실패 처리 테스트까지 실행하려면 AI Service 개발 환경의 Python을 사용한다.

```bash
backend/ai-service/.venv/bin/python -B -m unittest discover \
  -s evaluation/support-program-search -p 'test_*.py'
```

가상 공고만 평가할 때는 이 공고 40개만 넣은 **평가 전용 Qdrant 컬렉션/환경**에서 질문을 실행한다.
운영 공고 색인에 `SYNTH_*` 공고를 넣거나 운영 공고와 섞어 비교하지 않는다.

원문은 `docs[].text` 그대로 사용하고, 반환 후보를 공고 ID로 바꿔 JSON 파일에 저장한다. 입력 구조는 다음과 같다. 아래는 형식 예시일 뿐 실제 모델 결과가 아니며, 전체 실행에는 선택한 분할의 모든 라벨된 질문 결과가 필요하다.

```json
{
  "Q01": ["SYNTH_AI_SEOUL", "SYNTH_AI_EDUCATION"],
  "Q19": []
}
```

```bash
python3 evaluation/support-program-search/evaluate.py --semantic-results /path/to/captured-candidate-ids.json
```

질문 키가 빠진 것은 실행하지 않은 경우로 취급해 오류를 낸다. 실제 검색을 실행한 결과가 비어 있을 때만 `[]`를 쓴다. 알 수 없는 공고 ID·질문 ID·중복 반환 ID도 오류다. `--split dev`에서는 개발용 질문 결과만 있어도 된다. 외부 결과 파일과 함께 모델, 임베딩 차원, 검색 설정, 실행 일시, 데이터 버전(`synthetic-support-program-retrieval-v1`)을 기록해야 재현할 수 있다.

## 실제 데이터 fixture 초안 내보내기

실데이터 평가를 시작할 때는 수작업으로 전체 공고를 복사하지 않고 `evaluation-fixture-export` Spring profile을
실행한다. 이 비웹 profile은 현재 MySQL에서 **색인이 준비된 제공처**의 공개 공고 중 지정한 `referenceDate` 기준 `OPEN` 공고만 읽고, 운영 검색과 같은
`SupportProgramIndexDocumentMapper`로 `id`·`contentHash`·`text`를 만든다. 따라서 생성 파일에는 전체 적격
카탈로그의 공고 수·지문·검색 문서가 들어가며, 이후 캡처 파일과 같은 스냅샷인지 검증할 수 있다.

제공처별 부분 검색 도입 이후 내보내기와 실제 검색 캡처는 모두 `findSearchablePresent()`를 사용한다.
`catalog.presentProgramCount`도 색인이 준비된 제공처의 공개 공고 수(접수 상태 필터 전)이다.
미준비 제공처는 양쪽에서 제외되며, 다른 시점에 공개 카탈로그나 준비 상태가 달라지면 기존 지문 검증이 불일치를 거부한다.
기존에 공유한 고정 평가 파일과 점수는 변경하지 않는다. 이 profile은 색인을 준비하지 않으므로 필요한 제공처의
동기화·복구가 끝났는지 먼저 확인한 후 새 fixture와 캡처를 같은 범위에서 생성한다.

이 profile은 웹 서버, 기업마당 동기화, 누락 색인 복구를 시작하지 않으며 Qdrant·AI Service·OpenAI도 호출하지
않는다. `name`, `referenceDate`, 출력 경로는 실행 환경에서 반드시 지정한다. `referenceDate`는 실행한 날의
오늘이 아니라 저장된 신청 시작·종료일로 접수 상태를 다시 계산하는 평가 기준이다.

```bash
cd backend/core-service
./gradlew bootJar

SPRING_PROFILES_ACTIVE=evaluation-fixture-export \
APP_SUPPORT_PROGRAM_SEARCH_FIXTURE_EXPORT_NAME=support-program-catalog-20260905-v1 \
APP_SUPPORT_PROGRAM_SEARCH_FIXTURE_EXPORT_REFERENCE_DATE=2026-09-05 \
APP_SUPPORT_PROGRAM_SEARCH_FIXTURE_EXPORT_OUTPUT_PATH=/absolute/path/support-program-fixture.json \
java -jar build/libs/govbiz-core-service-0.0.1-SNAPSHOT.jar
```

출력의 `dataType`은 `real_catalog_snapshot_unlabeled`이고 `cases`는 빈 배열(`[]`)이다. 이 파일만으로는
점수를 계산할 수 없다. 내보내기는 빈 적격 카탈로그, 빈 `sortTimestamp`, 중복 검색 문서 ID 등의 검증에
실패하면 기존 출력 파일을 보존하며, 모든 검증이 성공한 결과만 원자적으로 교체한다. 실제 공고의 검색용 내용이
포함될 수 있으므로 제공처 이용 조건과 저장·공유 범위를 검토한 뒤 보관한다.

## 실제 검색 흐름 캡처

`evaluation-capture` Spring profile은 공개 HTTP endpoint를 추가하지 않는다. 이미 동기화되어 있는 MySQL
공고를 읽어, 같은 `referenceDate`의 접수 상태로 각 질문에 대해 실제 `검색 → Qdrant 후보 선정 → AI 최종 추천` 흐름을 한 번 실행하고 결과를
하나의 JSON 파일로 저장한다. profile 자체가 웹 서버와 두 동기화 스케줄러를 끄므로, 캡처 도중 새 스냅샷이
공개되는 일을 이 프로세스가 만들지 않는다. 별도로 실행 중인 Core API가 카탈로그를 갱신할 수는 있으나,
질문 하나라도 실패하거나 카탈로그 지문이 질문 사이에 바뀌면 기존 결과 파일을 교체하지 않는다.

이 실행은 연결된 AI Service를 통해 실제 OpenAI 임베딩·점수화를 호출할 수 있어 비용이 발생할 수 있다.
CI나 기본 Compose 검증에서는 실행하지 않는다.

질문 묶음은 [query-set.example.json](query-set.example.json)과 같은 구조를 사용한다. 질문과 `split`은 측정 전에
고정한다. 사람 검토 도구를 사용하면 먼저 후보를 캡처하고 검토표에서 정답을 확정한 뒤 fixture의 `cases`로
변환할 수 있다. 직접 라벨링할 때는 빈 `cases`에 `id`·`query`·`split`·`relevantIds`를 넣는다.
질문 묶음의 `name`을 fixture의
`name`과 같게 하고, 모든 `id`·`query`·`split`을 fixture의 `cases`와 같은 순서·내용으로 넣는다. 이 세 값과
fixture의 `name`에는 앞뒤 공백을 넣지 않는다. 공백이 있으면 실행한 검색어와 평가 fixture의 식별자가 달라질
수 있어 오류로 처리한다.

```json
{
  "schemaVersion": "support-program-search-query-set-v1",
  "name": "support-program-catalog-20260905-v1",
  "queries": [
    {"id": "Q01", "query": "서울 소재 AI 제품 개발비 지원사업", "split": "dev"}
  ]
}
```

Core API JAR를 만든 뒤, 실제 MySQL과 AI Service에 연결되는 환경에서 다음처럼 실행한다. fixture 내보내기가
지정 기준일의 `OPEN` 공고만 담으므로 캡처는 기본값인 `acceptingOnly=true`와 fixture의 같은
`referenceDate`로 실행한다. 출력 경로는 입력 경로와 달라야 한다.

```bash
cd backend/core-service
./gradlew bootJar

SPRING_PROFILES_ACTIVE=evaluation-capture \
APP_SUPPORT_PROGRAM_SEARCH_CAPTURE_QUERY_SET_PATH=/absolute/path/queries.json \
APP_SUPPORT_PROGRAM_SEARCH_CAPTURE_OUTPUT_PATH=/absolute/path/capture.json \
APP_SUPPORT_PROGRAM_SEARCH_CAPTURE_REFERENCE_DATE=2026-09-05 \
java -jar build/libs/govbiz-core-service-0.0.1-SNAPSHOT.jar
```

캡처 v2에는 질문 묶음 지문, 실행 시각, 기준 날짜, 접수 중 필터 여부, 현재·적격 공고 수, 적격 공고의 ID·내용 해시 지문,
후보 최대 20개와 최종 최대 5개의 제공처 포함 ID가 들어간다. 지문은 동일 공고 스냅샷에서 얻은 결과인지
확인하기 위한 값이며 원문이나 비밀정보를 저장하지 않는다.

## 실제 데이터 라벨·캡처·평가

가상 자료의 통과를 제품 정확도 개선으로 보고하지 않는다. 실제 평가에는 특정 시점의 공고를 고정하고,
대표 사용자 질문에 선택한 검토 방식으로 관련·제외 공고를 라벨링한 fixture가 필요하다. AI 판정인지 사람 판정인지
출처를 함께 기록해야 한다. 캡처 호환 fixture는 후보·최종
ID만 일부 담는 파일이 아니라 **캡처 시점의 전체 적격 공고 카탈로그**를 담아야 한다. 그래야 같은 ID가
다른 내용으로 갱신된 경우에도 평가를 거부할 수 있다.

실행 순서는 다음과 같다. (1) 평가 기준 날짜를 정하고 `evaluation-fixture-export`로 해당 날짜의 카탈로그 초안을 만든다. (2) `cases: []`에
질문과 정답을 선택한 검토 방식으로 라벨링한다. (3) 같은 `name`·`id`·`query`·`split`의 질문 묶음을 만든다. (4) 기본
`acceptingOnly=true`와 **같은 `referenceDate`**의 `evaluation-capture`로 실제 후보·최종 추천을 기록한다. (5) fixture와 capture를
`evaluate.py --fixture ... --capture ...`에 전달한다. `relevantIds: null`은 미라벨이므로 점수 계산에서 제외한다.

- 내보내기 결과의 `dataType`은 `real_catalog_snapshot_unlabeled`이다. 라벨링이 끝난 파일은 예를 들어
  `real_labeled_catalog_snapshot`처럼 자료 성격을 명시한다.
- `catalog`의 `presentProgramCount`, `eligibleProgramCount`, `eligibleCatalogFingerprint`은 capture 파일의
  `catalog`과 정확히 같아야 한다.
- `referenceDate`는 `YYYY-MM-DD` 형식이어야 하며 fixture와 capture가 정확히 같아야 한다. 이전 v1 capture는
  이 날짜를 기록하지 않았으므로 현재 평가기에 사용할 수 없다. 날짜가 바뀌면 접수 상태와 적격 공고 집합도
  바뀔 수 있기 때문이다.
- `docs` 수는 `eligibleProgramCount`와 같아야 한다. 각 `docs[].id`와 `relevantIds`는
  `{sourceCode}:{sourceProgramId}` 형식이다. 예를 들어 `BIZINFO:PBLN_123`와 `OTHER:PBLN_123`은 원본 ID가
  같아도 서로 다른 공고다. `sourceCode`는 `[A-Z][A-Z0-9_]{0,63}` 형태의 안정적인 제공처 코드이고, 원본 ID는
  첫 번째 `:` 뒤의 전체 문자열로 취급한다. 각 행은 Core의 `SupportProgramIndexDocumentMapper`가 만든 검색 문서의
  `contentHash`(소문자 SHA-256)를 포함해야 한다.
- 평가기는 각 `docs[].text`의 UTF-8 SHA-256이 `contentHash`와 일치하는지 확인하고,
  `id:contentHash`를 ID 순서로 정렬해 만든 지문도 다시 계산한다. 즉 다른 날의 capture, 공고가 누락된
  fixture, 바뀐 공고 내용이나 내용 해시는 모두 오류가 된다.

기존 가상 fixture의 `SYNTH_*` ID는 기존 `--semantic-results` 비교 전용으로 유지한다.

```json
{
  "name": "support-program-catalog-20260905-v1",
  "dataType": "real_labeled_catalog_snapshot",
  "referenceDate": "2026-09-05",
  "catalog": {
    "presentProgramCount": 2,
    "eligibleProgramCount": 2,
    "eligibleCatalogFingerprint": "52434f38518394de4ab360f85e4ae132a23bbebe5908dee143762270fe2ee641"
  },
  "docs": [
    {
      "id": "BIZINFO:PBLN_123",
      "contentHash": "ea87cd3309e776728d1cf1e5352de3f5256134133df956bbdebb38d38ed18a56",
      "text": "제목: 예시 공고\n기관: 예시 기관\n지원대상: 중소기업\n분야: AI\n지역: 서울\n신청기간: 상시 접수\n내용: 고정 시점의 평가용 공고 원문",
      "sortTimestamp": "20260905100000"
    },
    {
      "id": "OTHER:PBLN_123",
      "contentHash": "f29ebd37b4226d6e9259ad22447d88c9c2109ca9329ec4a2304c15b6c92ae474",
      "text": "제목: 다른 제공처 예시 공고\n기관: 다른 수행 기관\n지원대상: 중소기업\n분야: AI\n지역: 서울\n신청기간: 상시 접수\n내용: 같은 원본 ID라도 제공처가 다르면 별도 공고입니다",
      "sortTimestamp": "20260905100000"
    }
  ],
  "cases": [
    {
      "id": "Q01",
      "query": "서울 소재 AI 제품 개발비 지원사업",
      "relevantIds": ["BIZINFO:PBLN_123", "OTHER:PBLN_123"],
      "split": "dev"
    }
  ]
}
```

선택한 검토 방식과 출처가 기록된 fixture와 캡처 결과가 준비되면 다음처럼 후보·최종 추천을 분리해 평가한다.

```bash
python3 evaluation/support-program-search/evaluate.py \
  --fixture /absolute/path/labeled-fixture.json \
  --capture /absolute/path/capture.json \
  --split heldout
```

질문 키가 빠진 것은 실행하지 않은 경우로 취급해 오류를 낸다. 실제 검색 결과가 비었을 때만 `[]`를 쓴다.
알 수 없는 공고 ID, 중복 ID, 후보에 없던 최종 추천, 카탈로그 지문 형식 오류, fixture·capture 기준 날짜 불일치도 모두 오류다. `relevantIds: null`
은 미라벨이므로 점수에서 제외하며, 신청 가능 여부가 문서에서 확인되지 않으면 임의로 정답을 붙이지 않는다.
개발용과 미사용 검증용은 분리하고, 원문 저장·이용 범위는 실제 제공처 조건을 따른다.

## 실데이터 라벨링 기준

현재 production 랭킹은 검색 관련성과 자격 확인 상태를 분리한 `govbiz-support-program-ranking-v5`입니다.
`runs/`의 v3/v4 요청·응답·평가 결과는 당시 기록으로 보존합니다. 저장 결과의 API 없는 재계산은 계속 가능하지만,
구버전 요청을 현재 v5 모델 계약으로 실제 재실행하지 않습니다. 과거 호출 재현에는 해당 실행의 코드 버전이 필요하며,
v5 평가는 새 요청·캡처를 만들어 별도 실행 폴더에 기록해야 합니다. replay 실행 기록의 출력 토큰 상한도
하드코딩한 과거 값이 아니라 실행한 Agent 설정에서 읽습니다.
`replay-ranking.py`는 실제 적용되는 랭킹 모델·추론 수준을 확인해 Luna/none 이외에는 유료 호출 전에
중단합니다. production에 Sol/low를 설정했다면 재현 프로세스에서만
`OPENAI_RANKING_MODEL=gpt-5.6-luna`, `OPENAI_RANKING_REASONING_EFFORT=none`을 명시해야 합니다.
기존 25/30초 제한과 코드 버전 조건도 그대로 지켜야 합니다. `run-region-eligibility.py`는
비교 조건 보존을 위해 Luna/none을 직접 고정하며 production의 랭킹 전용 설정을 따르지 않습니다.

`searchWithTrace` 서비스 진입점은 선택적 `companyConditions`를 받아 실제 조건 검색과 같은 경로를 검증할 수 있습니다.
그러나 현재 `evaluation-capture` CLI의 query-set/capture-v2 파일은 여전히 단문 질의만 다룹니다.
기존 Recall/MRR 보고서는 대화 해석이나 기업 조건 검색까지 평가한 것으로 해석하지 않습니다.
조건 포함 실데이터 평가는 조건·기준일·후보·새 v5 결과를 함께 고정해 별도로 기록해야 합니다.

라벨은 fixture의 `docs[].text`에 적힌 내용만 근거로 만든다. 상세 원문, RAG 답변, 외부 지식으로
공고의 적합성을 보완하지 않는다.

- 질문에 명시된 목적·대상·지역 등의 조건을 **명확히** 만족하는 모든
  `sourceCode:sourceProgramId`를 `relevantIds`에 넣는다. 가장 좋은 한 건만 고르면 후보 Recall의
  정답 분모가 잘못된다.
- 고정된 전체 카탈로그에서 관련 공고가 없음을 확인한 경우에만 `relevantIds: []`를 쓴다.
  문서 정보가 부족하거나 해석 이견이 있으면 `null`로 두며, 이는 0점이나 무결과가 아니라 평가 제외다.
- 질문은 분야·목적, 지원 대상, 지역, 복합 조건, 명시적인 무관 질의를 고르게 포함한다. 질문 수를
  맞추기 위해 근거가 약한 정답을 만들지 않는다.
- `dev`와 `heldout`은 첫 캡처 전에 고정한다. 개선은 `dev` 결과와 오류 사례만 보고 수행하며,
  `heldout`은 최종 확인에만 사용한다.
- query set은 fixture와 `name`, 각 `id`·`query`·`split`, 그리고 순서까지 같아야 한다.

실제 실행마다 [실행 기록 템플릿](run-manifest.example.md)을 복사해 모델·임베딩·컬렉션·커밋·기준 날짜·파일
해시를 고정하고, [평가 보고서 템플릿](report-template.md)에 후보와 최종 추천 지표를 분리해 남긴다.
실제 공고 fixture·capture·라벨·보고서는 [runs/](runs/README.md)의 실행별 폴더에 보관한다. 협업용 고정 자료는
허용 목록으로 Git에 포함하며, 새 실행과 생성 화면·엑셀·임시 파일은 기본적으로 제외한다. 현재 공유된
[공고 1,422건·실제 캡처·전체 판정의 이어받기 안내](runs/support-program-catalog-20260906-v1/README.md)를 따른다.
실제 16개 검색 캡처와 AI-only 1차 지표는 [최종 보고서](runs/support-program-catalog-20260906-v1/review-final-v1/report.md)에 있다.
평가 가능한 질문은 6개(양성 2개)뿐이므로 일반적인 검색 품질 검증 완료로 해석하지 않는다.
다른 PC에서도 `verify-shared-run.py --with-capture`로 원표·라벨·실제 지표를 API 없이 재현할 수 있다.

## 지역 자격의 작은 합성 회귀 평가

`region-eligibility-fixture.json`은 개발 중 작성한 가상 공고 8개를 서울·서울 서초구·부산 조건에
각각 적용하는 3요청·24판정 자료다. 실제 카탈로그나 독립 heldout 자료가 아니며 기존 `runs/`의
공고·라벨·점수를 수정하지 않는다. 합성 공고를 MySQL 또는 Qdrant에 등록하지 않는다.

| 원문 사례 | 서울 | 서울 서초구 | 부산 |
| --- | --- | --- | --- |
| 서초구 소재 기업만 | UNKNOWN | MATCH | INCOMPATIBLE |
| 서울 소재 기업만 | MATCH | MATCH | INCOMPATIBLE |
| 부산 소재 기업만, 태그는 서울 | INCOMPATIBLE | INCOMPATIBLE | MATCH |
| 소재지와 관계없이 전국 신청 가능 | MATCH | MATCH | MATCH |
| 전국·서울 태그만 있고 원문 지역 요건 없음 | UNKNOWN | UNKNOWN | UNKNOWN |
| 기관·설명회 위치만 서울 서초구 | UNKNOWN | UNKNOWN | UNKNOWN |
| 서울 소재 또는 선정 후 3개월 이내 서울 이전 | MATCH | MATCH | UNKNOWN |
| 전국 신청 가능하나 서울 소재 제외 | INCOMPATIBLE | INCOMPATIBLE | MATCH |

`evaluate-region-eligibility.py`는 **외부 호출 기능이 없는 오프라인 평가기**다. `build_requests(fixture)`는
기대값과 해설을 제외한 production v5 요청만 반환한다. 신규 capture에 `scoringVersion`을 기록하며,
해당 필드가 없는 과거 v4 capture는 당시 버전으로 요청 해시를 재검증한다. 인자 없이 실행하면 이 요청 3개와
`actualApiCalls: 0`을 출력한다. 각 지역 상태를 비교하고, known 판정은 인용문이 해당 후보의
원문과 정확히 일치할 뿐 아니라 라벨의 지역 자격 구절도 포함하는지 확인한다. 예를 들어 원문에 실제로
있는 `AI 분야 기업`을 인용하더라도 서울 소재 자격을 증명하는 것으로 통과시키지 않는다.
전국 허용 뒤에 붙은 서울 제외 조건을 잘라 인용하는 경우도 실패한다.

```bash
python3 evaluation/support-program-search/evaluate-region-eligibility.py
python3 evaluation/support-program-search/evaluate-region-eligibility.py --capture /absolute/path/capture.json
backend/ai-service/.venv/bin/python -B -m unittest discover \
  -s evaluation/support-program-search -p 'test_region_eligibility.py'
```

평가용 캡처는 Service의 상위 5개 필터 **이전**에 실제 `Agent.rank()`가 반환한 모든 후보의 복원된
평가를 기록해야 한다. 최종 추천만 저장하면 제외된 후보의 잘못된 INCOMPATIBLE 판정을 놓치므로
평가기가 거부한다. 같은 Agent 호출 결과를 Service에 전달해 공개 응답도 확인할 수 있으며,
기대값으로 실제 모델 응답을 만들거나 Agent를 두 번 호출하지 않는다. 실제 실행은 사용자 승인 후
별도의 실행기가 담당하고 자동 재시도하지 않는다.

캡처의 구조는 아래와 같다. `fixtureSha256`·`requestSha256`은 기존
`evaluate-ranking-replay.py`의 `canonical_sha256` 규칙을 재사용한다. `output`에는
`SupportProgramRankingOutput.model_dump(mode="json", by_alias=True)`의 전체 결과를 넣는다.

```json
{
  "schemaVersion": "support-program-region-eligibility-capture-v1",
  "fixtureSha256": "<fixture의 canonical SHA-256>",
  "provenance": {
    "kind": "live_openai",
    "model": "<실제 실행 모델>",
    "promptSha256": "<실행 프롬프트의 SHA-256>"
  },
  "observations": [
    {
      "caseId": "REGION_SEOUL",
      "requestSha256": "<실제 전달한 요청의 canonical SHA-256>",
      "output": {"rankings": ["<모든 후보의 복원된 평가 객체>"]}
    }
  ]
}
```

위 구조는 형식 설명용이며 실행 결과가 아니다. 실제 캡처에는 3개 사례와 각각 8개 후보의 평가가
모두 있어야 한다. 평가기는 JSON을 읽고 보고서를 stdout에 출력하며 입력 파일을 수정하지 않는다.
의미 또는 근거 불일치 시 종료 코드 1, 캡처 무결성 오류 시 2를 반환한다.

출처는 `mock` 또는 `live_openai`로 명시한다. 모의 출력 테스트 통과는 평가기의 오류 감지와 계약
호환성을 검증할 뿐, OpenAI의 의미 판단 정확도를 검증하지 않는다. `live_openai`도 자체 선언만으로
실제 호출이 증명되는 것은 아니므로 보고서의 `provenanceVerified`는 항상 false이고 별도 API 사용
기록·모델·실행 프롬프트·코드 해시를 대조한다. 실제 24판정이 통과해도 이 합성 개발 사례의 통과만
보고하며 실제 공고 정확도나 전후 개선율로 일반화하지 않는다.

### 승인된 합성 지역 판정 실행

`run-region-eligibility.py`는 기본적으로 키 없이 호출 계획만 출력한다. 사용자에게 유료 호출 승인을
받은 경우에만 `--execute`로 실행하며, `--output-dir`은 아직 존재하지 않는 경로여야 한다.
현재 production Agent·Service를 그대로 사용하고 OpenAI Responses에 사례당 1회, 최대 3회만 호출한다.
공식 OpenAI 이외 주소, 변경된 모델/시간 제한, 자동 재시도·추가 요청은 허용하지 않는다.

```bash
python3 evaluation/support-program-search/run-region-eligibility.py
# OPENAI_API_KEY가 프로세스 환경에 있고 해당 유료 호출을 승인받았을 때만 실행:
python3 evaluation/support-program-search/run-region-eligibility.py --execute \
  --output-dir /absolute/path/new-region-run
```

실제 입력·프롬프트·schema 해시, 토큰 사용량, 필터 전 전체 판정 및 같은 호출의 Service 결과를
기록한다. 기대값은 모델 입력에 포함되지 않는다. 첫 실행 오류가 나면 중단하고 부분 기록과
실패 manifest를 남긴다. 종료 코드 0은 해당 합성 평가 통과, 1은 의미 평가 불합격, 2는 API·설정·
사용량 기록 등의 실행 실패다. 합성 랭킹만 실행하며 검색 임베딩·조건 해석·기존 서비스 재시작은 하지 않는다.
