# Elasticsearch Nori·BM25 키워드 후보 검색

## 적용 범위

자연어 지원사업 검색의 **기존 정규식 단어 일치 후보 선정**을 Elasticsearch 9.5.3 + Nori로 교체했다.
별도 SDK·AI provider·범용 검색 프레임워크는 추가하지 않고 Core의 기존 RestClient를 사용한다.
공고 원본은 MySQL이며 Elasticsearch와 Qdrant는 재생성할 수 있는 파생 색인이다.
필터 목록·상세·대화 기록·Redis 로그인 복원·원문 RAG 청크 검색은 변경하지 않았다.

```text
Controller → SearchService → Repository → MyBatis → MySQL: 현재 공개·준비된 적격 공고
                         → AiSupportProgramRetrievalFacade
                             → ElasticsearchSupportProgramClient → Nori·BM25 최대 20개
                             → AiSupportProgramIndexClient → AI Service → Qdrant 의미 검색 최대 20개
                             → 기존 RRF로 결합하여 최대 20개
                         → 기존 AI 랭킹 → 최종 추천 최대 5개
```

키워드 검색부터 실행하므로 Elasticsearch 장애가 확인되면 질의 임베딩·AI 랭킹을 호출하지 않는다.
정상적인 키워드 0건은 의미 검색 순위를 유지하지만, 색인 누락·통신 실패·부분 응답은 0건으로 바꾸지 않는다.
MySQL 전체 대상 조회와 ID 허용 목록 전송은 유지한다. 전체 검색 지연·토큰 사용량이 줄었다고 보장하지 않는다.

## 분석·순위와 문서 버전

- `SupportProgramIndexTextHelper`가 기존 검색 본문과 SHA-256을 만든다. Qdrant의 기존 해시는 바꾸지 않는다.
- ES 저장·질의 본문은 NFC로 정규화한다. v2는 Nori `decompound_mode=discard`, BM25 `k1=1.2`, `b=0.75`,
  `discount_overlaps=true`, `match` OR를 사용한다. 토큰이 없으면 키워드 후보는 0건이다.
- BM25 동점은 `sortTimestamp` 내림차순, 제공처 포함 ID 오름차순이다. RRF는 기존 동일 가중치
  `1 / (60 + 순위)`이며 동점은 의미 검색 순위, 제공처 포함 ID순이다.
- ES `_id`는 `(제공처 포함 ID, 본문 해시, 정렬 시각)`을 길이 접두사로 결합한 SHA-256이다.
  정렬 시각만 변경되어도 다른 버전이므로, 신규 색인 준비가 현재 공개 공고의 정렬을 덮어쓰지 않는다.
- 검색은 MySQL에서 결정한 **정확한 버전 ID 허용 목록**으로 제한한다. 이전·미공개·다른 제공처 버전은
  결과에 섞이지 않는다. 같은 요청의 global/filter aggregation으로 대상 전체의 검색 가시성도 확인한다.
- HTTP 응답의 전체 대상 수·타임아웃·샤드 실패·히트 수·중복·ID·해시·정렬 시각·점수를 검증한다.
  지역·신청 자격의 정확성을 Nori가 보장하지는 않는다. 기존 AI 자격 판정과 원문 확인이 필요하다.

### v2 한국어 분석·유사 표현 개선

설정 원본은 [support-program-lexical-v2.json](../backend/core-service/src/main/resources/elasticsearch/support-program-lexical-v2.json)이다.
v1 설정 파일과 과거 평가 보고서는 재현용으로 보존하며, 실행 중인 기존 색인을 덮어쓰지 않는다.
변경은 ES 분석 설정에 한정된다. HTTP 계약·본문/내용 해시·Qdrant·RRF·AI 랭킹·최대 후보 20개는 유지한다.

