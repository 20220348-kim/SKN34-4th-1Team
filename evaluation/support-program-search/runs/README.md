# 실데이터 검색 평가 산출물 보관

한 번의 실데이터 평가를 `runs/<runId>/` 하나에 보관합니다. **협업에 필요한 고정 자료는 Git으로 공유**하고,
새 실행·임시 파일은 기본적으로 제외합니다. `.gitignore`의 명시적 허용 목록으로 공유 범위를 관리합니다.
실제 공고 텍스트·문의처·판정 기록을 포함하므로 새 파일의 비밀정보·개인정보·공유 범위를 확인한 뒤 추가합니다.

실제 카탈로그 공유 자료는 [support-program-catalog-20260906-v1](support-program-catalog-20260906-v1/README.md)입니다.
공고 1,422건, 질문 16개, 기존 AI 원표 1,815개와 실제 검색에서 추가된 249쌍의 새 원표 1,245개를 포함합니다.
실제 검색 16개가 모두 성공했고, 최종 570쌍은 합의 541개·미확정 29개입니다. 기존 세 모드와 사람 입력도 보존합니다.
AI-only 기준으로 6개 질문(관련 공고 있는 질문 2개)을 평가했으며 [1차 보고서](support-program-catalog-20260906-v1/review-final-v1/report.md)에
실제 점수와 한계를 기록했습니다. API 키·DB·엑셀 없이 `verify-shared-run.py --with-capture`로 원표부터 지표까지 재현합니다.

지역 자격의 별도 합성 개발 평가도 [1차 실패 기록](region-scope-20260907-v1/README.md)과
[OR 대안 보완 후 부분집합 재검증](region-scope-20260907-v2/README.md)으로 공유합니다.
가상 공고·지역 조건, 필터 전 응답, 평가 보고서, 선별된 사용량·해시 및 변경 소스 스냅샷만 포함합니다.
키·개인정보·원시 오류 로그는 포함하지 않습니다. 저장된 결과는 저장소 루트에서 외부 API 없이 재평가합니다.

[검색 지연 비교](search-latency-20260908-v1/README.md)는 공개 공고 20개 고정의 일반/축약/Fast 18회와
동일 실제 검색 2회 한도 검증을 보관합니다. 미채택 실험·실패도 남기며, API 호출 없이 비교 보고서를 재계산합니다.

[지역 충돌 재검증](region-conflict-20260908-v1/README.md)은 이후 Fast 상시 설정과 함께 수행한
합성 54개 판정의 전후 비교, 공개 공고의 타지역 충돌·이전 예외 및 실제 검색 1회 확인을 보관합니다.
기대값은 AI 작성 개발용 사례이며 전체 카탈로그 정확도나 사람 검증 정답으로 취급하지 않습니다.

```bash
python3 evaluation/support-program-search/evaluate-region-eligibility.py --fixture evaluation/support-program-search/runs/region-scope-20260907-v1/fixture.json --capture evaluation/support-program-search/runs/region-scope-20260907-v1/capture.json
python3 evaluation/support-program-search/evaluate-region-eligibility.py --fixture evaluation/support-program-search/runs/region-scope-20260907-v2/fixture.json --capture evaluation/support-program-search/runs/region-scope-20260907-v2/capture.json
```

v1은 22/24로 종료 코드 1, v2는 16/16으로 종료 코드 0이 정상 재현 결과입니다. v2가 최신 프롬프트로
전체 24개를 재검증한 것은 아니며 실제 공고 검색 품질·독립 heldout 정확도를 입증하지 않습니다.
이 명령은 저장된 판정의 평가만 재현하며 모델을 다시 호출하거나 실제 호출 출처를 자동 인증하지 않습니다.

권장 파일 구성은 다음과 같습니다.

재사용 도구와 AI-only·혼합·사람 검토 기준은 [검토 도구 안내](../review/README.md)에서 관리합니다.
현재 버전의 공고 스냅샷·판정 원본·보고서와 생성·변환 스크립트·회귀 테스트는 Git 포함 대상입니다.
XLSX·HTML·미리보기 이미지는 공유된 원본으로 다시 생성하므로 제외합니다. 브라우저 입력은 JSON으로 내보내야
다른 개발자가 이어받을 수 있습니다. Git 공유는 실시간 브라우저 동기화를 의미하지 않습니다.

- `fixture-unlabeled.json`: `evaluation-fixture-export`가 만든 기준일 고정 초안
- `fixture-labeled.json`: 선택한 방식으로 질문·정답을 판정한 파일. `labelReview.mode`에 출처 기록
- `query-set.json`: capture에 전달한 질문 묶음
- `capture.json`: 같은 기준일의 실제 후보·최종 추천 결과(v2)
- `run-manifest.md`: 실행 시각·기준일·커밋·모델·해시 기록
- `report.md`: 후보와 최종 추천 지표 및 오류 사례
- `review-v1/`, `review-final/`: 판정을 보존하는 버전별 CSV·manifest·XLSX
- `review-v2/web/index.html`: 엑셀 없이 여는 로컬 검토 화면
- `review-progress-*.json`: 브라우저에서 저장한 판정과 대화 출처. 원본 JSON을 보관하고 CSV는 도구로 변환
- `review-v2/codex-ai-v1/`: 고정 입력·정책·실제 하위 에이전트 배정·독립 판정 원본·수집 결과
- `review-v2/selected-ai-v1/`: 선택 모드의 CSV·selection.json·사람 입력 보존 파일과 검토 화면
- `review-v2/codex-ai-recheck-v1/`: 한 차례 추가 독립 판정 210건·원인 감사·원본 참조·보고서
- `review-v2/selected-ai-recheck-v1/`, `selected-hybrid-recheck-v1/`: 과거 사전 풀의 재검토 선택 결과
- `actual-capture-v1/`, `actual-capture-v2/`: 실패한 실제 실행의 감사 기록(정답·성공 결과 아님)
- `actual-capture-v3/`: 성공한 16개 검색 캡처·설정/소스 해시·사용량
- `review-final-v1/`: 실제 후보가 합쳐진 최종 풀·추가 판정·선택·평가 라벨·전체/dev/heldout 보고서

AI-only는 기존 사람 판정을 정답에 섞지 않습니다. 동일 자료의 판정은 한 번 보관한 뒤 검색 변경 때 재사용할 수
있습니다. 검토 방식이나 내용이 바뀌면 새 출력 경로에 생성합니다. AI 판정 파일만 완성했다고 실제 검색 지표를
측정한 것은 아니며, 실제 캡처 없이 Recall/MRR 결과를 만들어 기록하지 않습니다.

fixture와 capture의 `referenceDate`는 반드시 같아야 합니다. 날짜가 달라지면 `OPEN` 공고 집합도 달라질 수
있으므로 `evaluate.py`가 평가를 거부합니다. 생성 파일을 임의로 덮어쓰지 말고 새 `runId` 디렉터리를 만들어
보관합니다.
