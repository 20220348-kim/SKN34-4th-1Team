# 4단계 2차 — 고정 후보의 지원 목적 판단 비교

이번 작업은 **후보 검색을 바꾸지 않고 최종 추천의 지원 목적 판단만 비교**한다.
실행 전 기준은 [plan.md](plan.md)에 고정했다. 기존 라벨·3단계 보고서·4단계 1차 캡처는 수정하지 않는다.

## 공유 자료

| 파일 | 역할 |
|---|---|
| `requests.json` | 고정 16개 질문과 각 후보 20건의 실제 Core 형식 요청 |
| `metadata.json` | 읽기 전용 DB 복원 검증·스냅샷·컴파일된 Core 클래스 해시 |
| `RankingRequestExport.java` | 요청 복원에 사용한 일회성 측정 코드. production에 포함하지 않음 |
| `before-prompt.txt` / `after-prompt.txt` | 측정한 기존·개선안 프롬프트 원문 |
| `replay/results.jsonl` | production HTTP 응답 검증을 통과한 변형별 추천과 입력·프롬프트 해시 |
| `replay/api-usage.jsonl` | API 호출 수·시간·응답 상태·토큰 사용량. 인증 헤더·키 없음 |
| `replay/execution-manifest.json` | 모델·설정·실행 상태·사용량·코드 및 입출력 해시 |
| `runner-at-execution.py` | 측정 시작 시 실행기 소스 보관본. 직접 실행용이 아닌 해시 감사용 |
| `diagnostic.json` | 동일 후보와 기존 AI 판정에 대한 전후 진단 |

요청은 기준 코드 `0481abb`에서 사용하는 기존 Core JAR을 재사용해 복원했다. JAR SHA-256은
`817cc572c92763dc27ecdf11197130a2c03971133c45e6ffc5f489f409774ba6`이다.
JDK 21로 JAR의 `BOOT-INF/classes`, `BOOT-INF/lib/*`를 임시 디렉터리에 풀어
동봉한 Java 코드를 `javac -cp 'BOOT-INF/classes:BOOT-INF/lib/*' RankingRequestExport.java`로
컴파일했다. 실행 인수는 `CAPTURE FIXTURE QUERY_SET NEW_OUTPUT_DIRECTORY` 순서다.
여기서 입력은 각각 `../stage4-v1/capture.json`, `../fixture-unlabeled.json`, `../query-set.json`이다.
보고서 계산에 쓰는 `../review-final-v1/fixture-labeled.json`과 복원용 unlabeled fixture를 구별한다.
DB 연결은 `SPRING_DATASOURCE_URL`, `SPRING_DATASOURCE_USERNAME`, `SPRING_DATASOURCE_PASSWORD`로만 주입했다.
동기화·색인·Flyway·HTTP 서버는 시작하지 않았다. 공유 파일에는 DB 비밀번호나 `.env`를 포함하지 않는다.

DB 복원 과정은 과거 payload 바이트의 증명이 아니다. 전체 색인 본문과 그 contentHash가 일치하는 현재
구조화 데이터를 기존 Core Mapper로 변환한 요청이며, **전후 실험끼리의 요청은 완전히 동일**하다.
이후 개발자가 기존 측정을 다시 계산할 때는 DB 복원이나 Java 실행이 필요 없다.

## API 없이 보고서 다시 계산

저장소 루트에서 실행한다. 기존 출력 파일은 덮어쓰지 않는다.

```bash
RUN=evaluation/support-program-search/runs/support-program-catalog-20260906-v1
python3 -B evaluation/support-program-search/evaluate-ranking-replay.py \
  --fixture "$RUN/review-final-v1/fixture-labeled.json" \
  --reviewed-csv "$RUN/review-final-v1/selected-ai-transfer-v1/reviewed.csv" \
  --requests "$RUN/stage4-v2/requests.json" \
  --source-capture "$RUN/stage4-v1/capture.json" \
  --results "$RUN/stage4-v2/replay/results.jsonl" \
  --output /tmp/govbiz-ranking-replay-diagnostic.json
cmp /tmp/govbiz-ranking-replay-diagnostic.json "$RUN/stage4-v2/diagnostic.json"
```

