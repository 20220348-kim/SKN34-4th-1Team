-- 끝난 양식 분석·문서 생성 작업의 결과를 사용자가 확인한 시각이다. NULL이면 아직 확인하지 않은 결과다.
ALTER TABLE application_form_discovery_job ADD COLUMN seen_at DATETIME(6) NULL AFTER finished_at;
ALTER TABLE application_document_generation_job ADD COLUMN seen_at DATETIME(6) NULL AFTER finished_at;

-- 이 컬럼이 생기기 전에 끝난 작업은 이미 확인한 것으로 둔다. 진행 중·결과 불명 작업은 끝난 뒤 확인 대상이 된다.
UPDATE application_form_discovery_job SET seen_at = COALESCE(finished_at, created_at) WHERE status IN ('SUCCEEDED', 'FAILED');
UPDATE application_document_generation_job SET seen_at = COALESCE(finished_at, created_at) WHERE status IN ('SUCCEEDED', 'FAILED');
