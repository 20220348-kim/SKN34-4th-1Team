# 함께 이어받는 검색 평가 자료

이 디렉터리는 Git으로 공유하는 고정 평가 자료다. 같은 저장소를 받은 개발자는 이전 작업자의 PC·브라우저·
Codex 대화에 접속하지 않고도 원본 판정과 현재 진행 상태를 확인할 수 있다. **API 키, Excel, DB는 자료 검증에
필요하지 않다.** 저장된 판정을 검증·재사용하는 작업이며 AI를 다시 호출하는 명령이 아니다.

## 현재 상태와 다음 담당자의 작업

아래 표는 보존한 **3단계 기준선**이다. 이후 개선은
[4단계 1차 후보 검색 비교](stage4-v1/README.md)와 [4단계 2차 고정 후보 랭킹 비교](stage4-v2/README.md)에
별도로 기록했다. 2차는 dev의 알려진 무관 추천 6→4건, 관련 추천 15→16건이며
heldout 오추천과 지연시간 한계도 남긴다. 3단계 정답·원표를 새 결과로 덮어쓰지 않는다.
이후 요청량·동시 실행 제한과 최종 Compose 통합 검증까지 완료했다.
[4단계 완료 범위와 남은 제약](../../../../docs/support-program-request-limits.md#4단계-최종-통합-검증-2026-09-06)을 참고한다.
이 문서의 3단계 원표와 각 실험 당시 보고서는 이후 결과로 덮어쓰지 않는다.

| 항목 | 현재 상태 |
| --- | --- |
| 고정 기준일 / 공고 | 2026-09-06 / 접수 중 공고 1,422건 |
| 질문 / 최종 검토 풀 | 16개 / 질문·공고 조합 570건(기존 321 + 신규 249) |
| AI 원표 | 최초 1,605개 + 과거 재검토 210개 + 신규 1,245개 완료 |
| 합의 / 미확정 | 최종 541건 / 29건 |
| 기본 방식 | AI-only. 기존 사람 판정 2건은 별도 보존 |
| 평가 가능 질문 | 6/16개. 관련 공고 있음 Q02·Q14 / 풀에서 관련 공고 없음 Q09·Q10·Q15·Q16 |
| 실제 검색 캡처 | 16/16 성공, actual-capture-v3에 보관 |
| 실제 Recall·MRR | 양성 질문 2개 기준 후보 Recall@20 0.50 / 최종 MRR@5 0.50 |

현재 선택은 `review-final-v1/selected-ai-transfer-v1/`이다. AI 총점·자격 점수·후보 ID 중복 오류를 해결한 뒤
고정 질문 16개의 실제 검색을 완료했다. 기존 321쌍의 판정을 재사용하고 새 249쌍만 새로운 Luna 작업 5개가
같은 정책으로 독립 판정했다. 기존 미확정 18개를 다시 판정하지 않았으며 신규 미확정 11개를 더해 29개로 남겼다.
새 후보에서 미확정 항목이 생긴 Q01·Q06도 질문 전체가 제외되어 사전 풀의 평가 가능 8개가 최종 6개로 줄었다.
원본 판정을 삭제하거나 평가에 실패한 질문을 빈 결과로 바꾼 것이 아니다.

**3단계의 AI-only 1차 측정은 완료했지만 전체 검색 품질 합격은 아니다.** 10개 질문을 제외했고 양성 질문이 2개뿐이다.
[최종 보고서와 다음 개선 순서](review-final-v1/report.md), [성공한 실제 실행](actual-capture-v3/README.md)를 먼저 읽는다.
실패 이력 [v1](actual-capture-v1/README.md)·[v2](actual-capture-v2/README.md)와 사전 작업의
[추가 검토 보고서](review-v2/codex-ai-recheck-v1/recheck-report.md),
[최초 보고서](review-v2/codex-ai-v1/labeling-report.md), [과거 실행 기록](run-manifest.md)은 보존한다.

## 1. 저장소를 받은 뒤 검증

아래 명령은 **저장소 루트에서 Python 3.11 이상**으로 실행한다. 별도 Python 패키지를 설치하지 않는다.

```bash
python3 -B evaluation/support-program-search/review/verify-shared-run.py \
  --run-dir evaluation/support-program-search/runs/support-program-catalog-20260906-v1 --with-capture
```

고정 공고·질문·풀을 검증하고, 다섯 원본 판정을 임시 디렉터리에 다시 수집한 결과와 공유된 `ai-review.json`을
비교한다. 재검토 210개·신규 1,245개 판정도 재수집한다. 기존 모드 결과뿐 아니라 최종 풀·판정 이전·선택·평가 라벨·
전체/dev/heldout 지표까지 다시 계산해 공유된 JSON·CSV와 비교한다. 원본 파일을 덮어쓰지 않는다.
`--with-recheck`는 과거 사전 풀 재검토까지만, 옵션을 빼면 최초 버전만 검증한다.
검증 성공은 **자료와 계산의 재현성**을 뜻하며 AI 판정의 정확성이나 실제 검색 성능을 보증하지 않는다.
출력의 `human`·`hybrid: needs-human`은 선택하지 않은 과거 검토 방식의 상태다. 이번 AI-only 평가가
사람 확인을 기다린다는 뜻이 아니며, 최신 결과는 `capture`와 `actualSearchEvaluated: true`에서 확인한다.

전체 오프라인 테스트도 실행할 수 있다. CI는 같은 검증을 실행하며 외부 모델을 호출하지 않는다.

```bash
python3 -B -m unittest discover -s evaluation/support-program-search -p 'test_*.py'
python3 -B -m unittest discover -s evaluation/support-program-search/review -p 'test_*.py'
```

## 2. 엑셀 없이 자료 확인하기

3단계 기준선은 [마크다운 보고서](review-final-v1/report.md), 최신 개선은
[4단계 2차 보고서](stage4-v2/README.md)를 바로 읽으면 된다. Excel은 필요하지 않다.
공유 원본은 JSON·CSV이며 HTML은 필요할 때 생성한다. 아래 명령은 **과거 사전 풀**의 모드 비교 화면을 재생성하며
AI를 다시 실행하지 않는다. 실제 캡처가 반영된 최신 평가 라벨과는 구분한다.

```bash
RUN=evaluation/support-program-search/runs/support-program-catalog-20260906-v1
POOL="$RUN/review-v2"

python3 -B evaluation/support-program-search/review/select-review-mode.py \
  --fixture "$RUN/fixture-unlabeled.json" --query-set "$RUN/query-set.json" \
  --review-pool "$POOL/review-pool.csv" --pool-manifest "$POOL/review-pool-manifest.json" \
  --mode ai-only --ai-review "$POOL/codex-ai-v1/ai-review.json" \
  --ai-recheck "$POOL/codex-ai-recheck-v1/ai-recheck.json" \
  --conversation-judgments "$POOL/conversation-judgments.json" \
  --output-dir "$POOL/local-ai-only"
```

생성된 `review-v2/local-ai-only/review.html`을 브라우저로 연다. 출력 디렉터리가 이미 있으면 새 이름을 쓴다.
혼합 모드는 `--mode hybrid`와 새 출력 경로를 사용한다. 사람 모드는 `--mode human`으로 바꾸고
`--ai-review`와 `--ai-recheck`를 모두 생략한다. 기존 공유된 `selected-*-v1`은 비교 기준이므로 덮어쓰지 않는다.

화면의 입력란은 **사람 입력 전용**이다. AI 판정이 완료돼 있어도 사람 입력이 빈칸인 것은 정상이다.
최신 AI-only 결과는 `review-final-v1/selected-ai-transfer-v1/selection.json`·`reviewed.csv`와 최종 보고서에서 확인한다.

## 3. 여러 사람이 작업할 때

1. Git 이슈에서 담당 질문 ID와 작업 종류를 정하고 각자 브랜치에서 작업한다. 기존 판정 1,605건을 다시 만들지 않는다.
2. `fixture-unlabeled.json`, 질문, 원본 판정과 정책은 고정한다. 새 판정·기준 변경은 새 버전 디렉터리에 남기고
   변경 사유와 원본 참조를 기록한다. 점수를 높이려고 미확정을 부적합 처리하거나 합의 기준을 낮추지 않는다.
3. 사람 검토를 선택한 경우 화면의 **결과 파일 저장**으로 JSON을 내보낸다. 브라우저 자동 저장은 해당 PC에만
   남으며 Git과 동기화되지 않는다. 다른 기기에서는 **저장한 결과 불러오기**로 이어받는다.
4. 공유할 새 JSON은 기존 파일을 덮어쓰지 않고 담당자·버전을 구분한 경로에 저장한다. `runs/.gitignore`의
   허용 목록에 해당 파일만 추가하고, 민감정보와 출처를 확인한 뒤 코드와 함께 커밋·푸시/PR한다.
5. 같은 질문·공고의 판단이 충돌하면 Git의 마지막 수정 내용을 자동 정답으로 삼지 않는다. 담당자가 근거를
   확인해 새 버전으로 정리한다. AI가 만든 판정을 사람이 검토한 것처럼 표시하지 않는다.

현재 사람 검토는 필수가 아니다. 최종 AI-only 풀의 미확정 29건은 보존한다. **과거 321행 사전 풀**의 혼합 모드는
미확정 18건과 합의 표본 38건, 총 56건의 사람 확인이 필요했던 상태를 유지하며 사람 모드도 319건 대기로 보존한다.
이 과거 대기 건수를 새 570행 풀의 혼합/사람 모드 완료 수치로 사용하지 않는다.
`assignments.json`의 agentId는 과거 실행의 출처 기록이지 다른 PC에서 재접속해야 하는 계정이나 실행 요구사항이 아니다.

## 공유 파일과 제외 파일

- 포함: 전체 고정 공고·질문·풀 설정, 현재 321행 풀과 출처, 사람 판정 원본 2건, AI 입력·정책·실행 배정,
  다섯 판정 원본·수집 결과, 세 모드의 JSON·CSV, 추가 검토 210건·원인 감사·새 선택 결과, 보고서·실행 기록.
- 추가 포함: 실제 검색 실패 기록, 관측된 토큰 사용량, 실패 모델 출력 2개와 오프라인 재현 절차.
  이 진단 출력은 정답 라벨이나 성공한 검색 결과가 아니다.
- 최신 추가 포함: 중복 ID 실패 기록·출력, 성공한 실제 16개 캡처·실행 설정/해시·사용량, 최종 570행 풀,
  신규 249쌍의 5개 원표·배정·입력·정책, 판정 이전/선택 결과, 라벨과 세 지표 보고서.
- 거부된 judge-1 초안은 감사 기록용으로만 포함한다. 검증기는 명시한 최종 `judge-1.jsonl`~`judge-5.jsonl`만
  수집한다. 거부된 초안으로 판정을 대체하지 않는다.
- 제외: 중간 체크포인트, 이전 323행 풀, 실행 폴더에 복사했던 도구, 생성 HTML·XLSX·PNG, OS 파일, 임시 출력.
  원본과 재사용 도구로 생성할 수 있으며 현재 판정의 이어받기에 필요하지 않다. 로컬 파일을 삭제한 것은 아니다.
- 비밀정보·환경설정은 포함하지 않는다. 새 실행은 기본적으로 제외하고 필요한 자료만 검토 후 허용한다.

공고 요약·공식 URL·공개 문의처가 포함된 고정 평가 자료다. 원문 출처를 유지한다. 이 자료를 별도 공개 데이터셋으로
재배포하거나 저장소의 공개 범위를 확대할 때는 제공처 이용 조건과 개인정보 포함 여부를 별도로 확인한다.
파일 해시의 재현성을 위해 JSON·JSONL·CSV는 `.gitattributes`로 자동 줄바꿈 변환을 막는다. 자동 포맷도 적용하지 않는다.

## 실제 검색 재실행은 별도

이 스냅샷을 Git으로 공유했다고 MySQL과 Qdrant가 자동으로 같은 상태가 되지는 않는다. 실제 검색 캡처는
동일 기준일·카탈로그 내용 해시가 맞는 DB·색인과 실행 설정을 따로 준비해야 한다. 현재 DB 내용이 달라졌다면
다른 스냅샷의 결과를 여기에 합치지 않는다. 기존 스냅샷 복원 없이 최신 DB 결과로 점수를 만들 수 없다.

실제 캡처는 운영 AI Service를 통해 OpenAI를 호출할 수 있으므로 비용·실행 범위를 확인한 뒤 별도로 실행한다.
저장된 Luna 판정으로 검색 결과를 대신 만들지 않는다. [실제 검색 캡처 절차](../../README.md#실제-검색-흐름-캡처)를 따른다.
