# 지원사업 검색 실데이터 평가 실행 기록

이 파일을 실제 평가 출력 폴더로 복사해 한 번의 평가 실행마다 작성한다. 실제 공고 fixture와
capture 파일은 제공처 이용 조건을 검토한 뒤 보관하며, 특별한 승인 없이 Git에 커밋하지 않는다.
API 키, 비밀번호, 내부 URL, 개인 식별 정보는 기록하지 않는다.

## 실행 식별

- runId: `support-program-catalog-YYYYMMDD-v2`
- 실행 시각(KST):
- 실행자:
- 라벨 검토자 및 검토 시각(KST):
- Core API commit SHA:
- AI Service commit SHA:
- 작업 트리 상태: `clean` / 변경 내용 설명

## 고정한 공고·질문

- readiness 상태 및 확인 시각(KST):
- `referenceDate` (fixture/capture 동일, YYYY-MM-DD):
- fixture 파일명 및 SHA-256:
- fixture catalog fingerprint:
- 전체 공개 공고 수 / 평가 대상 OPEN 공고 수:
- query-set 파일명 및 SHA-256:
- 개발용(dev) / 검증용(heldout) 질문 수:
- 라벨 완료 / 무결과(`[]`) / 판단 보류(`null`) 질문 수:

## 검색 실행 설정

- `acceptingOnly`: `true`
- 후보 최대 개수: `20`
- 최종 추천 최대 개수: `5`
- ranking scoringVersion:
- OpenAI ranking model:
- 임베딩 모델 / 차원:
- Qdrant collection 이름:
- Qdrant 버전:
- ranking prompt 파일 SHA-256:

## 결과

- capture 파일명 및 SHA-256:
- capture schemaVersion: `support-program-search-capture-v2`
- capture `capturedAt`:
- 평가 명령:
- dev 결과 파일:
- heldout 결과 파일:
- 실행 결과: `성공` / `실패`
- 실패 또는 재실행 사유:
