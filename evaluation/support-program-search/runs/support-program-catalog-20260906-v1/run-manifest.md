# 지원사업 검색 최소 평가 실행 기록

## 실행 식별

- runId: `support-program-catalog-20260906-v1`
- 준비 시각(KST): `2026-09-06`
- Core API commit SHA: `f7bf6a8ae2bbaf06567e5b48fb8fcee4880a9fcf`
- AI Service commit SHA: `f7bf6a8ae2bbaf06567e5b48fb8fcee4880a9fcf`
- 준비 당시 작업 트리: tracked 파일 변경 없음
- 공유 범위: 평가 검토 도구·테스트·현재 고정 공고·판정·README는 Git 포함 대상. 실제 서비스 코드 변경 없음
- 실제 캡처 실행자 및 시각: 대기
- 라벨 검토 방식: 사용자 선택에 따라 AI-only. Codex `gpt-5.6-luna` 독립 작업 5개, 1,605개 판정 완료

## 고정한 공고·질문

- referenceDate: `2026-09-06`
- fixture: `fixture-unlabeled.json`
- fixture SHA-256: `d59feefeb44eac64a92c96cc4e1f44462c1f8110aeaf7894881dae5f5f5bc067`
- fixture catalog fingerprint: `d3a81627a9e0dd6480091445d6cfb4f99cfdebc7e5cdc8ebfbb362e9f2283deb`
- 전체 공개 공고 수 / 평가 대상 OPEN 공고 수: `1,506 / 1,422`
- query set: `query-set.json`
- query-set 파일 SHA-256: `46b3e0d5db81f318785cb9eec441f3f7ff593c4c23eccdeaa756fa5574ff7d93`
- capture용 논리 query-set SHA-256: `3cce56a30ae70d4c186896d00388f77e9427c9d99efeba1fd64fe91c503cdb83`
- 질문 수정: 실제 캡처·사람 판정 전에 Q01의 온라인 판매 제품/제작 서비스와 Q04의 국내 통역을 명확히 함
- 질문 출처: 실제 공고를 참고해 만든 소규모 평가 질문이며 실제 사용자 분포를 대표하지 않음
- dev / heldout: `10 / 6`
- 무결과 예상 질문: `Q09`, `Q10`, `Q15`, `Q16`

## 후보 풀

- pool config SHA-256: `441448b527999cc5b4833d49a73fe6c3f45ac49c7835b10109cb8dda4133229d`
- 현재 검토 버전: `review-v2/`
- 오프라인 후보 수: `321행`
- 오프라인 review CSV SHA-256: `fa9e0e9c3a68192af90fb7b153a4bed15f5d155f96187a15260e52dd6e77b3b7`
- 오프라인 pool manifest SHA-256: `02891591f60d1235094fb3cfe9d0b84af12752eb18c7eb7cc2e8f050f22ee24c`
- 검토 XLSX SHA-256: `6142be4c5c3c97364e977bb7cf7eaf9aba60d7430fab365be4651b9b320e9231`
- 이전 최상위 323행 CSV와 outputs 초안은 로컬 보존용이며 Git 공유·새 검토에 사용하지 않음
- 검증: 스냅샷 1,422건 본문 해시 일치, XLSX 왕복 321행 전체 필드 일치, 판정 입력 전부 빈칸
- 도구 테스트: 기존 평가 26건, 사람 검토 변환 9건, XLSX 작업 5개 시나리오(부모 포함 Node 6건) 통과
- XLSX 검증: 두 시트 렌더 확인, 불변 내용 해시 확인, 수식 오류 없음, 입력값 미리 판정하지 않음
- 실제 검색 후보 병합: 대기
- 최종 review CSV SHA-256: 대기
- 라벨 완료 / 무결과 / 판단 보류 질문 수: 대기

## 검색 실행 설정

- acceptingOnly: `true`
- 후보 최대 개수: `20`
- 최종 추천 최대 개수: `5`
- ranking scoringVersion: 캡처 후 기록
- OpenAI ranking model: 캡처 후 기록
- 임베딩 모델 / 차원: 캡처 후 기록
- Qdrant collection 이름 및 버전: 캡처 후 기록
- ranking prompt SHA-256: 캡처 후 기록