| 문제 | v2 처리 | 범위와 주의사항 |
| --- | --- | --- |
| `횡성`이 `횡`으로 분석됨 | 사용자 사전에서 명사로 보존 | `횡성군`도 `횡성`으로 일치할 수 있게 분해 |
| `소상공인`이 문맥에 따라 다르게 분해됨 | 사용자 사전에서 하나의 명사로 보존 | 질문과 공고에서 같은 단어로 처리 |
| `현장애로`·`대출이자`의 잘못된 분해 | 각각 `현장/애로`, `대출/이자`로 지정 | 공고에 없는 전문가·자격 조건을 생성하지 않음 |
| `여수로`의 복합어/구문 분기 때문에 지명 일치가 빠짐 | `mixed` 대신 `discard`로 분해된 단어를 사용 | 일반명사와 지명의 모든 중의성이 해결된 것은 아님 |
| `여행사`와 `여행업체` 표현 차이 | 양쪽을 명사로 보존하고 검색 시 `synonym_graph`로 양방향 확장 | 색인 원문과 저장 토큰에는 동의어를 추가하지 않음 |

색인 분석기는 `korean`, 검색 분석기는 `korean_search`다. 둘 다
`Nori(discard) → 품사 필터 → 한자 읽기 변환 → 소문자화`를 거치고, 검색 분석기에만 동의어 그래프를 붙인다.
`mixed`의 겹치는 토큰 위치를 그대로 동의어 입력에 넘기지 않는다.
공식 [Nori 사용자 사전](https://www.elastic.co/docs/reference/elasticsearch/plugins/analysis-nori-tokenizer)과
[검색용 동의어 그래프·필터 순서](https://www.elastic.co/docs/reference/text-analysis/analysis-synonym-graph-tokenfilter)를 따른다.

현재 동의어는 **검증된 한 묶음**만 버전별 JSON에 둔다. 사전·동의어의 런타임 편집 API나 별도 프레임워크는
추가하지 않는다. 소수 규칙을 코드 리뷰·동일 색인 재현으로 관리하기 위한 선택이며, 규칙 변경도 새 버전 색인과
재평가를 필요로 한다. 대규모 사전 관리가 필요해지면 파일/API 기반 관리로 별도 설계한다.
`lenient`는 ES가 설정 조회 시 반환하는 문자열 형식 `"false"`로 명시해 잘못된 규칙을 조용히 무시하지 않는다.

`음식점=식품접객업소`, `융자=보조금`, 지역 간 동의어는 등록하지 않는다. 관계가 있거나 단어 일부가 비슷해도
지원 대상·금융 방식이 같지는 않다. 지역은 필수 자격 필터가 아니라 검색 점수 요소로 유지한다. 관광 유치
공고의 방문 목적지를 신청 기업의 소재지로 오인해 전국 여행사를 배제하지 않는다.

316개 질문의 전후 결과·순위 하락·남은 누락·재실행 명령은
[v2 비교 보고서](../evaluation/support-program-search/runs/lexical-v2-20260913-v1/README.md)에 기록한다.
이 자료는 AI 작성 목표 공고 검색 진단이며 전체 관련 공고 Recall이나 최종 추천 정확도가 아니다.

## 동기화·준비 상태·복구

```text
제공처 전체 수집·검증
 → IndexSyncService: Elasticsearch → Qdrant 색인 준비 (DB transaction 밖)
 → 둘 다 성공한 현재 세대만 MySQL 공개 transaction
 → indexReady=true
```

ES는 스키마·분석기 설정을 검증하고 64개씩 `_mget`으로 기존 버전을 확인한다. 없는 버전만 bulk `create`한다.
개별 실패를 확인하고 refresh 후 대상 전체의 검색 가능 건수를 검증한다. Qdrant는 기존 16개 배치·재사용 정책이다.
중간 실패 시 기존 MySQL 카탈로그를 유지하며, 재시도는 이미 성공한 버전을 재사용한다.
두 색인 사이에 분산 transaction을 만들지 않는다. 미공개 버전이 남아도 검색 허용 목록에서 제외된다.

기존 복구 스케줄러가 제공처별 **두 색인**을 검증하고, 읽었던 공개 세대·지문·공고 수가 같은 경우에만
준비 상태를 갱신한다. 한 제공처 실패가 다른 제공처 공고를 삭제하지 않는다.
`indexReady`는 마지막 전체 색인 준비 결과이며 실시간 Elasticsearch/Qdrant health는 아니다.
ES 직접 실패는 공개 503 `SUPPORT_PROGRAM_SEARCH_INDEX_UNAVAILABLE`이다. 복구가 먼저 모든 제공처를
미준비로 기록하면 기존 전체 미준비 계약인 503 `AI_SERVICE_UNAVAILABLE`이 사용된다. 둘 다 검색 실패이며
빈 성공 응답이 아니다. Frontend는 기존 일반 검색 실패·재시도 동작을 사용한다.

### 기존 환경 업그레이드

복사해서 실행할 명령과 제공처별 준비 확인 기준은
[인프라 README의 기존 환경 갱신 절차](../infrastructure/README.md#백엔드-변경-반영과-화면api-버전-불일치)에서 관리합니다.
아래는 순서와 데이터·비용 경계 요약입니다. 이 문서 갱신 자체가 개발 환경에 배포했다는 뜻은 아닙니다.

1. DB·볼륨 백업과 기존 예약 작업을 확인한다. 특히 큐를 활성화하면 기존 리포트 작업이 실행될 수 있으므로
   Elasticsearch 배포를 이유로 RabbitMQ/메일/새 수집을 임의로 켜지 않는다.
2. Nori가 설치된 Elasticsearch를 먼저 시작하고 Core를 새 빌드로 배포한다.
3. Flyway `V24`는 이전의 **Qdrant만 확인한 `index_ready`를 false로 재설정**한다.
   공고·공개 세대·지문·건수·동기화 성공/실패 시각·대화 기록은 삭제하지 않는다. 적용 이력을 수정하지 않는다.
4. `SUPPORT_PROGRAM_INDEX_ENABLED=true`로 복구를 실행해 기존 MySQL 공고를 두 색인에 확인한다.
   ES 색인은 AI API를 쓰지 않는다. **Qdrant에 없는 버전이 있으면 기존 임베딩 API 비용은 발생할 수 있다.**
5. `/api/v1/support-programs/readiness`의 `sources`에서 사용하려는 제공처별 `indexReady`와 검색 상태를 확인한다.
   최상위 `indexReady=true`만으로 모든 제공처가 준비됐다고 판단하지 않는다. 이는 한 제공처 이상 준비됐다는 뜻이다.
   복구 전 자연어 검색은 제한되지만 기존 공개 필터 목록·상세는 사용할 수 있다.

복구를 꺼 둔 환경에서는 새 빌드만 올렸다고 검색 준비가 끝나지 않는다. 장애 복구는 정상 색인을 준비하여
상태를 재검증하는 방식이며, 검증 없이 SQL로 `index_ready=true`를 강제하지 않는다.

### v1 → v2 분석기 업그레이드

1. `.env` 또는 배포 환경에 이전 이름을 명시했다면 `ELASTICSEARCH_INDEX_NAME=govbiz-support-program-lexical-v2`로
   변경한다. 기존 이름을 그대로 쓰면 색인 준비 단계의 스키마·분석기 검증에서 실패한다. 다른 이름을 사용하는
   환경도 **아직 존재하지 않는 별도 인덱스 이름**을 선택한다.
2. 정비 시간에 새 Core 빌드를 배포하고 기존 색인 복구로 MySQL의 공개 공고를 v2에 재색인한다.
   v2용 DB migration은 추가하지 않으며, v1 인덱스·MySQL 공고·Qdrant 벡터를 삭제하지 않는다.
3. `indexReady`는 마지막 복구 결과라서 전환 직후의 v2 가시성을 실시간으로 보증하지 않는다. 복구 완료와
   제공처별 준비 결과를 확인한 뒤 검색을 개방한다. 준비 전 요청은 색인 누락을 명시적 오류로 처리할 수 있다.
   ES 재색인 자체는 유료 API를 쓰지 않지만 기존 복구 경로는 Qdrant도 확인하므로 누락 벡터 생성 비용에 주의한다.
4. 문제가 생기면 이전 Core 빌드와 이전 인덱스 이름을 **함께** 되돌린다. 새 코드에 v1 이름만 지정하는 것은
   롤백이 아니다. 두 버전의 같은 프로세스 내 실시간 전환이나 무중단 alias 전환은 이번 범위가 아니다.

이 변경의 검증은 별도 공개 스냅샷·Testcontainers·로컬 API 스텁에서 수행한다. 개발 환경의 실제 동기화나
유료 임베딩을 임의로 시작하지 않는다.

## 실행 설정과 한계

| 설정 | 기본값/역할 |
| --- | --- |
| `ELASTICSEARCH_BASE_URL` | 호스트 실행 `http://127.0.0.1:9200`, Compose는 `http://elasticsearch:9200` 고정 (`.env` 덮어쓰기 없음) |
| `ELASTICSEARCH_INDEX_NAME` | `govbiz-support-program-lexical-v2`; 단일 인덱스 이름만 허용 |
| `ELASTICSEARCH_API_KEY` | 선택 API Key. 저장소에 실제 키를 기록하지 않는다 |
| `ELASTICSEARCH_CONNECT_TIMEOUT` / `ELASTICSEARCH_READ_TIMEOUT` | `2s` / `10s` |
| `SUPPORT_PROGRAM_INDEX_ENABLED` | 기존 정기 복구 활성화. 공개 전 필수 색인을 생략하는 설정은 아님 |

Compose는 Nori 설치 이미지를 빌드하고 `elasticsearch-data` 볼륨을 사용한다. 9200을 호스트에 공개하지 않는다.
단일 노드·1 shard·0 replica·512MiB heap·컨테이너 2GiB 제한은 개발용 기본값이며 고가용성 구성이 아니다.
개발 Compose는 인증이 꺼져 있으므로 공용 서버에서는 TLS·인증·최소 권한·네트워크 제한을 별도 구성한다.
기존 스키마를 조용히 덮어쓰지 않으며 분석기 변경 시 새 버전 인덱스와 통제된 재색인이 필요하다.

현재는 이전 버전을 자동 삭제하지 않는다. 용량이 증가하고, 검색에서 제외된 이전 버전도 BM25의 인덱스
통계에 영향을 줄 수 있다. 재현 가능한 평가에는 고정 스냅샷만 넣은 새 격리 인덱스를 사용한다.
대규모 부하·안전한 구버전 정리·alias 원자 전환은 이번 범위가 아니다.

## 검증과 품질 주장 범위

Core 테스트는 실제 MySQL 8.4 migration과 production Dockerfile의 ES·Nori 통합 테스트를 포함한다.
Compose 검증은 실제 MySQL·ES·Qdrant와 **로컬 OpenAI 스텁**으로 공개 순서, 검색, ES 중단·영속 볼륨 복구를 확인한다.
실행 명령은 Core에서 `JAVA_HOME=<JDK21> ./gradlew clean build --no-daemon`, 저장소 루트에서
`VERIFY_COMPOSE_PROJECT_NAME=<새 검증 이름> VERIFY_COMPOSE_MYSQL_HOST_PORT=<빈 포트> bash infrastructure/scripts/verify-compose.sh`다.
기존 개발 Compose 프로젝트 이름을 검증 이름으로 사용하지 않는다.

Docker 메모리가 작은 개발 환경에서는 Core 전체 테스트와 Compose 검증을 순서대로 실행한다.
Core 테스트는 `JAVA_TOOL_OPTIONS='-Dspring.test.context.cache.maxSize=2'`를 해당 명령에만 지정해
보관하는 Spring 테스트 환경·MySQL 컨테이너 수를 줄일 수 있다. 테스트를 생략하거나 production 설정을 바꾸는 옵션은 아니다.

[48개 질문 진단](../evaluation/support-program-search/runs/elasticsearch-korean-queries-20260912-v1/README.md)은
**16개 목표 공고 × 3개 문장 형태의 AI 작성 진단**이다. 사람 검증 정확도나 전체 Recall이 아니다.
기존 실험 보고서·라벨은 변경하지 않는다. 이번 통합 검증을 실제 AI 최종 추천 품질 측정으로 표현하지 않으며,
운영 하이브리드 변경 전후의 실데이터 평가와 전체 응답시간 비교는 별도 승인·측정이 필요하다.

### 2026-09-12 구현 검증 결과

- JDK 21 `clean build`: Core 1,233건 통과, 실패·오류·skipped 0건. 기본 제외 대상인 `live-source` 실 API 검사는 실행하지 않았다.
  실제 ES·Nori 통합 4건, MySQL Flyway 검증 4건을 포함한다. 낮은 메모리 실행 설정은 위 명령 설명과 같다.
- Frontend: Node 24·pnpm 11.22 환경에서 1,044건 통과, lint·build 통과.
  첫 병렬 실행의 기존 화면 테스트 1건 시간 초과는 `pnpm test --maxWorkers=2` 전체 재실행에서 해소했다.
- 인프라 스크립트 25건 통과. Elasticsearch가 없거나 중단된 환경에서는 백엔드만 잘못 교체하지 않는다.
- 격리 Compose `govbiz-verify-es-20260912-b`: 4개 제공처의 테스트 공고 42건 동기화·검색,
  Elasticsearch 중단 시 명시적 503·MySQL 목록 보존·같은 볼륨 재생성 후 검색 복구 통과.
  기존 Redis·RabbitMQ·Qdrant·AI Service 장애 복구도 통과했다. 첫 실행의 로그인 요청 시간 초과 후
  다른 전체 테스트와 겹치지 않는 별도 실행으로 검증했다. OpenAI는 로컬 스텁만 사용했다.
- 검증용 컨테이너·볼륨은 정리했다. **기존 `govbiz` 개발 Docker·DB에는 아직 배포하거나 V24를 적용하지 않았다.**
  실제 화면에서 새 후보 검색을 사용하려면 위 업그레이드 절차가 남아 있다. 이 기록은 유료 실데이터 품질 평가가 아니다.

### 2026-09-13 v2 검증 결과

- 최신 코드 JDK 21 `clean build`: **1,261건 통과**, 실패·오류·skipped 0건. 실제 ES·Nori 통합 9건 포함.
- 검색 평가 도구 139건(실제 ES 통합 포함), 검토 도구 108건, 인프라 스크립트 25건 통과.
- 같은 300개 질문의 목표 Hit@20은 295→299, MRR@20은 0.906111→0.933764다. 추가 16개는 양쪽 모두
  Hit@20 16/16이다. 기존 9개 질문의 순위 하락·남은 누락 1개도 [비교 보고서](../evaluation/support-program-search/runs/lexical-v2-20260913-v1/README.md)에 보존했다.
- 격리 Compose 전체 검증 통과: 새 v2 색인·4개 제공처 검색, ES 중단/영속 볼륨 복구,
  기존 Redis·RabbitMQ·Qdrant·AI Service 장애 복구. 모델 API는 로컬 스텁만 사용했다.
- 검증용 컨테이너·볼륨은 정리했다. **기존 개발 Docker에는 v2를 배포하거나 실제 공고를 재색인하지 않았다.**