이 명령은 저장된 실제 응답을 계산하며 새로운 AI 판정·검색·유료 API 요청을 만들지 않는다.
`knownPositiveCandidateRetention`은 기존 판정상 관련 있는 고정 후보 중 최종 추천에 남은 비율,
`knownNegativeSelectionRate`는 기존 판정상 무관한 고정 후보 중 잘못 선택한 비율이다.
둘 다 전후 분모가 동일한 **기존 판정 쌍의 진단 지표**이며 전체 공고의 Recall/Precision이 아니다.
`unclear`·미판정은 음성으로 세지 않고 별도 표시한다. 공식 제외 질문 10개도 그대로 제외한다.

## 선택적 실제 API 재실행

실제 API 재실행은 비용이 발생한다. 먼저 AI Service의 잠긴 개발 의존성을 설치하고 저장소 루트에서
아래 검증 명령을 실행한다. **기본값은 API 0회**이며 API 키도 필요 없다.

```bash
RUN=evaluation/support-program-search/runs/support-program-catalog-20260906-v1
backend/ai-service/.venv/bin/python evaluation/support-program-search/replay-ranking.py \
  --requests "$RUN/stage4-v2/requests.json" \
  --export-metadata "$RUN/stage4-v2/metadata.json" \
  --source-capture "$RUN/stage4-v1/capture.json" \
  --fixture "$RUN/review-final-v1/fixture-labeled.json" \
  --before-prompt "$RUN/stage4-v2/before-prompt.txt" \
  --after-prompt "$RUN/stage4-v2/after-prompt.txt" \
  --output-dir /tmp/govbiz-ranking-replay-new
```

실제로 새 측정이 필요할 때만 `OPENAI_API_KEY`를 안전하게 환경변수로 주입하고 위 명령에 `--execute`를
추가한다. 실행기는 `.env`를 자동으로 읽거나 출력하지 않는다. 모델 `gpt-5.6-luna`, 모델/Agent 제한시간
25/30초와 현재 production 프롬프트 일치를 확인한다. 새 출력 디렉터리를 써야 하며
16개 질문 × 두 변형 = 최대 32회, 재시도 0회, 임베딩 0회다. 한 번이라도 실패하면 중단하고 실패 자료를 보존한다.

이 재실행은 **HTTP API → Service → Agent → OpenAI → Response**를 in-process ASGI로 호출한다.
DB·Qdrant·Core 서버·브라우저를 통과하는 새 전체 검색이 아니며 그 응답시간으로 해석하면 안 된다.
모델 출력 변동성 때문에 저장된 보고서의 정확한 재계산과 새로운 API 결과의 재현은 구별한다.

실행 도중 오프라인 테스트가 발견한 종료 처리의 종료코드 문제를 실행기에 보완했다.
측정 시작 시 코드 해시는 `runner-at-execution.py`와 비교한다. 현재 실행기는 자원 정리 오류에도
실패 manifest를 먼저 보존한 뒤 비정상 종료하고, 실패로 사용량이 누락되면 0이 아닌 null로 표시한다.
프롬프트·모델 호출·추천 처리에는 차이가 없다. 이번 측정은 모든 사용량 수신 여부를 별도로 확인한다.
실행 보관본을 다른 위치에서 직접 실행하지 말고 위의 현재 실행기 명령을 사용한다.

## 지침 참고

