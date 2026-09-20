# 한국어 표현 확장 — 16개 공고·48개 질문

## 검색 전에 고정한 계획

기존 16개 질문·AI-only 라벨·첫 ES 보고서는 변경하지 않는다.
이 실험은 **실제 공고를 보고 AI가 작성한 목표 공고 찾기(known-item) 개발 진단**이다.
사람 검증 정답이나 전체 관련 공고 평가가 아니다. 기존 미확정 10개 질문을 확정 처리하지 않는다.

- 입력: 기존 `support-program-catalog-20260906-v1/review-final-v1/fixture-labeled.json` 전체 공고 1,422건.
- 목표: 지역·목적이 다른 실제 공고 16개. 상담·기술·수출·금융·고용·홍보를 포함해 내용을 읽고
  AI가 목적 표집했다. 무작위·블라인드 표집이 아니며 기존 질문과 주제가 겹친다.
- [questions.json](questions.json)에 목표 복합 ID·본문 해시·근거 구절과 질문을 실행 전에 고정했다.
  제목이나 지원 내용을 검색하는 질문이며 질문자의 실제 신청 자격을 확정하려는 요청은 아니다.
- 공고별 `keyword`(키워드형), `sentence`(조사·어미 포함 문장형), `spacing`(붙여쓰기/띄어쓰기 변형)
  3개씩 총 **48문장**. 같은 공고의 3문장을 독립적인 3개 업무 사례로 세지 않는다.
- 비교: 기존 키워드 / standard BM25 / Nori BM25. 기존 ES 설정·전체 카탈로그·K=20 그대로.
- 지표를 사전에 Hit@1·Hit@5·Hit@20, 목표 공고의 MRR@20, 세 표현 모두 성공한 공고 수로 정했다.
  모든 관련 공고를 라벨링하지 않았으므로 **Recall·Precision이라고 부르지 않는다.**
- 유료 모델·임베딩·Qdrant 호출 없이 로컬 ES만 실행한다. 운영 검색이나 사전은 바꾸지 않는다.
- 결과 확인 후 질문·목표·분석기 설정을 유리하게 수정하지 않는다. 실패·퇴보 사례도 그대로 남긴다.

목표 ID는 결과 평가에만 사용한다. ES에는 모든 공고를 색인하며, 실제 검색 요청에는 질문 문장만 보내고
목표 ID·근거·라벨은 보내지 않는다. 다른 적절한 공고를 찾아도 목표가 없으면 실패로 세는 한계가 있다.

## 결과 — 2026-09-12

**이번 표현 변형 진단에서는 Nori + BM25가 목표 공고를 더 안정적으로 찾았다.**
기존 16개 질문의 pooled Recall 비교와 다른 과제이며, 전체 사용자 검색 품질 100%를 입증하지는 않는다.
실행한 입력·목표·질문은 처음 고정한 그대로이며 검색 결과를 보고 재작성하지 않았다.

| 방식 | 목표 공고 1위 | 목표 공고 상위 5개 | 목표 공고 상위 20개 | 목표 MRR@20 | 세 표현 모두 성공한 공고 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 기존 키워드 | 25/48 (52.08%) | 35/48 (72.92%) | 39/48 (81.25%) | 0.6120 | 8/16 |
| standard BM25 | 32/48 (66.67%) | 40/48 (83.33%) | 44/48 (91.67%) | 0.7511 | 12/16 |
| Nori BM25 | 46/48 (95.83%) | 48/48 (100%) | 48/48 (100%) | 0.9792 | 16/16 |

‘상위 5개’도 **점수화 전 키워드 후보의 앞 5개**다. LLM 최종 추천 5개를 평가한 것이 아니다.
전체 관련 공고 중 얼마나 찾았는지 계산한 Recall이 아니라, 미리 지정한 한 공고를 찾았는지 계산한 Hit다.

### 표현 유형별 상위 20개 내 발견

