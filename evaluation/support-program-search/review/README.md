# 실데이터 검색 관련성 판정: AI / 혼합 / 사람

기존 작업을 이어받는 개발자는 [현재 공유 자료 안내](../runs/support-program-catalog-20260906-v1/README.md)부터
확인한다. 고정 공고·질문·최초 1,605개 및 재검토 210개 AI 판정과 과거 모드 선택 결과가 Git 포함 대상이다.
실제 16개 검색 캡처 이후 새 249쌍의 원표 1,245개를 추가해 최종 합의 541건·미확정 29건이다.
[1차 AI-only 지표와 한계](../runs/support-program-catalog-20260906-v1/review-final-v1/report.md)를 보관하며,
`verify-shared-run.py --with-capture`로 처음부터 판정하지 않고 원표·최종 지표까지 재현한다.

## 검토 방식 선택

기본 모드는 `ai-only`다. 선택은 정답을 **어떻게 만드는지**에 대한 설정이며, 검색 서비스의 운영 모드나
AI 추천 점수를 바꾸지 않는다. 같은 자료와 원본 판정을 보관한 채 나중에 모드를 바꿀 수 있다.

| 모드 | 기준으로 사용하는 판정 | 사람의 필수 작업 |
| --- | --- | --- |
| `ai-only` | Luna 등 동일 모델의 독립 Codex 실행 5회, 모두 완료되고 4회 이상 같은 확정 판정일 때 채택 | 없음 |
| `hybrid` | AI 판정 + 실제 사람이 확인한 항목의 판정 | 불일치/정보 부족 항목 전부 + 질문별 합의 표본 10%(최소 1건) |
| `human` | 실제 사람이 입력한 판정만 사용 | 검토 풀 전체 |

AI만 사용하는 경우 기존 사람 판정 2건도 AI 라벨의 정답으로 주입하지 않는다. 사람 원본은 별도로 보존하고,
혼합/사람 모드에서 다시 사용할 수 있다. AI 합의는 정확도 확률이 아니며 5회 실행이 서로 다른 모델을 뜻하지 않는다.
판정 출처·개별 근거·입력과 정책 해시를 보관한다. 사람 판정 파일에 AI 판정을 미리 채워 사람 확인으로 표시하지 않는다.

5회 판정 중 누락이 있으면 `incomplete-ai`다. 3:2 분할 또는 정보 부족으로 확정하지 못한 항목은 `unclear`로 남긴다.
AI-only 최종 라벨에서는 이런 행만 부적합으로 간주하거나 삭제하지 않고 **해당 질문 전체를 제외**한다.
평가 가능한 질문이 모두 사라지면 완료 처리하지 않는다. 제외가 많으면 좋은 점수만 보고 성공이라고 해석하면 안 된다.
혼합 모드는 필수 사람 확인이 끝나기 전에는 `needs-human`이며 AI로 그 자리를 대신 채우지 않는다.
표본은 AI 원본 파일 해시와 질문/공고 ID로 고정하며 검색 성능에 따라 고르지 않는다.

### API 키 없이 Codex 하위 에이전트로 판정하기

`run-ai-review.py`는 외부 API를 호출하거나 `OPENAI_API_KEY`를 읽지 않는다. 표준 라이브러리만으로
입력을 준비하고 실제 Codex 하위 에이전트의 결과를 회수·검증한다. **스크립트 자체가 모델을 실행하지는 않는다.**
Codex 작업에서 사용자 지정 모델(이번 실행은 `gpt-5.6-luna`)의 독립 에이전트 5개에 각각 판정을 맡긴다.
프로젝트 API 키 과금은 없지만 Codex 작업 사용량은 소모된다. 판정별 API 토큰 사용량은 알 수 없으므로
`usage: null`로 기록한다. 실행의 `agentId`, 모델, 정책 및 근거를 남기며 API 응답 ID를 꾸며내지 않는다.

~~~bash
RUN=evaluation/support-program-search/runs/your-run-id
POOL="$RUN/review-v2"
AI="$POOL/codex-ai-v1"

python3 -B evaluation/support-program-search/review/run-ai-review.py prepare \
  --fixture "$RUN/fixture-unlabeled.json" --query-set "$RUN/query-set.json" \
  --review-pool "$POOL/review-pool.csv" --pool-manifest "$POOL/review-pool-manifest.json" \
  --model gpt-5.6-luna --output-dir "$AI"
