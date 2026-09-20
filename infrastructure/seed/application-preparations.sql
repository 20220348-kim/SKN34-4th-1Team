-- 신청서 작성 도우미 목업 2건을 대상 계정마다 독립된 행으로 유지합니다.
-- @demo_seed_target_emails가 비어 있으면 팀 시연용 admin@govbiz.local과 member@govbiz.local을 선택합니다.
-- 쉼표로 구분된 이메일이 전달되면 해당 활성 계정만 선택하며, 누락되거나 사용할 수 없는 계정이 있으면 실패합니다.
-- 일반 작업(NULL 키)과 기존 목업의 사용자 수정 내용은 삭제하거나 덮어쓰지 않습니다.
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

DELETE preparation
FROM application_preparation preparation
JOIN demo_seed_target_account target ON target.account_id = preparation.owner_account_id
WHERE COALESCE(@reset_personal_demo_data, 0) = 1
  AND preparation.demo_seed_key IN (
      'innovation-voucher-technical-v1',
      'innovation-voucher-marketing-v1'
  );

SET @application_form_version := 'bizinfo-pbln-000000000118979-innovation-voucher-2026-v1';
SET @application_source_code := 'BIZINFO';
SET @application_source_program_id := 'PBLN_000000000118979';

INSERT INTO application_preparation (
    demo_seed_key, owner_account_id, source_code, source_program_id, form_version_id, service_field, input_revision,
    progress_stage, progress_revision, progress_stage_updated_at, created_at, updated_at
)
SELECT
    'innovation-voucher-technical-v1', target.account_id,
    @application_source_code, @application_source_program_id, @application_form_version, 'TECHNICAL_SUPPORT', 1,
    'PREPARING', 1, DATE_SUB(@now, INTERVAL 8 DAY), DATE_SUB(@now, INTERVAL 8 DAY), DATE_SUB(@now, INTERVAL 8 DAY)
FROM demo_seed_target_account target
LEFT JOIN application_preparation existing
    ON existing.owner_account_id = target.account_id
   AND existing.demo_seed_key = 'innovation-voucher-technical-v1'
WHERE existing.id IS NULL;

INSERT INTO application_preparation (
    demo_seed_key, owner_account_id, source_code, source_program_id, form_version_id, service_field, input_revision,
    progress_stage, progress_revision, progress_stage_updated_at, created_at, updated_at
)
SELECT
    'innovation-voucher-marketing-v1', target.account_id,
    @application_source_code, @application_source_program_id, @application_form_version, 'MARKETING', 4,
    'DOCUMENT_REVIEW', 3, DATE_SUB(@now, INTERVAL 1 DAY), DATE_SUB(@now, INTERVAL 12 DAY), DATE_SUB(@now, INTERVAL 1 DAY)
FROM demo_seed_target_account target
LEFT JOIN application_preparation existing
    ON existing.owner_account_id = target.account_id
   AND existing.demo_seed_key = 'innovation-voucher-marketing-v1'
WHERE existing.id IS NULL;

