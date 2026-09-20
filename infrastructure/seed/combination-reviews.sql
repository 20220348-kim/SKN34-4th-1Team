-- 중복 지원·수혜 검토 목업 2건을 대상 계정마다 독립된 parent/child 행으로 유지합니다.
-- @demo_seed_target_emails가 비어 있으면 팀 시연용 admin@govbiz.local과 member@govbiz.local을 선택합니다.
-- 쉼표로 구분된 이메일이 전달되면 해당 활성 계정만 선택하며, 누락되거나 사용할 수 없는 계정이 있으면 실패합니다.
-- 일반 검토(NULL 키)와 기존 목업의 사용자 수정 내용은 삭제하거나 덮어쓰지 않습니다.
SET NAMES utf8mb4;
SET @now := NOW(6);
SET @demo_seed_target_emails := TRIM(COALESCE(@demo_seed_target_emails, ''));
SET @personal_demo_seed_lock_acquired := GET_LOCK('govbiz-personal-demo-seed-v1', 60);

START TRANSACTION;

DROP TEMPORARY TABLE IF EXISTS demo_seed_requested_email;
CREATE TEMPORARY TABLE demo_seed_requested_email (
    email VARCHAR(320) NOT NULL,
    PRIMARY KEY (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO demo_seed_requested_email (email)
WITH RECURSIVE requested_email (email, remainder) AS (
    SELECT
        TRIM(SUBSTRING_INDEX(@demo_seed_target_emails, ',', 1)),
        CASE
            WHEN LOCATE(',', @demo_seed_target_emails) = 0 THEN ''
            ELSE SUBSTRING(@demo_seed_target_emails, LOCATE(',', @demo_seed_target_emails) + 1)
        END
    WHERE @demo_seed_target_emails <> ''
    UNION ALL
    SELECT
        TRIM(SUBSTRING_INDEX(remainder, ',', 1)),
        CASE
            WHEN LOCATE(',', remainder) = 0 THEN ''
            ELSE SUBSTRING(remainder, LOCATE(',', remainder) + 1)
        END
    FROM requested_email
    WHERE remainder <> ''
)
SELECT DISTINCT email
FROM requested_email
WHERE email <> '';

DROP TEMPORARY TABLE IF EXISTS demo_seed_target_account;
CREATE TEMPORARY TABLE demo_seed_target_account (
    account_id BIGINT UNSIGNED NOT NULL,
    email VARCHAR(320) NOT NULL,
    PRIMARY KEY (account_id),
    UNIQUE KEY uq_demo_seed_target_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO demo_seed_target_account (account_id, email)
SELECT account.id, account.email
FROM account
WHERE account.role IN ('USER', 'ADMIN')
  AND account.deleted_at IS NULL
  AND account.suspended_at IS NULL
  AND (
      (@demo_seed_target_emails = '' AND account.email IN ('admin@govbiz.local', 'member@govbiz.local'))
      OR (@demo_seed_target_emails <> '' AND EXISTS (
          SELECT 1 FROM demo_seed_requested_email requested WHERE requested.email = account.email
      ))
  );

DROP TEMPORARY TABLE IF EXISTS demo_seed_target_guard;
CREATE TEMPORARY TABLE demo_seed_target_guard (
    selected_account_count INT NOT NULL,
    expected_account_count INT NOT NULL,
    lock_acquired INT NOT NULL,
    CONSTRAINT chk_demo_seed_target_accounts CHECK (
        selected_account_count > 0
        AND selected_account_count = expected_account_count
        AND lock_acquired = 1
    )
) ENGINE=InnoDB;

SET @demo_seed_selected_account_count := (SELECT COUNT(*) FROM demo_seed_target_account);
SET @demo_seed_expected_account_count := CASE
    WHEN @demo_seed_target_emails = '' THEN @demo_seed_selected_account_count
    ELSE (SELECT COUNT(*) FROM demo_seed_requested_email)
END;
INSERT INTO demo_seed_target_guard (selected_account_count, expected_account_count, lock_acquired)
VALUES (@demo_seed_selected_account_count, @demo_seed_expected_account_count, @personal_demo_seed_lock_acquired);

-- 같은 계정에 대한 동시 시드 실행을 계정 ID 순서로 직렬화합니다.
SELECT account.id
FROM account
JOIN demo_seed_target_account target ON target.account_id = account.id
ORDER BY account.id
FOR UPDATE;

DELETE review
FROM combination_review review
JOIN demo_seed_target_account target ON target.account_id = review.owner_account_id
WHERE COALESCE(@reset_personal_demo_data, 0) = 1
  AND review.demo_seed_key IN (
      'combination-review-completed-v1',
      'combination-review-draft-v1'
  );

-- Fresh DB에서는 demo-data.sql이 선택한 것과 같은 최신 공고가 선택됩니다. 기존 DB에서는 현재 보존된 공고를 사용합니다.
DROP TEMPORARY TABLE IF EXISTS combination_seed_program;
CREATE TEMPORARY TABLE combination_seed_program AS
SELECT
    candidate.id,
    candidate.source_code,
    candidate.source_program_id,
    candidate.source_url,
    ROW_NUMBER() OVER (ORDER BY candidate.application_end_date DESC, candidate.id) AS seq
FROM (
    SELECT id, source_code, source_program_id, source_url, application_end_date
    FROM support_program
    WHERE source_code = 'BIZINFO'
      AND is_source_present = TRUE
    ORDER BY application_end_date DESC, id
    LIMIT 4
) candidate;

DROP TEMPORARY TABLE IF EXISTS combination_seed_program_guard;
CREATE TEMPORARY TABLE combination_seed_program_guard (
    program_count INT NOT NULL,
    CONSTRAINT chk_combination_seed_needs_four_programs CHECK (program_count = 4)
) ENGINE=InnoDB;
INSERT INTO combination_seed_program_guard (program_count)
SELECT COUNT(*) FROM combination_seed_program;

SET @p1_source_code := (SELECT source_code FROM combination_seed_program WHERE seq = 1);
SET @p1_source_program_id := (SELECT source_program_id FROM combination_seed_program WHERE seq = 1);
SET @p1_source_url := (SELECT source_url FROM combination_seed_program WHERE seq = 1);
SET @p2_source_code := (SELECT source_code FROM combination_seed_program WHERE seq = 2);
SET @p2_source_program_id := (SELECT source_program_id FROM combination_seed_program WHERE seq = 2);
SET @p2_source_url := (SELECT source_url FROM combination_seed_program WHERE seq = 2);
SET @p3_source_code := (SELECT source_code FROM combination_seed_program WHERE seq = 3);
SET @p3_source_program_id := (SELECT source_program_id FROM combination_seed_program WHERE seq = 3);
SET @p4_source_code := (SELECT source_code FROM combination_seed_program WHERE seq = 4);
SET @p4_source_program_id := (SELECT source_program_id FROM combination_seed_program WHERE seq = 4);

INSERT INTO combination_review (
    owner_account_id, demo_seed_key, title, input_revision, created_at, updated_at
)
SELECT
    target.account_id, 'combination-review-completed-v1',
    '진행 중인 지원사업과 신규 신청 중복 검토', 1,
    DATE_SUB(@now, INTERVAL 5 DAY), DATE_SUB(@now, INTERVAL 4 DAY)
FROM demo_seed_target_account target
LEFT JOIN combination_review existing
    ON existing.owner_account_id = target.account_id
   AND existing.demo_seed_key = 'combination-review-completed-v1'
WHERE existing.id IS NULL;

INSERT INTO combination_review (
    owner_account_id, demo_seed_key, title, input_revision, created_at, updated_at
)
SELECT
    target.account_id, 'combination-review-draft-v1',
    '마케팅·기술지원 사업 동시 신청 검토', 1,
    DATE_SUB(@now, INTERVAL 1 DAY), DATE_SUB(@now, INTERVAL 1 DAY)
FROM demo_seed_target_account target
LEFT JOIN combination_review existing
    ON existing.owner_account_id = target.account_id
   AND existing.demo_seed_key = 'combination-review-draft-v1'
WHERE existing.id IS NULL;

INSERT INTO combination_review_program (
    review_id, position, source_code, source_program_id, sub_program_id,
    application_submitted, selected, commitment_submitted, agreement_signed, execution_status, funding_received
)
SELECT
    review.id, 0, @p1_source_code, @p1_source_program_id, NULL,
    'YES', 'YES', 'YES', 'YES', 'IN_PROGRESS', 'YES'
FROM demo_seed_target_account target
JOIN combination_review review
    ON review.owner_account_id = target.account_id
   AND review.demo_seed_key = 'combination-review-completed-v1'
LEFT JOIN combination_review_program existing ON existing.review_id = review.id AND existing.position = 0
WHERE existing.review_id IS NULL;

INSERT INTO combination_review_program (
    review_id, position, source_code, source_program_id, sub_program_id,
    application_submitted, selected, commitment_submitted, agreement_signed, execution_status, funding_received
)
SELECT
    review.id, 1, @p2_source_code, @p2_source_program_id, NULL,
    'YES', 'NO', 'NO', 'NO', 'NOT_STARTED', 'NO'
FROM demo_seed_target_account target
JOIN combination_review review
    ON review.owner_account_id = target.account_id
   AND review.demo_seed_key = 'combination-review-completed-v1'
LEFT JOIN combination_review_program existing ON existing.review_id = review.id AND existing.position = 1
WHERE existing.review_id IS NULL;

INSERT INTO combination_review_program (
    review_id, position, source_code, source_program_id, sub_program_id,
    application_submitted, selected, commitment_submitted, agreement_signed, execution_status, funding_received
)
SELECT
    review.id, 0, @p3_source_code, @p3_source_program_id, NULL,
    'YES', 'UNKNOWN', 'NO', 'NO', 'NOT_STARTED', 'NO'
FROM demo_seed_target_account target
JOIN combination_review review
    ON review.owner_account_id = target.account_id
   AND review.demo_seed_key = 'combination-review-draft-v1'
LEFT JOIN combination_review_program existing ON existing.review_id = review.id AND existing.position = 0
WHERE existing.review_id IS NULL;

INSERT INTO combination_review_program (
    review_id, position, source_code, source_program_id, sub_program_id,
    application_submitted, selected, commitment_submitted, agreement_signed, execution_status, funding_received
)
SELECT
    review.id, 1, @p4_source_code, @p4_source_program_id, NULL,
    'NO', 'NO', 'NO', 'NO', 'NOT_STARTED', 'NO'
FROM demo_seed_target_account target
JOIN combination_review review
    ON review.owner_account_id = target.account_id
   AND review.demo_seed_key = 'combination-review-draft-v1'
LEFT JOIN combination_review_program existing ON existing.review_id = review.id AND existing.position = 1
WHERE existing.review_id IS NULL;

SET @review_facts := '기존 사업은 협약을 체결해 수행 중이며, 신규 사업은 신청서 제출 전 중복 수혜 가능성을 확인하려는 단계입니다.';
SET @review_source_0 := CONVERT('데모 원문 1\n동일 또는 유사한 사업 내용으로 다른 정부지원사업의 보조금을 중복하여 지원받을 수 없습니다. 수행 중인 협약과 신규 신청 과제의 목적, 비용 항목 및 수행 기간이 겹치는지 확인해야 합니다.' USING utf8mb4);
SET @review_source_1 := CONVERT('데모 원문 2\n신규 신청기업은 타 지원사업 수행 여부를 신청서에 기재해야 합니다. 사업 목적과 지원 항목이 다르면 신청할 수 있으나, 최종 인정 여부는 전담기관의 검토 결과에 따릅니다.' USING utf8mb4);
SET @review_source_0_hash := SHA2(@review_source_0, 256);
SET @review_source_1_hash := SHA2(@review_source_1, 256);
SET @review_started_at := DATE_SUB(@now, INTERVAL 4 DAY);
SET @review_finished_at := DATE_ADD(@review_started_at, INTERVAL 2 MINUTE);

INSERT INTO combination_review_run (
    review_id, input_revision, request_key, request_hash, status, input_json, evidence_json, configuration_json,
    analysis_json, failure_code, runner_instance_id, started_at, finished_at, execution_started_at
)
SELECT
    review.id,
    1,
    '10000000-0000-4000-8000-000000000001',
    SHA2(CONCAT('1\n', @review_facts), 256),
    'SUCCEEDED',
    JSON_OBJECT(
        'title', '진행 중인 지원사업과 신규 신청 중복 검토',
        'programs', JSON_ARRAY(
            JSON_OBJECT(
                'identity', JSON_OBJECT('sourceCode', @p1_source_code, 'sourceProgramId', @p1_source_program_id, 'subProgramId', NULL),
                'participation', JSON_OBJECT('applicationSubmitted', 'YES', 'selected', 'YES', 'commitmentSubmitted', 'YES', 'agreementSigned', 'YES', 'executionStatus', 'IN_PROGRESS', 'fundingReceived', 'YES')
            ),
            JSON_OBJECT(
                'identity', JSON_OBJECT('sourceCode', @p2_source_code, 'sourceProgramId', @p2_source_program_id, 'subProgramId', NULL),
                'participation', JSON_OBJECT('applicationSubmitted', 'YES', 'selected', 'NO', 'commitmentSubmitted', 'NO', 'agreementSigned', 'NO', 'executionStatus', 'NOT_STARTED', 'fundingReceived', 'NO')
            )
        ),
        'additionalFacts', @review_facts,
        'asOfDate', DATE_FORMAT(CURDATE(), '%Y-%m-%d')
    ),
    JSON_OBJECT(
        'documents', JSON_ARRAY(
            JSON_OBJECT('programIndex', 0, 'sourceUrl', @p1_source_url, 'sourcePageUrl', @p1_source_url, 'fileName', '기존사업-데모원문.txt', 'format', 'TXT', 'rawHash', @review_source_0_hash, 'textHash', @review_source_0_hash, 'parserVersion', 'demo-seed-v1', 'fetchedAt', DATE_FORMAT(@review_started_at, '%Y-%m-%dT%H:%i:%s.%f')),
            JSON_OBJECT('programIndex', 1, 'sourceUrl', @p2_source_url, 'sourcePageUrl', @p2_source_url, 'fileName', '신규사업-데모원문.txt', 'format', 'TXT', 'rawHash', @review_source_1_hash, 'textHash', @review_source_1_hash, 'parserVersion', 'demo-seed-v1', 'fetchedAt', DATE_FORMAT(@review_started_at, '%Y-%m-%dT%H:%i:%s.%f'))
        ),
        'blocks', JSON_ARRAY(
            JSON_OBJECT('id', 'demo-evidence-1', 'programIndex', 0, 'documentHash', @review_source_0_hash, 'locator', '데모 원문 1, 문단 1', 'text', '동일 또는 유사한 사업 내용으로 다른 정부지원사업의 보조금을 중복하여 지원받을 수 없습니다.'),
            JSON_OBJECT('id', 'demo-evidence-2', 'programIndex', 1, 'documentHash', @review_source_1_hash, 'locator', '데모 원문 2, 문단 1', 'text', '사업 목적과 지원 항목이 다르면 신청할 수 있으나, 최종 인정 여부는 전담기관의 검토 결과에 따릅니다.')
        ),
        'coverageWarnings', JSON_ARRAY('이 결과는 화면 확인용 데모 원문을 사용했으며 실제 공고 원문 판정이 아닙니다.')
    ),
    JSON_OBJECT('contractVersion', 'combination-review-v1', 'model', 'demo-seed-no-paid-call', 'promptVersion', 'demo-seed-v1'),
    JSON_OBJECT(
        'summary', '두 사업의 목적과 비용 항목이 겹치면 중복 수혜 제한이 적용될 수 있어 전담기관 확인이 필요합니다.',
        'pairs', JSON_ARRAY(
            JSON_OBJECT(
                'firstProgramIndex', 0,
                'secondProgramIndex', 1,
                'stages', JSON_ARRAY(
                    JSON_OBJECT('stage', 'APPLICATION', 'judgment', 'NEEDS_FACTS', 'scope', '신규 사업 신청 단계', 'explanation', '신청 자체는 가능할 수 있으나 두 과제의 목적과 비용 항목 구분 자료가 더 필요합니다.', 'questions', JSON_ARRAY('두 사업의 세부 비용 항목이 겹치나요?', '신규 과제 산출물이 기존 협약 산출물과 구분되나요?'), 'requiresInstitutionConfirmation', TRUE, 'citations', JSON_ARRAY(JSON_OBJECT('evidenceId', 'demo-evidence-2', 'quote', '사업 목적과 지원 항목이 다르면 신청할 수 있으나'))),
                    JSON_OBJECT('stage', 'SELECTION', 'judgment', 'INSUFFICIENT_EVIDENCE', 'scope', '신규 사업 선정 단계', 'explanation', '선정 단계의 중복 참여 처리 기준은 데모 원문만으로 확인할 수 없습니다.', 'questions', JSON_ARRAY('선정 통보 전에 기존 수행 사업을 신고해야 하나요?'), 'requiresInstitutionConfirmation', TRUE, 'citations', JSON_ARRAY()),
                    JSON_OBJECT('stage', 'COMMITMENT', 'judgment', 'NEEDS_FACTS', 'scope', '확약서 제출 단계', 'explanation', '두 과제의 산출물과 인력 투입 계획을 구분한 자료가 필요합니다.', 'questions', JSON_ARRAY('동일한 인력이 같은 기간에 두 과제에 투입되나요?'), 'requiresInstitutionConfirmation', TRUE, 'citations', JSON_ARRAY()),
                    JSON_OBJECT('stage', 'AGREEMENT', 'judgment', 'CONFLICTING_EVIDENCE', 'scope', '신규 협약 체결 단계', 'explanation', '사업 목적이 다르면 가능하다는 내용과 유사 사업의 중복 지원을 제한하는 내용이 함께 있어 기관 확인이 필요합니다.', 'questions', JSON_ARRAY('전담기관이 두 과제의 목적과 비용 구분을 인정했나요?'), 'requiresInstitutionConfirmation', TRUE, 'citations', JSON_ARRAY(JSON_OBJECT('evidenceId', 'demo-evidence-1', 'quote', '동일 또는 유사한 사업 내용'), JSON_OBJECT('evidenceId', 'demo-evidence-2', 'quote', '사업 목적과 지원 항목이 다르면 신청할 수 있으나'))),
                    JSON_OBJECT('stage', 'EXECUTION', 'judgment', 'NEEDS_FACTS', 'scope', '두 사업 동시 수행 단계', 'explanation', '수행 기간과 참여 인력, 산출물이 실제로 분리되는지 확인해야 합니다.', 'questions', JSON_ARRAY('수행 일정과 참여 인력을 사업별로 구분했나요?'), 'requiresInstitutionConfirmation', TRUE, 'citations', JSON_ARRAY()),
                    JSON_OBJECT('stage', 'FUNDING', 'judgment', 'RESTRICTION_APPLIES', 'scope', '동일 비용의 중복 수혜', 'explanation', '동일하거나 유사한 사업 내용과 비용에 보조금을 중복 적용하면 제한됩니다.', 'questions', JSON_ARRAY(), 'requiresInstitutionConfirmation', FALSE, 'citations', JSON_ARRAY(JSON_OBJECT('evidenceId', 'demo-evidence-1', 'quote', '다른 정부지원사업의 보조금을 중복하여 지원받을 수 없습니다')))
                )
            )
        ),
        'limitations', JSON_ARRAY('자동 생성된 데모 결과이며 실제 자격 판정이나 기관 답변을 대신하지 않습니다.', '화면 동작 확인을 위해 축약한 가상 원문을 사용했습니다.')
    ),
    NULL,
    '20000000-0000-4000-8000-000000000001',
    @review_started_at,
    @review_finished_at,
    @review_started_at
FROM demo_seed_target_account target
JOIN combination_review review
    ON review.owner_account_id = target.account_id
   AND review.demo_seed_key = 'combination-review-completed-v1'
LEFT JOIN combination_review_run existing
    ON existing.review_id = review.id
   AND existing.request_key = '10000000-0000-4000-8000-000000000001'
WHERE existing.id IS NULL;

INSERT INTO combination_review_run_source (run_id, document_index, raw_hash, raw_bytes)
SELECT run.id, 0, @review_source_0_hash, @review_source_0
FROM demo_seed_target_account target
JOIN combination_review review
    ON review.owner_account_id = target.account_id
   AND review.demo_seed_key = 'combination-review-completed-v1'
JOIN combination_review_run run
    ON run.review_id = review.id
   AND run.request_key = '10000000-0000-4000-8000-000000000001'
LEFT JOIN combination_review_run_source existing
    ON existing.run_id = run.id
   AND existing.document_index = 0
WHERE existing.run_id IS NULL;

INSERT INTO combination_review_run_source (run_id, document_index, raw_hash, raw_bytes)
SELECT run.id, 1, @review_source_1_hash, @review_source_1
FROM demo_seed_target_account target
JOIN combination_review review
    ON review.owner_account_id = target.account_id
   AND review.demo_seed_key = 'combination-review-completed-v1'
JOIN combination_review_run run
    ON run.review_id = review.id
   AND run.request_key = '10000000-0000-4000-8000-000000000001'
LEFT JOIN combination_review_run_source existing
    ON existing.run_id = run.id
   AND existing.document_index = 1
WHERE existing.run_id IS NULL;

SELECT target.email, COUNT(review.id) AS combination_review_demo_count
FROM demo_seed_target_account target
LEFT JOIN combination_review review
    ON review.owner_account_id = target.account_id
   AND review.demo_seed_key IS NOT NULL
GROUP BY target.account_id, target.email
ORDER BY target.email;

COMMIT;

DROP TEMPORARY TABLE IF EXISTS combination_seed_program_guard;
DROP TEMPORARY TABLE IF EXISTS combination_seed_program;
DROP TEMPORARY TABLE IF EXISTS demo_seed_target_guard;
DROP TEMPORARY TABLE IF EXISTS demo_seed_target_account;
DROP TEMPORARY TABLE IF EXISTS demo_seed_requested_email;
DO RELEASE_LOCK('govbiz-personal-demo-seed-v1');