~~~

생성된 `blind-input.jsonl`에는 질문·고정 공고만, `policy.json`에는 공통 판정 기준과 다섯 실행의
검토 순서가 들어간다. 에이전트에 다른 실행의 결과, 기존 사람 판정, 검색 순위, 예상 정답을 보여주지 않는다.
에이전트는 각 질문/공고를 직접 판단하며 단순 키워드 규칙으로 판정을 일괄 생성하지 않는다.
원문에 없는 근거 인용·중복 판정·다른 입력의 판정은 수집기가 거부한다.

`assignments.json`은 실제 생성한 Codex 작업 ID와 `judge-1`~`judge-5`를 매핑한다. 각 `judge-N.jsonl`의
첫 줄은 실행 헤더(`schemaVersion`, `judgeId`, `agentId`, `model`, `inputSha256`, `policySha256`),
나머지 줄은 `queryId`, `programId`, `decision`, `reason`, `evidence`를 가진 판정이다.
실제 생성하지 않은 작업 ID나 실행하지 않은 모델의 판정을 기록하지 않는다.

~~~bash
python3 -B evaluation/support-program-search/review/run-ai-review.py collect \
  --fixture "$RUN/fixture-unlabeled.json" --query-set "$RUN/query-set.json" \
  --review-pool "$POOL/review-pool.csv" --pool-manifest "$POOL/review-pool-manifest.json" \
  --model gpt-5.6-luna --prepared-dir "$AI" --assignments "$AI/assignments.json" \
  --judge-file "$AI/judge-1.jsonl" --judge-file "$AI/judge-2.jsonl" \
  --judge-file "$AI/judge-3.jsonl" --judge-file "$AI/judge-4.jsonl" \
  --judge-file "$AI/judge-5.jsonl" --output "$AI/ai-review.json"

python3 -B evaluation/support-program-search/review/select-review-mode.py \
  --fixture "$RUN/fixture-unlabeled.json" --query-set "$RUN/query-set.json" \
  --review-pool "$POOL/review-pool.csv" --pool-manifest "$POOL/review-pool-manifest.json" \
  --mode ai-only --ai-review "$AI/ai-review.json" \
  --conversation-judgments "$POOL/conversation-judgments.json" \
  --output-dir "$POOL/selected-ai-v1"
~~~

`--mode hybrid`로 바꾸면 혼합 모드, `--mode human`으로 바꾸고 `--ai-review`를 빼면 사람 모드다.
출력 디렉터리는 모드·판정 버전별로 새 경로를 사용한다. 대화 판정이 없으면 `--conversation-judgments`를 생략한다.

- `reviewed.csv`: 선택 모드의 판정 결과. 혼합/사람 검토가 남았다면 아직 미완료다.
- `selection.json`: 모드·원본 파일 해시·개별 출처·제외 질문·완료 여부.
- `review-progress.json`: **사람 입력만** 보존한 브라우저 호환 파일. AI 결과는 사람 입력으로 채워지지 않는다.
- `review.html`: 엑셀 없이 여는 사람 검토 화면. 혼합 모드는 ‘다음 필수 사람 검토’로 필요한 항목만 이동한다.

사람 확인 후 저장한 JSON을 `--human-review /path/saved-review.json`으로 넣고 같은 모드를 새 출력 경로에 다시 선택한다.
새 페이지는 기존 검토 화면과 저장 공간을 분리하며 기존 브라우저 입력을 덮어쓰지 않는다. 이어갈 때 저장한 JSON을 전달한다.

### 미확정 항목의 한 차례 추가 판정

이번 공유 실행은 `codex-ai-recheck-v1/review-plan.md`에 고정한 범위로만 추가 검토했다.
`recheck-ai-review.py`는 완료된 최초 AI 판정의 **미확정 전부**를 재검토 대상으로 검증한다.
질문·본문·기준일·정책은 그대로 두며, 원래 실행과 다른 다섯 작업 ID가 필요하다.
기존 279개 합의는 유지하고 대상 42개는 새 다섯 표로 교체한다. 10표 합산·선별·반복 합의 유도는 하지 않는다.
`roundLimit: 1`이며 추가 판정 파일을 다시 부모로 사용하는 것은 거부한다.