DROP TEMPORARY TABLE IF EXISTS application_seed_fact_template;
CREATE TEMPORARY TABLE application_seed_fact_template (
    section_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    field_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    fact_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    value_text TEXT NULL,
    source_text TEXT NOT NULL,
    input_revision BIGINT NOT NULL,
    created_days_ago INT NOT NULL,
    updated_days_ago INT NOT NULL,
    PRIMARY KEY (section_key, field_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO application_seed_fact_template (
    section_key, field_key, fact_status, value_text, source_text, input_revision, created_days_ago, updated_days_ago
) VALUES
    ('company-overview', 'company-name', 'PROVIDED', '넥스트웨이브 주식회사', '사업자등록증의 공식 상호는 넥스트웨이브 주식회사입니다.', 2, 10, 10),
    ('company-overview', 'contact-person', 'UNKNOWN', NULL, '신청 업무 담당자는 아직 정하지 않았습니다.', 2, 10, 10),
    ('company-overview', 'company-history', 'UNKNOWN', NULL, '주요 연혁은 증빙 자료를 확인한 뒤 입력하기로 했습니다.', 2, 10, 10),
    ('company-overview', 'main-products', 'UNKNOWN', NULL, '주요 생산품의 공식 표기는 아직 확인하지 못했습니다.', 2, 10, 10),
    ('company-overview', 'main-customers', 'UNKNOWN', NULL, '주요 판매처는 공개 가능한 범위를 확인하고 있습니다.', 2, 10, 10),
    ('voucher-plan', 'project-title', 'PROVIDED', '소상공인 상권분석 서비스 브랜드 고도화 및 시장 확장', '이번 과제명은 소상공인 상권분석 서비스 브랜드 고도화 및 시장 확장입니다.', 3, 6, 6),
    ('voucher-plan', 'project-details', 'UNKNOWN', NULL, '세부 수행 활동은 수행기관과 협의한 뒤 확정하기로 했습니다.', 3, 6, 6),
    ('voucher-plan', 'execution-period', 'UNKNOWN', NULL, '협약 일정이 나오지 않아 수행 기간은 아직 미정입니다.', 3, 6, 6),
    ('voucher-plan', 'project-goal', 'UNKNOWN', NULL, '정량 목표는 현재 내부 검토 중입니다.', 3, 6, 6),
    ('voucher-necessity', 'business-relevance', 'UNKNOWN', NULL, '기업활동과의 관련성 문안은 아직 확정하지 않았습니다.', 4, 2, 2),
    ('voucher-necessity', 'support-necessity', 'PROVIDED', '내부에 브랜드 전략과 광고 성과 분석 전문 인력이 없어 외부 전문 수행기관의 진단과 실행 지원이 필요합니다.', '내부에는 브랜드 전략과 광고 성과 분석을 전담할 전문 인력이 없습니다.', 4, 2, 2);

INSERT INTO application_preparation_fact (
    preparation_id, section_key, field_key, fact_status, value_text, source_text, input_revision, created_at, updated_at
)
SELECT
    preparation.id, template.section_key, template.field_key, template.fact_status, template.value_text,
    template.source_text, template.input_revision,
    DATE_SUB(@now, INTERVAL template.created_days_ago DAY),
    DATE_SUB(@now, INTERVAL template.updated_days_ago DAY)
FROM demo_seed_target_account target
JOIN application_preparation preparation
    ON preparation.owner_account_id = target.account_id
   AND preparation.demo_seed_key = 'innovation-voucher-marketing-v1'
CROSS JOIN application_seed_fact_template template
LEFT JOIN application_preparation_fact existing
    ON existing.preparation_id = preparation.id
   AND existing.section_key = template.section_key
   AND existing.field_key = template.field_key
WHERE existing.id IS NULL;

SET @company_overview_facts := JSON_ARRAY(
    JSON_OBJECT('fieldKey', 'company-history', 'status', 'UNKNOWN', 'value', NULL),
    JSON_OBJECT('fieldKey', 'company-name', 'status', 'PROVIDED', 'value', '넥스트웨이브 주식회사'),
    JSON_OBJECT('fieldKey', 'contact-person', 'status', 'UNKNOWN', 'value', NULL),
    JSON_OBJECT('fieldKey', 'main-customers', 'status', 'UNKNOWN', 'value', NULL),
    JSON_OBJECT('fieldKey', 'main-products', 'status', 'UNKNOWN', 'value', NULL)
);
SET @voucher_plan_facts := JSON_ARRAY(
    JSON_OBJECT('fieldKey', 'execution-period', 'status', 'UNKNOWN', 'value', NULL),
    JSON_OBJECT('fieldKey', 'project-details', 'status', 'UNKNOWN', 'value', NULL),
    JSON_OBJECT('fieldKey', 'project-goal', 'status', 'UNKNOWN', 'value', NULL),
    JSON_OBJECT('fieldKey', 'project-title', 'status', 'PROVIDED', 'value', '소상공인 상권분석 서비스 브랜드 고도화 및 시장 확장')
);

INSERT INTO application_preparation_content (
    preparation_id, section_key, input_revision, content_kind, content_text, facts_json, run_id, created_at, confirmed_at
)
SELECT
    preparation.id, 'company-overview', 4, 'USER_EDIT',
    '신청 업체명은 넥스트웨이브 주식회사입니다. 담당자와 주요 연혁·생산품·판매처는 증빙과 공개 범위를 확인한 뒤 보완할 예정입니다.',
    @company_overview_facts, NULL, DATE_SUB(@now, INTERVAL 5 DAY), DATE_SUB(@now, INTERVAL 4 DAY)
FROM demo_seed_target_account target
JOIN application_preparation preparation
    ON preparation.owner_account_id = target.account_id
   AND preparation.demo_seed_key = 'innovation-voucher-marketing-v1'
LEFT JOIN application_preparation_content existing
    ON existing.preparation_id = preparation.id
   AND existing.section_key = 'company-overview'
   AND existing.input_revision = 4
   AND existing.content_kind = 'USER_EDIT'
WHERE existing.id IS NULL;

INSERT INTO application_preparation_content (
    preparation_id, section_key, input_revision, content_kind, content_text, facts_json, run_id, created_at, confirmed_at
)
SELECT
    preparation.id, 'voucher-plan', 4, 'USER_EDIT',
    '과제명은 소상공인 상권분석 서비스 브랜드 고도화 및 시장 확장입니다. 세부 활동과 일정, 정량 목표는 수행기관과 협의한 뒤 보완할 예정입니다.',
    @voucher_plan_facts, NULL, DATE_SUB(@now, INTERVAL 1 DAY), NULL
FROM demo_seed_target_account target
JOIN application_preparation preparation
    ON preparation.owner_account_id = target.account_id
   AND preparation.demo_seed_key = 'innovation-voucher-marketing-v1'
LEFT JOIN application_preparation_content existing
    ON existing.preparation_id = preparation.id
   AND existing.section_key = 'voucher-plan'
   AND existing.input_revision = 4
   AND existing.content_kind = 'USER_EDIT'
WHERE existing.id IS NULL;

SELECT target.email, COUNT(preparation.id) AS application_preparation_demo_count
FROM demo_seed_target_account target
LEFT JOIN application_preparation preparation
    ON preparation.owner_account_id = target.account_id
   AND preparation.demo_seed_key IS NOT NULL
GROUP BY target.account_id, target.email
ORDER BY target.email;

COMMIT;

DROP TEMPORARY TABLE IF EXISTS application_seed_fact_template;
DROP TEMPORARY TABLE IF EXISTS demo_seed_target_guard;
DROP TEMPORARY TABLE IF EXISTS demo_seed_target_account;
DROP TEMPORARY TABLE IF EXISTS demo_seed_requested_email;
DO RELEASE_LOCK('govbiz-personal-demo-seed-v1');