## 결과

- 엑셀 없는 검토 화면: 초기 로컬 파일은 `review-v2/web/index.html`. 다른 PC는 [공유 안내](README.md)에 따라 새로 생성
- 사용자 구성: 단일 검토자. 대화 요약을 보고 확인한 두 공고의 판정과 원문 응답을 화면에 이어받음
- 초기 화면: 321행 중 2행 입력 완료, 319행 미완료. 실제 검색 품질 점수나 질문 전체 라벨 완료가 아님
- 웹 검토 검증: 기존 평가 26건 + 검토 Python 24건 통과. 합성 데이터 브라우저 시나리오 12개 통과
- 브라우저 검증 범위: 부분 입력 저장·새로고침·JSON 저장/불러오기·CSV 변환·잘못된 파일 거부·저장 충돌·360px 너비
- 실제 검토 데이터에 테스트 판정을 추가하지 않음. OpenAI/API 호출 없이 로컬 화면만 구현
- 결과 회수: 화면에서 저장한 JSON 원본 보관 후 `extract-review-json.py`로 새 CSV 생성
- capture schemaVersion: `support-program-search-capture-v2`
- capture 파일명 및 SHA-256: 대기
- capture capturedAt: 대기
- dev 결과 파일: 대기
- heldout 결과 파일: 대기
- 실행 결과: AI 참조 판정 생성 완료(합의 279/미확정 42개). 실제 검색 캡처 및 후보/최종 추천 점수는 아직 없음
- 판정 실행 경로: 프로젝트 OpenAI API 키 대신 Codex Luna 하위 에이전트. 프로젝트 API 호출 없음
- 캡처 상태: 별도의 실제 운영 검색 실행이 필요하며 아직 실행하지 않음. Codex 판정으로 검색 결과를 대체하지 않음

## 선택 가능한 판정 방식

- `ai-only`: 기본값. 5개 독립 판정 중 4개 이상 합의한 결과만 사용. 사람 확인 불필요
- `hybrid`: 불일치/정보 부족 전부와 질문별 합의 표본 10%(최소 1개)의 실제 사람 확인 후 사용
- `human`: 기존 브라우저 검토에서 사람이 판정한 값만 사용
- 사람 판정 원본: `review-v2/conversation-judgments.json`의 2건을 별도 보존. AI-only 정답으로 주입하지 않음
- 사람 모드 준비: `review-v2/selected-human-v1/`, 2건 입력/319건 대기. 기존 검토 화면과 저장 공간 분리
- Codex 입력/정책/실행 배정/원본 판정: `review-v2/codex-ai-v1/`
- 현재 선택: `review-v2/selected-ai-v1/`. 사람 확인 0건, 사용할 수 있는 질문 4/16개. 검색 평가 완료 아님
- 혼합 모드 준비: `review-v2/selected-hybrid-v1/`. 사람 필수 확인 79건 대기(미확정 42 + 합의 표본 37)
- 결과 보고서: `review-v2/codex-ai-v1/labeling-report.md`
- 초안 거부 및 교정 기록: `review-v2/codex-ai-v1/execution-log.md`
- 검증: Python 평가 32건 + 검토 도구 68건 통과, 합성 브라우저 시나리오 13개(부모 포함 14건) 통과
- 재사용: 같은 스냅샷·질문·정책의 판정은 보관 후 재사용. 검색/프롬프트/모델의 중요한 변경 때만 전후 비교

## 미확정 추가 검토 — 2026-09-06

위 최초 판정 기록은 과거 상태로 보존하며 현재 선택은 아래 추가 버전이다.