저장된 판정을 새 파일로 재수집하는 예시다. 모델/API를 호출하지 않는다.

~~~bash
RUN=evaluation/support-program-search/runs/support-program-catalog-20260906-v1
POOL="$RUN/review-v2"
RECHECK="$POOL/codex-ai-recheck-v1"

python3 -B evaluation/support-program-search/review/recheck-ai-review.py \
  --fixture "$RUN/fixture-unlabeled.json" --query-set "$RUN/query-set.json" \
  --review-pool "$POOL/review-pool.csv" --pool-manifest "$POOL/review-pool-manifest.json" \
  --base-ai-review "$POOL/codex-ai-v1/ai-review.json" \
  --prepared-dir "$RECHECK" --assignments "$RECHECK/assignments.json" \
  --judge-file "$RECHECK/judge-1.jsonl" --judge-file "$RECHECK/judge-2.jsonl" \
  --judge-file "$RECHECK/judge-3.jsonl" --judge-file "$RECHECK/judge-4.jsonl" \
  --judge-file "$RECHECK/judge-5.jsonl" --output "$POOL/local-recollected-recheck.json"
~~~

현재 결과를 선택하려면 기존 `select-review-mode.py`에
`--ai-recheck "$RECHECK/ai-recheck.json"`을 추가하고 **새 출력 디렉터리**를 쓴다.
AI-only·혼합 모드만 이 옵션을 받는다. 사람 모드에는 AI 입력을 전달하지 않는다.
선택 v2의 `aiRecheckSha256`과 대상 행의 `provenance.recheckSha256`에 출처가 남고,
`apply-labels.py`도 최종 평가 자료의 source hash로 전달한다. 기존 선택 v1도 계속 지원한다.
전체 오프라인 재현은 `verify-shared-run.py --run-dir "$RUN" --with-recheck`로 확인한다.
원인 감사는 독립 표결 완료 뒤 AI가 분석한 기록이며, 표결을 덮어쓰거나 사람 확인으로 취급하지 않는다.

### 최종 검색 평가와 재사용

실제 검색 캡처와 병합한 최종 풀에 대해 위 절차를 적용한 뒤, 아래 기존 `apply-labels.py` 명령에
`--selection /path/selected/selection.json`을 추가하고 `--review-pool`에는 같은 디렉터리의 `reviewed.csv`를 전달한다.
실제 캡처가 없는 사전 검토 풀은 판정을 끝내도 **실제 후보 Recall·최종 MRR 평가 완료가 아니다**.
실제 검색 캡처는 운영 AI Service/OpenAI 호출을 포함할 수 있으므로 이 오프라인 판정과 별도 실행이다.
이번 판정 방식을 핑계로 실제 검색 결과를 Codex가 만들어 캡처로 대체하지 않는다.

보고서의 `labelReference`에 AI-only/혼합/사람 출처, 실제 사람 확인 건수, 제외 질문, 풀 기반 평가의 한계를 표시한다.
AI-only 점수는 AI 합의 참조 기준과의 일치도이며 독립적인 사람 검증 정확도가 아니다.

공고 내용·질문·정책이 같은 **고정 평가 자료**는 판정을 다시 만들지 않고 반복 사용한다.
매일 평가할 필요는 없다. 검색 방식/추천 프롬프트/모델 변경, 제공처 추가, 오추천 버그 수정처럼
검색 품질에 영향을 주는 변경 때 기존 정답으로 전후를 비교한다. 질문/공고가 바뀌면 영향을 받는 판정은
다시 검토하며 기존 버전을 덮어쓰지 않는다. 최신 공고 전체의 정확성을 한 번의 소규모 평가로 보장하지 않는다.

### 실제 캡처로 풀이 늘어날 때 기존 AI 판정 이어받기

`transfer-ai-review.py`는 기존 321개 질문/공고 쌍과 최초 1,605표·재검토 210표를 보존하고,
실제 검색에서 새로 추가된 쌍만 판정하도록 준비한다. 현재 이전 경로는 **AI-only 전용**이다.
혼합/사람 모드는 앞의 `select-review-mode.py` 절차를 사용하며 이전 결과를 사람 확인으로 표시하지 않는다.

아래는 **전체 질문의 실제 capture가 성공하고 검증된 뒤** 실행하는 절차다. 중간에 실패한 호출이나
진단 파일을 완성된 capture로 사용하지 않는다. 이 도구의 구현·테스트 완료는 실제 검색 측정 완료가 아니다.
`CAPTURE`는 실제 완료 파일 경로로 바꾸고, 출력 디렉터리는 모두 새 경로를 사용한다.

```bash
RUN=evaluation/support-program-search/runs/support-program-catalog-20260906-v1
PREVIOUS="$RUN/review-v2"
CAPTURE="$RUN/capture.json"
FINAL="$RUN/review-final-v1"
ADDITIONAL="$FINAL/additional-ai-v1"
SELECTED="$FINAL/selected-ai-transfer-v1"

python3 -B evaluation/support-program-search/review/build-review-pool.py \
  --fixture "$RUN/fixture-unlabeled.json" --query-set "$RUN/query-set.json" \
  --config "$RUN/pool-config.json" --capture "$CAPTURE" \
  --review-pool "$FINAL/review-pool.csv" --provenance "$FINAL/review-pool-provenance.csv" \
  --pool-manifest "$FINAL/review-pool-manifest.json"

python3 -B evaluation/support-program-search/review/transfer-ai-review.py prepare \
  --fixture "$RUN/fixture-unlabeled.json" --query-set "$RUN/query-set.json" \
  --config "$RUN/pool-config.json" --capture "$CAPTURE" \
  --previous-pool "$PREVIOUS/review-pool.csv" --previous-manifest "$PREVIOUS/review-pool-manifest.json" \
  --review-pool "$FINAL/review-pool.csv" --pool-manifest "$FINAL/review-pool-manifest.json" \
  --ai-review "$PREVIOUS/codex-ai-v1/ai-review.json" \
  --ai-recheck "$PREVIOUS/codex-ai-recheck-v1/ai-recheck.json" --output-dir "$ADDITIONAL"
```

최종 풀은 빈 판정으로 생성한다. `--previous-review`로 AI CSV의 세 판정 열만 옮기면 원표 출처가
이어지지 않으므로 사용하지 않는다. `prepare`는 snapshot·질문·설정·공통 행의 불변 내용과 실제 후보
집합을 검증하고 `transfer-plan.json`에 원본 파일 hash와 추가 쌍을 고정한다.

- `additionalPairCount`가 **0**이면 새 모델 판정과 아래 `collect`를 생략한다. 이후 `select`에서도
  `--additional-ai-review` 줄을 뺀다.
- **1 이상**이면 `prepared/blind-input.jsonl`과 `prepared/policy.json`을 새 독립 에이전트 5개에 전달한다.
  기존 원표·재검토·사람 판정·검색 순위는 전달하지 않는다. 실제 작업 ID로 `assignments.json`과
  `judge-1.jsonl`~`judge-5.jsonl`을 `$ADDITIONAL`에 저장하고 아래처럼 회수한다.

```bash
python3 -B evaluation/support-program-search/review/run-ai-review.py collect \
  --fixture "$RUN/fixture-unlabeled.json" --query-set "$RUN/query-set.json" \
  --review-pool "$ADDITIONAL/review-pool.csv" --pool-manifest "$ADDITIONAL/review-pool-manifest.json" \
  --model gpt-5.6-luna --prepared-dir "$ADDITIONAL/prepared" --assignments "$ADDITIONAL/assignments.json" \
  --judge-file "$ADDITIONAL/judge-1.jsonl" --judge-file "$ADDITIONAL/judge-2.jsonl" \
  --judge-file "$ADDITIONAL/judge-3.jsonl" --judge-file "$ADDITIONAL/judge-4.jsonl" \
  --judge-file "$ADDITIONAL/judge-5.jsonl" --output "$ADDITIONAL/ai-review.json"

python3 -B evaluation/support-program-search/review/transfer-ai-review.py select \
  --fixture "$RUN/fixture-unlabeled.json" --query-set "$RUN/query-set.json" \
  --config "$RUN/pool-config.json" --capture "$CAPTURE" \
  --previous-pool "$PREVIOUS/review-pool.csv" --previous-manifest "$PREVIOUS/review-pool-manifest.json" \
  --review-pool "$FINAL/review-pool.csv" --pool-manifest "$FINAL/review-pool-manifest.json" \
  --ai-review "$PREVIOUS/codex-ai-v1/ai-review.json" \
  --ai-recheck "$PREVIOUS/codex-ai-recheck-v1/ai-recheck.json" \
  --additional-dir "$ADDITIONAL" \
  --additional-ai-review "$ADDITIONAL/ai-review.json" \
  --conversation-judgments "$PREVIOUS/conversation-judgments.json" --output-dir "$SELECTED"
```

