# 저장 binding 변경 승인·이관

## 변경 전 호출·저장 경로

`ApplicationDocumentPage`의 생성 요청은 `POST /api/v1/application-preparations/{id}/documents`로 전달된다. Core `ApplicationDocumentService.generate`는 소유자와 `inputRevision`을 확인하고 원본 첨부의 SHA-256을 대조한 뒤 `ApplicationDocumentMappingService.ensure`를 호출한다. AI `MAP_VERSION`을 포함한 `pipelineVersion`이 저장 `application_form_snapshot.manifest_json.documentMapSnapshot`과 다르면 AI `/document/map`을 다시 호출한다. 이전 binding 또는 `scopeTargetIds`가 새 결과와 다르면 현재 Core는 `APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED`(422)를 반환한다. `ApplicationDocumentExceptionHandler`는 ProblemDetail의 code/detail만 전송하고, 웹 `ApplicationPreparationError`는 이를 이전 포괄 질문용 안내로 표시한다.

변경 전 422에서는 새 map이 MySQL에 저장되지 않고 `application_preparation`의 `input_revision`, `application_preparation_fact`, `application_document_file`이 유지된다. 그러나 같은 원본·discovery 모델·프롬프트의 명시적 재분석은 같은 `formVersionId`를 사용하므로 사용자가 변경 위치를 승인해 복구하는 경로가 없다.

## 이관 경계

하나의 `application_form_snapshot`은 여러 작성본이 공유한다. 승인 결과를 이 공용 행에 덮어쓰면 다른 사용자의 binding도 바뀐다. 따라서 승인 전에는 새 지도 제안을 기존 Redis에 짧게 보관하고, 승인 시에는 해당 작성본만 참조하는 새 양식 스냅샷을 MySQL transaction에서 만든 뒤 해당 작성본의 `form_version_id`만 변경한다. 기존 답변·revision·생성 파일은 유지하며 새 pipeline fingerprint로 다음 파일을 별도 생성한다. 새 스냅샷은 활성 양식 조회·동일 원본 discovery 캐시에 포함하지 않는다.

## 구현된 승인 흐름

생성 요청의 422 `ProblemDetail.mappingMigration`은 문항별 changeType과 기존/새 위치 문맥, 작성본 소유자에게만 유효한 15분 토큰을 포함한다. native target ID는 공개하지 않는다. 사용자가 취소하면 새 지도를 저장하지 않고 이전 답변·파일을 그대로 볼 수 있다. 승인 요청은 `POST /api/v1/application-preparations/{id}/documents/mapping-migration/confirm`이다.

Core는 승인 전에 소유권, `inputRevision`, 원본 SHA-256 재수집 결과, 현재 AI pipelineVersion, 이전 지도 binding/scope를 확인한다. MySQL transaction은 기존 `application_form_snapshot`에서 해당 작성본 전용 `approved-...` 양식 스냅샷을 복제한 뒤 작성본의 `form_version_id`만 CAS로 변경한다. 전용 스냅샷의 source fingerprint는 일반 discovery cache와 달라 다른 사용자의 활성 양식 목록에 들어가지 않는다. `application_preparation_fact`, input revision 및 기존 `application_document_file`은 수정하지 않는다. 다음 초안 생성은 새 pipeline fingerprint로 별도 파일을 만들며 UI가 별도 버튼으로 요청한다.

차이는 fact ID·target ID·binding box와 실제 PDF field/widget의 kind·page·box, 선택 scope로 비교한다. Semantic heading 등 편집 위치와 무관한 metadata만 바뀌면 자동 호환으로 처리한다. `TARGET_ADDED`, `TARGET_REMOVED`, `TARGET_CHANGED`, `BOX_CHANGED`, `KIND_CHANGED`, `SCOPE_CHANGED`를 표시한다.

## 검증 경계

격리 MySQL 8.4 통합 테스트에서 승인 전 보존, 소유자 외 승인 거절, 한 작성본만 새 스냅샷 참조, 답변·revision·파일 보존, 별도 재생성, 답변 revision·원본·pipeline 변경 시 stale 거절, clone 삽입 후 CAS 실패 rollback을 확인했다. Web 테스트는 변경 비교 표시, 취소 시 확인 API 미호출, 승인 후 별도 재생성 버튼을 확인한다. 실제 운영 DB나 배포 상태는 이 테스트에 포함되지 않는다.