- 작업 시작 코드: `b5afa7e` (`검색 평가 자료 공유 및 재현 검증 추가`)
- 고정 범위: 최초 미확정 42건 전부, 추가 독립 실행 5개 × 42건 = 210개 판정, 한 차례만 수행
- 실행 모델: `gpt-5.6-luna`, 실제 ID `/root/luna_recheck_1`~`/root/luna_recheck_5`
- 기준·질문·공고·dev/heldout 변경 없음. 최초 합의 279건과 원본 1,605개 표결은 보존
- 부모 AI 파일 SHA-256: `5940264cafa520edafbb058811d24bf6c21f25f92e09d4318391b120d57da2c6`
- 추가 입력 논리 SHA-256: `f39839644def6a78edbf3e95ab97f05f8c09afcfda4e46ef7f6a68064f1df8bd`
- 추가 AI 파일 SHA-256: `0817986dedcfb3b1dde45eca29ef2c9ffa094f3c2d1a34c540716e5b0ae93d89`
- AI-only 선택 파일 SHA-256: `d8a11bcef24566df81baabe287713c42b1c8da867370ae6a76669d6f5d26639c`
- 추가 합의: relevant 6건·irrelevant 18건, 추가 검토 후에도 미확정 18건 유지
- 현재 전체: 합의 303건(relevant 25 / irrelevant 278)·미확정 18건
- 현재 AI-only: `review-v2/selected-ai-recheck-v1/`, 평가 가능한 질문 8/16개, 그중 관련 공고 있는 질문 4개
- 현재 혼합: `review-v2/selected-hybrid-recheck-v1/`, 실제 사람 확인 56건 대기. 사람 모드는 기존 2건/319건 대기 유지
- 출처·근거·원인 감사: `review-v2/codex-ai-recheck-v1/`. 감사는 독립 표결 완료 뒤 AI가 분석했으며 사람 검증 아님
- 프로젝트 API 호출·실제 검색 캡처·실제 품질 점수 없음
- 보고서: [추가 검토 결과](review-v2/codex-ai-recheck-v1/recheck-report.md)
- 오프라인 검증: [공유 안내](README.md)의 `verify-shared-run.py --with-recheck` 명령 사용
- 검증 결과: 평가 32건 + 검토 93건 = 125개 오프라인 테스트 통과. Git 포함 대상만의 별도 체크아웃에서도
  통과(`core.autocrlf=true`, 고정 자료 미변경). 실제 검색·서비스 통합 테스트는 이번 범위 아님

## 실제 API 검색 시도 및 중단 — 2026-09-06

- 위 기록은 각 시점의 과거 상태다. 이후 사용자가 프로젝트 API 키 및 질문·공개 후보 공고의 OpenAI 전송을 승인했다.
- 시작 소스 `d92bf4ee265dd779f9cfd502cee6093969c9c47a`, MySQL 전체 1,506건·적격 1,422건 및
  Qdrant 현재 버전 1,422건을 확인했다. 원본 fixture의 내용·정렬 시각·지문까지 동일했다.
- 총 네 시도 모두 Q01 추천 단계에서 중단. Q02~Q16 미실행, 성공한 전체 capture·품질 점수 없음.
- 후보 20개 중 19개 응답을 확인해 Agent strict schema를 요청 수에 맞춰 제한했다.
  수정 후 실제 응답은 20개였지만 총점 불일치 2건·부적합 대상 점수 모순 1건을 검증기가 거부했다.
- 모델·프롬프트·점수 기준·기본 timeout은 바꾸지 않았다. 진단 실행만 모델25초·Agent30초·Core35초를 사용했다.
- 호출 시도: 임베딩4회 + 추천4회, 모델 접근 조회1회 별도. 신규 공고 임베딩0회. 일부 토큰 미관측으로 총 청구액 미확정.
- 기존 AI 1,815표·사람 판정2건·미확정18건·dev/heldout 및 기준 정책은 보존했다. 새 capture가 없어 추가 판정도 미실행.
- `transfer-ai-review.py`로 기존 AI 판정·재검토를 새 실제 capture 풀에 출처 유지하며 이전할 준비를 마쳤다.
- 검증: AI Service 163건 + 평가32건 + 검토103건 통과, 기존 공유 자료 재현 및 `git diff --check` 통과.
- 원본 모델 출력·상세 원인·남은 작업: [실제 실행 및 중단 기록](actual-capture-v1/README.md).
- 다음 작업: 총점 계산 및 부적합 조건부 점수의 책임 정리 → 오프라인 재현 → 새 실제 capture → 새 후보 판정 → 점수 계산.
- 현재 단계: **3단계 진행 중, 실제 측정 미완료**. 임시 서비스는 종료했고 DB·Qdrant 데이터는 보존했다.