추가 풀은 `captureIncluded: false`인 부분집합이므로 직접 최종 평가에 사용하지 않는다. `select`는
원본과 추가 판정을 각각 원래 풀의 validator로 확인하며, 기존 AI·재검토 작업 ID를 추가 판정에
재사용하면 거부한다. 기존 미확정 18건은 그대로 남고 새 미확정까지 합쳐 질문 전체의 제외 여부를
다시 계산한다. 추가 표가 미완료면 `incomplete-ai`이며 최종 라벨을 만들 수 없다.
대화 판정 2건은 사람 진행 파일에만 보존하고 AI-only 정답에는 넣지 않는다.

`selection.json`의 상태가 `ready`일 때 다음 명령으로 전체 최종 풀에 라벨을 적용한다. 아래 측정
절차에서는 `--fixture "$FINAL/fixture-labeled.json" --capture "$CAPTURE"`를 사용한다.
`ready`는 라벨 선택 상태이며 검색 품질 검증 결과가 아니다.

```bash
python3 -B evaluation/support-program-search/review/apply-labels.py \
  --fixture "$RUN/fixture-unlabeled.json" --query-set "$RUN/query-set.json" \
  --config "$RUN/pool-config.json" --capture "$CAPTURE" \
  --pool-manifest "$FINAL/review-pool-manifest.json" \
  --review-pool "$SELECTED/reviewed.csv" --selection "$SELECTED/selection.json" \
  --output "$FINAL/fixture-labeled.json"
```

이전 selection에는 각 원본 풀과 선택 기록이 남고, `aiReviewSha256`, `aiRecheckSha256`,
추가 판정이 있을 때의 `additionalAiReviewSha256`, `transferPlanSha256`는 최종 fixture의
`labelReview.sourceHashes`와 평가 보고서까지 전달된다. 원본·추가 판정·이전 계획을 함께 보관한다.
기존 identity/hash 검사를 완화하거나 원본 JSON의 pool hash·agent ID를 바꾸어 이전하지 않는다.

## 엑셀 없이 혼자 검토하기

로컬 검토 화면은 HTML 파일 하나로 실행한다. Chrome 등 브라우저로 열면 되고, 계정·엑셀·DB·API 서버는
필요 없다. 외부 서비스나 OpenAI로 요청을 보내지 않는다. 실제 공고가 포함되므로 임의로 공개 배포하지 않는다.

1. 질문과 공고의 제목·저장된 요약·대상·지역을 읽는다.
2. **추천 가능 / 추천 불가 / 판단 어려움** 중 하나를 선택하고 이유를 한 줄 적는다.
3. **다음 미완료 공고**로 이동한다. 한 번에 10건씩 해도 되며 자동 판정은 없다.
4. 중간에 멈추거나 검토를 끝낼 때 **결과 파일 저장**을 눌러 JSON 파일을 보관한다.
5. 같은 브라우저에서는 자동 저장한 내용으로 이어간다. 다른 브라우저나 기기에서는
   **저장한 결과 불러오기**로 JSON을 선택한다. 파일의 질문·공고 묶음이 다르면 불러오지 않는다.
6. 결과 JSON을 담당 개발자에게 전달한다. 직접 CSV나 엑셀로 변환할 필요는 없다.

자동 저장은 해당 브라우저·기기의 로컬 저장소에만 적용된다. 브라우저 데이터를 삭제하면 지워질 수 있다.
자동 저장 불가·여러 창의 동시 편집을 감지하면 경고하며 기존 내용을 조용히 덮어쓰지 않는다.
경고가 뜨면 창을 닫기 전 파일을 저장하고 한 창에서만 계속한다. 파일을 불러올 때 현재 내용의
교체 여부를 확인한다. 중간 입력도 보존하므로 이유가 없는 상태로도 백업할 수 있다.

