# mapVersion·저장 지도·MySQL 호환성 검증

실행일: 2026-09-25. 이 검증은 운영 DB를 사용하지 않았다. Core의 격리 MySQL 8.4 Testcontainers와 기존 테스트용 Redis 연결에서 구버전 지도, 답변, 파일 cache를 재현했다. DB migration은 추가하지 않았다.

## 실제 생산자·소비자 경로

| 단계 | 실제 코드와 값 |
|---|---|
| 버전 생산 | AI `document_contract.py`: `MAP_VERSION=native-map-v12-hwpx-context-budget`; `PIPELINE_VERSION=SHA-256(CONTRACT, MAP_VERSION, PLAN_VERSION, ENGINES, KORDOC_VERSION)` |
| 지도 조회 | Core `ApplicationDocumentMappingService.ensure`: 저장 지도와 현재 pipelineVersion·원본 SHA-256을 비교. 같으면 재사용, 다르면 AI `/document/map` 재호출 |
| MySQL 저장 | `ApplicationFormSnapshotRepository.attachDocumentMap` → MyBatis `ApplicationFormSnapshotMapper.xml`의 조건부 `JSON_SET(manifest_json, '$.documentMapSnapshot', ...)`. 같은 pipeline이면 덮어쓰지 않음 |
| 작성 파일 cache | `ApplicationDocumentService`: 원본 SHA-256·답변 revision·pipelineVersion을 포함한 generation fingerprint로 조회. 이전 파일 행과 다운로드 API는 유지 |
| 계획 검사 | AI `validate_plan`: saved fact/target/box 일치와 `bindingEligible` 검사. Core HWP 경로는 mapVersion·planHash·binding과 실제 원본을 별도 대조 |

기존 binding이 새 분석에서 다른 target으로 바뀌거나 편집 scope가 달라지면 Core는 `APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED`(422)를 반환하고 새 지도를 DB에 저장하지 않는다. 조용히 다른 칸에 이전 답변을 쓰지 않는다. 이전 지도와 새 결과가 같으면 새 pipelineVersion의 지도로 갱신한다.

## 시나리오와 실제 결과

| 시나리오 | 검증 | 결과 |
|---|---|---|
| 구버전 지도 → 새 버전, 동일 문서·binding·scope | Core 단위 1건 + MySQL 통합 1건 | AI 재매핑 호출 후 새 버전 지도를 저장. 질문 정의·답변 `TEST-COMPANY`·input revision 2 보존 |
| 구버전 저장 binding이 새 지도에서도 유효 | 위 테스트 | 동일 fact ID·target ID·box·scope를 유지해 새 버전 저장. 사용자 재질문 없음 |
| 이전 target이 새 분석에서 선택 불가/다른 target 선택 | Core 단위와 MySQL 통합에서 old-cell → 새 target 드리프트 재현; AI 기존 `SAVED_BINDING_CHANGED` 회귀 | `FORM_REANALYSIS_REQUIRED`로 중단. old-cell 지도, 답변, revision을 유지하고 새 지도를 저장하지 않음 |
| binding은 같고 scope만 달라짐 | Core 단위 테스트 | `FORM_REANALYSIS_REQUIRED`로 중단하고 저장 지도 갱신 없음 |
| 이전 생성 파일 cache | MySQL 통합 테스트의 기존 파일 행 | 이전 pipeline fingerprint로 조회 가능, 새 pipeline fingerprint로는 cache hit 없음. 기존 파일은 소유자 조회로 보존 |

`ApplicationDocumentMappingServiceTest` 5개 통과, `ApplicationPreparationApiIntegrationTest.changedMapVersionRemapsSameBindingButRejectsDriftWithoutChangingSavedAnswers` 1개가 실제 MySQL 8.4에서 통과했다. AI의 저장 binding 변경 거절 테스트는 관련 pytest 회귀에 포함된다. 운영 DB, 원격 CI, 실제 배포 후 데이터 재분석은 검증하지 않았다.

## 배포 해석과 남은 위험

- 동일 주소·scope의 구버전 지도는 `SAFE_RECOMPUTE`이지만 첫 접근에 실제 재매핑 호출·지연이 발생하므로 `REQUIRES_REMAP`이다.
- target 또는 scope가 변한 기존 지도의 자동 사용은 `INVALIDATES_BINDINGS`로 차단한다. 이전 답변·파일은 남고 새 초안은 `USER_RECONFIRMATION_REQUIRED` 상태다.
- 현재 명시적 양식 다시 분석 경로는 동일한 원본·discovery 모델·프롬프트에서 같은 formVersionId의 저장 스냅샷을 재사용한다. 바뀐 binding을 승인해 새 formVersionId로 이관하는 자동 경로는 없으므로, 드리프트가 실제로 발생한 사용자는 자동 재시도만으로 복구되지 않는다. 안전한 재확인·이관 흐름은 후속 과제다.
- 새 코드가 기존 사용자 DB에 적용됐다는 뜻은 아니다. 이 테스트는 격리 MySQL의 가상 답변·파일만 사용했다.