| 표현 유형 | 질문 수 | 기존 키워드 | standard BM25 | Nori BM25 |
| --- | ---: | ---: | ---: | ---: |
| 키워드 나열 | 16 | 16/16 | 16/16 | 16/16 |
| 조사·어미가 있는 문장 | 16 | 8/16 | 13/16 | 16/16 |
| 붙여쓰기/띄어쓰기 변형 | 16 | 15/16 | 15/16 | 16/16 |

키워드형에서는 세 방식 모두 목표 공고를 찾았다. **같은 의도를 문장으로 표현하면 기존 exact-token 방식은
8개를 놓쳤지만 Nori는 모두 찾았다.** 현재 서비스가 자연어 입력을 받는다는 점에서 유용한 개선 신호다.
다만 문장에 공통으로 붙인 `공고를 찾아줘` 같은 표현의 영향과 작성 문체 편향도 포함된다.

### 대표 성공·퇴보 사례

| 질문 | 기존 키워드 순위 | standard BM25 순위 | Nori 순위 |
| --- | ---: | ---: | ---: |
| 부천의 제조 중소기업에 유해물질의 시험분석 수수료를 지원하는 공고를 찾아줘 | 20위 밖 | 8 | 1 |
| 전남의 수출 중소기업에게 통역과 번역비를 지원하는 공고를 찾아줘 | 20위 밖 | 20위 밖 | 1 |
| 부산 사상구에서 소상공인에게 대출의 보증료를 지원하는 공고를 찾아줘 | 20위 밖 | 20위 밖 | 1 |
| 강원 협동 조합 홍보 마케팅 지원 | 1 | 20위 밖 | 1 |
| 소상공인 자영업자 고용보험료 지원 | 4 | 1 | 2 |

Nori가 모든 질문에서 1위는 아니다. K09의 키워드형과 띄어쓰기형은 standard BM25의 1위에서
Nori 2위로 내려갔다. 이런 퇴보도 제거하지 않고 [전체 보고서](report.json)에 보존했다.
20위 밖은 해당 목표가 검색되지 않았다는 뜻이지, 그 질문에 대한 모든 결과가 무관하다는 뜻은 아니다.

## 한계와 다음 판단

- 질문·목표는 **AI 단독 작성**, 사람 검토 0건이다. 본문 인용 32개와 해시는 코드로 대조했지만
  문장 의미 보존·목표 적합성을 독립적으로 검증한 것은 아니다.
- 총 48문장은 **16개 목표 공고 × 3개 관련된 변형**이다. 48개 독립 사용자 요구로 계산하거나
  통계적 유의성·신뢰구간을 주장하지 않는다. 목적 표집과 원문 어휘 중복으로 결과가 낙관적일 수 있다.
- 제목·지원 내용으로 특정 공고를 찾는 진단이다. 신청자의 복합 자격, 부정 조건, 없는 지원 요청,
  모든 관련 공고의 누락과 오추천은 이번 지표에 포함하지 않는다.
- 기존 미확정 10개 질문·AI 합의 정답은 변경하지 않았다. 기존 0.75 Recall이 새 1.00 Recall로
  개선됐다고 비교하면 안 된다. 같은 조건의 이번 **Hit@20 39/48 → 48/48**만 비교한다.
- Qdrant 의미 검색·RRF·OpenAI 랭킹·운영 경로는 사용하지 않았다. 운영 검색에 이미 의미 검색이
  보완하는 부분이 있으므로 여기서 얻은 차이가 그대로 사용자 추천 개선 폭이 되는 것은 아니다.
- 다음은 이 질문을 고정한 채 동일한 Qdrant 후보와 각각 결합한 RRF 비교다. 임베딩 API가 필요하면
  별도 승인·호출 예산을 정한다. 이 결과만으로 운영 MySQL 공개 세대·ES 동기화 설계를 생략하지 않는다.

## 재현 — 저장소 루트

Python 3.11 이상, 실제 재검색에는 앞서 만든 로컬 Elasticsearch가 필요하다.
새 production 의존성이나 서비스는 추가하지 않았다. 공고 원본을 복사하지 않고 Git에 이미 있는 스냅샷을 읽는다.

```bash
# 이미 저장된 결과·질문·근거·지표 재검사: Docker와 API 키가 필요 없다.
python3 -B evaluation/support-program-search/compare_korean_queries.py \
  --fixture evaluation/support-program-search/runs/support-program-catalog-20260906-v1/review-final-v1/fixture-labeled.json \
  --questions evaluation/support-program-search/runs/elasticsearch-korean-queries-20260912-v1/questions.json \
  --verify-report evaluation/support-program-search/runs/elasticsearch-korean-queries-20260912-v1/report.json

# 실제 ES 재검색. 유료 API나 프로젝트 .env를 사용하지 않는다.
docker compose --env-file /dev/null -f evaluation/support-program-search/elasticsearch/compose.yaml up --build -d --wait --wait-timeout 180
LOCAL_ES_INTEGRATION_URL=http://127.0.0.1:19200 python3 -B -m unittest discover \
  -s evaluation/support-program-search -p 'test_compare_*.py'
python3 -B evaluation/support-program-search/compare_korean_queries.py \
  --fixture evaluation/support-program-search/runs/support-program-catalog-20260906-v1/review-final-v1/fixture-labeled.json \
  --questions evaluation/support-program-search/runs/elasticsearch-korean-queries-20260912-v1/questions.json \
  --output /tmp/govbiz-korean-queries-new.json
docker compose --env-file /dev/null -f evaluation/support-program-search/elasticsearch/compose.yaml down
```

출력 파일은 새 경로여야 한다. 기존 파일은 덮어쓰지 않고, 실패 시 `status: failed`로 남긴다.
오프라인 재검사는 질문·스냅샷·설정의 일치와 지표 계산을 확인할 뿐, 캡처의 진위나 정답 정확도를 인증하지 않는다.
`sourceSha256`에 실행 코드, 기존 비교 도구, ES 설정의 해시도 보존한다.

질문·근거·보고서·이 문서는 `runs/.gitignore` 허용 목록에 포함했다. 이후 개발자는 Excel이나
이전 작업자의 브라우저 없이 이어받을 수 있다. 실행이 끝나면 전용 컨테이너·tmpfs 복사 색인만 제거하며
Git의 원본·질문·보고서는 남아 재색인할 수 있다.

## 최종 검증

- 후보 평가 도구 전체: 131건 실행, 129건 통과, opt-in ES 통합 2건은 기본 실행에서 건너뛰었다.
- ES를 켠 비교 관련 테스트: **36/36 통과**. 위 통합 2건도 실행해 건너뛰기 없이 검증했다.
- 검토 도구 전체: **108/108 통과**.
- 기존 공유 판정·캡처 검증과 기존/신규 ES 보고서의 오프라인 지표 재계산: 통과.
- 48개 질문·16개 목표 ID·32개 원문 구절, 실행 코드 SHA-256 대조: 통과.
- Compose 기동·실제 색인·96회 ES 검색(48질문 × 2분석기), YAML 구문·문서 링크·`git diff --check`: 통과.
- OpenAI·임베딩·Qdrant 호출 0회. 실제 질의의 결과를 기대값으로 대체하지 않았다.
- Core·AI·Frontend production 코드와 메인 Compose는 변경하지 않아 앱 전체 테스트는 재실행하지 않았다.
  원격 GitHub Actions는 실행하지 않았고 전용 workflow와 같은 명령을 로컬에서 검증했다.
- 완료 후 실험 컨테이너·전용 네트워크·tmpfs 복사 색인만 제거했다. 보고서·질문·스냅샷은 보존했고
  기존 개발 컨테이너 6개는 계속 실행 중이었다.