질문·공고 내용·ID는 화면에서 편집하지 않는다. 판정과 이유만 수정한다.
이유가 없는 추천 가능·판단 어려움은 미완료로 표시한다. 판단 어려움은 입력이 완료되어도
최종 점수 계산 전에 다시 확인하거나 사유를 남겨 해당 질문 전체를 제외해야 한다.
1인 검토는 독립된 두 사람의 교차 검증이 아니며 보고서에도 단일 검토자라는 한계를 기록한다.

### 화면 생성과 결과 회수

아래는 개발자용 명령이다. 사용자는 생성된 화면을 열고 버튼으로 저장한 파일만 전달하면 된다.

~~~bash
RUN=evaluation/support-program-search/runs/your-run-id
POOL="$RUN/review-v2"

python3 -B evaluation/support-program-search/review/build-review-page.py \
  --fixture "$RUN/fixture-unlabeled.json" \
  --query-set "$RUN/query-set.json" \
  --review-pool "$POOL/review-pool.csv" \
  --pool-manifest "$POOL/review-pool-manifest.json" \
  --conversation-judgments "$POOL/conversation-judgments.json" \
  --output "$POOL/web/index.html"

python3 -B evaluation/support-program-search/review/extract-review-json.py \
  --review-pool "$POOL/review-pool.csv" \
  --pool-manifest "$POOL/review-pool-manifest.json" \
  --review-json /absolute/path/review-progress.json \
  --output "$POOL/reviewed-from-browser.csv"
~~~

대화 판정이 없으면 --conversation-judgments를 생략한다. 생성기는 공고 해시·질문 해시·불변 열·행 수를
검증하고 대화 판정의 원문 응답과 근거 범위를 보존한다. 대화 요약만 보고 내린 판정을 전체 본문 독립 검토로
표현하지 않는다. HTML 생성과 CSV 변환은 기존 출력 파일을 덮어쓰지 않는다.
화면 수정 시에는 새 출력 경로에 생성하고 기존 결과 JSON을 보존한다.

회수한 CSV는 아래 --previous-review 또는 apply-labels.py에 사용할 수 있다.
대화 출처는 기존 CSV 열에 없으므로 **JSON 원본도 함께 보관**한다.
미완료 CSV를 만들었다고 라벨이 확정되는 것은 아니다. 기존 최종 변환기가 모든 판정의 완료 여부를 검사한다.

브라우저 테스트는 별도 합성 데이터·임시 프로필로 실행한다. 실제 검토 상태에 테스트 판정을 넣지 않는다.

~~~bash
REVIEW_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.js \
REVIEW_BROWSER_EXECUTABLE=/absolute/path/to/installed/chrome \
node --test evaluation/support-program-search/review/test-review-page.mjs
~~~

## 기존 검토 파일 도구

아래 기존 도구는 공고 스냅샷에서 검토 후보를 만들고, 사람이 입력한 판정을 평가 fixture로 변환한다.
실제 검색 실행이나 OpenAI 호출은 하지 않는다. Python 도구는 표준 라이브러리만 사용한다.
XLSX 생성·읽기는 `@oai/artifact-tool`이 제공되는 별도 작업 런타임에서 실행한다.
실행 전에 `ARTIFACT_NODE`에 해당 Node 실행 파일, `ARTIFACT_NODE_MODULES`에 해당 node_modules의
절대 경로를 설정한다. `run-workbook-tool.sh`가 임시 경로에 연결하고 실행 후 연결만 정리한다.
서비스의 production 의존성에는 추가하지 않는다.

실행별 공고·질문·검토 파일은 `../runs/<runId>/`에 보관한다. 협업용 고정 자료는 명시적 허용 목록으로 Git에
포함하고, 새 실행·생성 화면·엑셀·임시 출력은 기본적으로 제외한다. 재사용 스크립트와 테스트는 이 디렉터리에 둔다.
최종 점수는 전체 공고를 전수 판정한 정확도가 아니라 **선택한 판정 출처에 따른 다중 검색 후보 풀 관련성 평가**다.

## 검토자가 할 일