작업별 평가 조건을 고정하고 같은 입력에서 변경을 비교하는 방식은
[OpenAI 평가 안내](https://developers.openai.com/api/docs/guides/evaluation-best-practices)를 참고했다.
이 프로젝트의 참조 정답은 AI 합의이며 사람 검증이나 통계적 우월성을 주장하지 않는다.

## 실제 결과

2026-09-06 22:14:41–22:23:04 KST에 전후 각 16회, 총 32회 랭킹이 모두 성공했다.
실행 전 채택 기준 6개를 모두 통과해 개선 프롬프트를 production에 반영한다. 모델·점수 계약 v3·
자격 UNKNOWN 정책·최소 점수·추천 한도·후보 검색은 바꾸지 않았다.

| 기존 AI 판정 쌍에 대한 진단 | before | after |
|---|---:|---:|
| dev 관련 최종 추천 | 15 | 16 |
| dev 무관 최종 추천 | 6 | 4 |
| dev 관련 후보 유지율 (고정 분모 17) | 88.24% | 94.12% |
| dev 무관 후보 선택률 (고정 분모 129) | 4.65% | 3.10% |
| dev 미판정 최종 추천 | 9 | 7 |
| heldout 관련 최종 추천 | 5 | 5 |
| heldout 무관 최종 추천 | 5 | 5 |
| 전체 관련 / 무관 / 미판정 최종 추천 | 20 / 11 / 13 | 21 / 9 / 10 |
| 랭킹 API 평균 응답시간 | 14.739초 | 16.559초 |
| 랭킹 input tokens | 122,692 | 127,588 |
| 랭킹 output tokens | 31,313 | 34,472 |

추천 개수만 줄여 지표를 좋게 만든 것은 아니다. dev의 관련 추천이 1건 늘면서 무관 추천이 2건 줄었다.
before의 관련 1위였던 dev 8개 질문은 after에서도 관련 1위였다.
공식 양성 Q02의 최종 pooled Recall/MRR은 `0.5/1.0`, Q14는 `1.0/1.0`으로 전후 동일하다.
양성 2개 평균 최종 Recall `0.75`, MRR `1.0`도 유지됐다. 후보는 고정했으므로 후보 Recall은 개선하지 않았다.
무결과 Q09·Q10·Q15·Q16은 두 변형 모두 빈 목록이었다.

### 개선 범위와 남은 문제

- **dev 무관 추천 6 → 4건**으로 부분 개선됐지만, heldout 무관 추천은 5건 그대로다.
  전체 9건의 알려진 오추천이 남아 있으므로 지원 목적 판단을 해결 완료했다고 주장하지 않는다.
- Q02의 무관 추천과 Q07의 해외 전시회 공고가 이번 after에서 제외됐다.
  Q04의 행사 부대 통역·전시 지원 3건과 Q06의 업종이 다른 시험·인증 지원 1건은 dev에서 남았다.
- 과거 stage4-v1의 dev 무관 추천은 7건이었지만 이번 동시기 before는 6건이다.
  동일 프롬프트도 결과가 변하므로 과거 7건과 새 4건을 단순 비교해 프롬프트 효과로 주장하지 않는다.
- 전체 최종 추천 중 미판정 10건은 기존 unclear 10건이다. 기존 후보 쌍의 미판정 89건과
  공식 제외 질문 10개는 그대로다. 이 진단은 그 질문들을 공식 평가에 다시 넣은 것이 아니다.
- 평균 API 지연은 **약 1.82초 증가**했고 출력 토큰도 늘었다. 품질 개선의 비용이며 속도 개선은 아니다.
  각 변형 1회 측정, 이미 노출된 heldout, AI-only 참조 기준이라는 한계 때문에 통계적 우월성이나
  새로운 독립 검증을 주장하지 않는다. 이번 결과로 추가 heldout 튜닝은 하지 않았다.
- 4단계는 아직 전체 완료가 아니다. **다음 우선순위는 외부 공개 전 요청량·동시 실행 제한**이다.
  남은 목적 판단은 새 dev 근거로 제한적으로 개선하고 기존 회귀 조건을 유지해야 한다.

프로젝트 API 사용은 랭킹 **32회**, 임베딩 **0회**, 재시도 **0회**, 실패 **0회**다.
전체 input 250,280 / output 65,785 tokens, cached input 0 tokens이며 32개 모두 사용량을 수신했다.
캐시 쓰기 등 API가 제공한 세부 항목은 `api-usage.jsonl`에 보관한다. 청구 금액은 조회하지 않았다.
실행 전 로컬 import 경로 오류 1회는 API 호출 전에 발생하여 위 호출 수에 포함되지 않는다.
요청 복원에 잠시 시작한 MySQL 컨테이너는 작업 후 중지했고 DB·Qdrant 데이터는 변경하지 않았다.

### 검증

- AI Service 전체 테스트 **188개**, 평가 도구 **59개**, 판정/공유 도구 **108개** 통과.
- 키 없는 dry-run과 고정 16개·최대 32회 가드, 요청 순서·전체 요청 해시, before/after 완전성,
  미판정 분리, 출력 덮어쓰기 차단, 비JSON API 오류와 종료 실패 기록을 검증했다.
- 실제 전후의 16개 전체 요청·정규화 모델 입력 해시가 모두 일치한다.
  실행 코드·프롬프트·요청·응답·사용량 해시와 공유 파일의 비밀정보 미포함 검사를 통과했다.
- `verify-shared-run.py --with-capture`가 기존 3단계 자료를 재검증했고,
  4단계 1차 `comparison.json`도 기존 도구로 다시 계산하여 바이트 단위로 동일함을 확인했다.
- Core API·Frontend·DB 스키마는 이번에 수정하지 않았다. 해당 전체 테스트를 새로 실행한 것으로 세지 않는다.
