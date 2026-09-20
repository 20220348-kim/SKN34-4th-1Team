-- 일반 중복 검토는 NULL을 유지하므로 한 사용자가 여러 검토를 만들 수 있습니다.
-- 로컬 시드만 고정 키를 넣어 사용자별 독립 목업을 한 건씩 유지합니다.
ALTER TABLE combination_review
    ADD COLUMN demo_seed_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER owner_account_id;

-- 이전 demo-data.sql의 완료 목업은 고정 request/runner/configuration 표식이 모두 일치할 때만 승계합니다.
UPDATE combination_review review
JOIN account owner ON owner.id = review.owner_account_id
JOIN combination_review_run run ON run.review_id = review.id
SET review.demo_seed_key = 'combination-review-completed-v1'
WHERE owner.email = 'member@govbiz.local'
  AND review.title = '진행 중인 지원사업과 신규 신청 중복 검토'
  AND run.request_key = '10000000-0000-4000-8000-000000000001'
  AND run.runner_instance_id = '20000000-0000-4000-8000-000000000001'
  AND JSON_UNQUOTE(JSON_EXTRACT(run.configuration_json, '$.model')) = 'demo-seed-no-paid-call';

-- 이전 초안에는 실행 표식이 없으므로 제목·실행 부재·두 입력 위치의 전체 상태가 모두 맞는 행만 승계합니다.
UPDATE combination_review review
JOIN account owner ON owner.id = review.owner_account_id
SET review.demo_seed_key = 'combination-review-draft-v1'
WHERE owner.email = 'member@govbiz.local'
  AND review.title = '마케팅·기술지원 사업 동시 신청 검토'
  AND NOT EXISTS (
      SELECT 1 FROM combination_review_run run WHERE run.review_id = review.id
  )
  AND (SELECT COUNT(*) FROM combination_review_program program WHERE program.review_id = review.id) = 2
  AND EXISTS (
      SELECT 1
      FROM combination_review_program program
      WHERE program.review_id = review.id
        AND program.position = 0
        AND program.application_submitted = 'YES'
        AND program.selected = 'UNKNOWN'
        AND program.commitment_submitted = 'NO'
        AND program.agreement_signed = 'NO'
        AND program.execution_status = 'NOT_STARTED'
        AND program.funding_received = 'NO'
  )
  AND EXISTS (
      SELECT 1
      FROM combination_review_program program
      WHERE program.review_id = review.id
        AND program.position = 1
        AND program.application_submitted = 'NO'
        AND program.selected = 'NO'
        AND program.commitment_submitted = 'NO'
        AND program.agreement_signed = 'NO'
        AND program.execution_status = 'NOT_STARTED'
        AND program.funding_received = 'NO'
  );

ALTER TABLE combination_review
    ADD CONSTRAINT uq_combination_review_demo_seed UNIQUE (owner_account_id, demo_seed_key);