1. `검토표` 시트에서 A열 `query_id`로 담당 질문을 필터링한다.
2. C열 질문과 G~M열 공고 내용을 비교한다. 제목만 보고 판정하지 않는다.
3. 노란 D열 `decision`, E열 `reason`, F열 `reviewer`만 입력한다.
4. 자기 이름을 붙인 새 XLSX로 저장하고 담당 개발자에게 전달한다. 직접 CSV나 JSON으로 바꾸지 않는다.

판정은 다음 세 값만 사용한다.

| decision | 의미 | 이유 예시 |
| --- | --- | --- |
| relevant | 질문의 지원 목적·방식에 맞고, 명시된 지역·대상과 충돌하지 않음 | 서초구 소상공인 대상 AI 콘텐츠 제작을 지원함 |
| irrelevant | 질문의 중요한 조건과 명확히 다름 | 울산 소재만 지원하므로 서울 사업자는 맞지 않음 |
| unclear | 질문의 핵심 요구를 제공된 내용만으로 확인할 수 없음 | 마케팅 지원만 명시되어 온라인 광고비 포함 여부 불명 |

`relevant`와 `unclear`는 이유가 필수다. `irrelevant`도 짧게 이유를 적는 것을 권장한다.
모든 판정에 검토자 이름을 적는다. 빈칸은 미검토이며 부적합 판정으로 취급하지 않는다.
질문에 없는 매출액·직원 수·보험가입 여부를 추정하지 않는다. 검색 관련성이 맞아도 추가 신청자격은
“매출 조건 별도 확인 필요”처럼 이유에 기록할 수 있다. 최종 신청 가능 여부를 보증하는 평가는 아니다.
질문의 “과/그리고”는 모두, “또는/이나”는 하나 이상을 충족해야 한다.
범주에 단순히 “마케팅”이라고 적혀 있다고 온라인 광고비 지원까지 있다고 추측하지 않는다.

날짜는 실행 스냅샷의 `referenceDate`를 사용한다. 오늘 날짜를 보고 공고를 새로 제외하지 않는다.
긴 셀은 수식 입력줄을 펼쳐 전체 내용을 읽는다. 질문·공고 텍스트·ID·행은 수정하거나 삭제하지 않는다.
검색 순위와 후보 출처는 라벨 확정 전 열지 않는다. 대표 후보와 예상 무결과는 **정답이 아니다**.

사전 검토용 XLSX에서도 판정을 시작할 수 있다. 이후 실제 검색 후보를 합칠 때 이전 판정은 그대로
이어받고 추가된 빈 행만 검토한다. 실제 capture가 없으면 최종 fixture 변환과 점수 계산은 할 수 없다.

## 개발자 실행 순서

저장 경로는 예시다. `RUN`과 `POOL`을 실제 실행 디렉터리로 바꾼다.
모든 출력은 새 경로여야 한다. 기존 파일을 발견하면 실패하며 덮어쓰기 옵션은 없다.

```bash
RUN=evaluation/support-program-search/runs/your-run-id
POOL="$RUN/review-v1"

python3 evaluation/support-program-search/review/build-review-pool.py \
  --fixture "$RUN/fixture-unlabeled.json" \
  --query-set "$RUN/query-set.json" \
  --config "$RUN/pool-config.json" \
  --review-pool "$POOL/review-pool.csv" \
  --provenance "$POOL/review-pool-provenance.csv" \
  --pool-manifest "$POOL/review-pool-manifest.json"

sh evaluation/support-program-search/review/run-workbook-tool.sh build-review-workbook.mjs "$POOL" draft
```

풀은 실제 후보 20개(캡처가 있을 때), 키워드 10개, 보조 검색 최대 20개, 사전 대표 후보를 합친다.
상한은 질문마다 `50 + 대표 후보 수`이며 중복을 제거한다. 사전 대표 후보는 누락 방지용일 뿐이다.
풀 밖에 관련 공고가 남을 수 있으므로 보고서에 이 한계를 반드시 적는다.

검토받은 XLSX를 CSV로 추출한다. 여러 사람이 파일을 나눠 작성한 경우 담당 질문만 가져와 병합하되,
같은 질문/공고에 서로 다른 판정이 있으면 자동으로 하나를 선택하지 말고 합의한다.

```bash
sh evaluation/support-program-search/review/run-workbook-tool.sh extract-review-csv.mjs \
  "$POOL/reviewed-by-team.xlsx" "$POOL/reviewed-by-team.csv"
```

실제 캡처는 별도 실행 절차와 외부 전송·비용 승인을 거친다. 확보한 뒤 새 풀 디렉터리에 생성하며
위 생성 명령에 `--capture "$RUN/capture.json"`,
`--previous-review "$POOL/reviewed-by-team.csv"`를 추가한다.
XLSX 생성은 새 풀 디렉터리를 대상으로 `final "$RUN/capture.json"` 모드를 사용한다.
질문·스냅샷·pool 설정을 유지해야 같은 행의 판정을 이어받을 수 있다.
기존 판정이 있는 행이 사라지거나 내용이 달라지면 조용히 버리지 않고 오류를 반환한다.

## 합의와 제외

검토자는 적합·판단 불가 판정, 적합이 하나도 없는 질문의 전체 행, 부적합 표본을 다시 확인한다.
한 명이라면 시간을 두고 같은 기준으로 재검토하며 독립된 교차 검증으로 표현하지 않는다.
다른 검토자가 실제로 참여하는 경우에만 두 번째 검토자의 확인으로 기록한다.
전수 검토하지 않는 대신 동의어·유사 목적 검색으로 누락 가능성도 확인한다.
정답이 없다고 예상한 질문도 실제 판정에 따라 정답이 생길 수 있다.

끝내 핵심 조건을 확인할 수 없는 질문만 이유를 남겨 제외한다. 성능이 낮다는 이유로 제외하지 않는다.
제외 질문은 `relevantIds: null`, 검토 결과 정답이 없는 질문은 `[]`다. 둘은 다른 의미다.
한 행만 조용히 무시하면 정답 분모가 변하므로 제외는 질문 전체에 적용한다.
질문을 고치고 싶다면 새 질문 버전으로 별도 캡처·평가한다.

```bash
python3 evaluation/support-program-search/review/apply-labels.py \
  --fixture "$RUN/fixture-unlabeled.json" \
  --query-set "$RUN/query-set.json" \
  --config "$RUN/pool-config.json" \
  --capture "$RUN/capture.json" \
  --pool-manifest "$RUN/review-final/review-pool-manifest.json" \
  --review-pool "$RUN/review-final/reviewed-by-team.csv" \
  --output "$RUN/fixture-labeled.json"
```

제외가 필요할 때만 위 명령에 `--exclude-query "Q13=온라인 마케팅 비용 지원 여부를 확인할 수 없음"`처럼
추가한다. 이 예시는 실제 Q13을 제외하라는 지시가 아니다.
예상 정답과 다른 판정은 경고와 감사 기록으로 남기고 사람 판정을 그대로 사용한다.
캡처 해시, 질문 해시, 공고 해시, 행 추가·삭제, 불변 열 변경은 계속 검증한다.

## 측정

```bash
python3 evaluation/support-program-search/evaluate.py \
  --fixture "$RUN/fixture-labeled.json" --capture "$RUN/capture.json" --split dev
python3 evaluation/support-program-search/evaluate.py \
  --fixture "$RUN/fixture-labeled.json" --capture "$RUN/capture.json" --split heldout
```

후보 Recall@20, 최종 Recall@5·MRR@5, 최종 무결과 오탐률을 나누어 기록한다.
제외 사유·포함 질문 수·양성/무결과 분모를 함께 보고한다. 양성 또는 무결과 질문이 없다면 해당 지표는
측정 불가이며 0점이나 성공으로 해석하지 않는다. 무결과 질문을 4개로 미리 고정해 계산하지 않는다.
`dev`는 개선용, `heldout`은 평가용이다. heldout을 보고 반복 조정하면 별도 검증 자료가 필요하다.

## 오프라인 테스트

```bash
python3 -B -m unittest discover -s evaluation/support-program-search -p 'test_*.py'
python3 -B -m unittest discover -s evaluation/support-program-search/review -p 'test_*.py'
"$ARTIFACT_NODE" --test evaluation/support-program-search/review/test-workbook-tools.mjs
```

도구 테스트의 합성 판정은 실제 검토 라벨이나 실제 검색 점수를 대신하지 않는다.
XLSX 테스트는 위 런타임 환경변수 두 개가 없으면 skip된다. 실행 여부를 확인한 뒤 검증 결과에 기록한다.
