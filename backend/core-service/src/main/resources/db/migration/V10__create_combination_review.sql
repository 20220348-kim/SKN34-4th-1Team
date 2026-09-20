CREATE TABLE combination_review (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    owner_account_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(200) NOT NULL,
    input_revision BIGINT NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_combination_review_owner FOREIGN KEY (owner_account_id) REFERENCES account(id) ON DELETE CASCADE,
    CONSTRAINT chk_combination_review_revision CHECK (input_revision > 0),
    CONSTRAINT chk_combination_review_title CHECK (CHAR_LENGTH(TRIM(title)) > 0),
    INDEX idx_combination_review_owner_id (owner_account_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE combination_review_program (
    review_id BIGINT UNSIGNED NOT NULL,
    position TINYINT UNSIGNED NOT NULL,
    source_code VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
    source_program_id VARCHAR(255) COLLATE utf8mb4_0900_bin NOT NULL,
    sub_program_id VARCHAR(255) COLLATE utf8mb4_0900_bin NULL,
    -- NULL인 세부사업도 고유성 검사에 포함한다. 빈 문자열은 실제 세부사업 ID로 허용하지 않는다.
    sub_program_key VARCHAR(255) COLLATE utf8mb4_0900_bin GENERATED ALWAYS AS (COALESCE(sub_program_id, '')) STORED,
    application_submitted VARCHAR(7) COLLATE utf8mb4_0900_bin NOT NULL,
    selected VARCHAR(7) COLLATE utf8mb4_0900_bin NOT NULL,
    commitment_submitted VARCHAR(7) COLLATE utf8mb4_0900_bin NOT NULL,
    agreement_signed VARCHAR(7) COLLATE utf8mb4_0900_bin NOT NULL,
    execution_status VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL,
    funding_received VARCHAR(7) COLLATE utf8mb4_0900_bin NOT NULL,
    PRIMARY KEY (review_id, position),
    CONSTRAINT fk_combination_review_program_review FOREIGN KEY (review_id) REFERENCES combination_review(id) ON DELETE CASCADE,
    CONSTRAINT uq_combination_review_program_identity UNIQUE (review_id, source_code, source_program_id, sub_program_key),
    CONSTRAINT chk_combination_review_position CHECK (position BETWEEN 0 AND 2),
    CONSTRAINT chk_combination_review_source CHECK (CHAR_LENGTH(TRIM(source_code)) > 0 AND CHAR_LENGTH(TRIM(source_program_id)) > 0),
    CONSTRAINT chk_combination_review_sub_program CHECK (sub_program_id IS NULL OR CHAR_LENGTH(TRIM(sub_program_id)) > 0),
    CONSTRAINT chk_combination_review_application CHECK (application_submitted IN ('UNKNOWN', 'YES', 'NO')),
    CONSTRAINT chk_combination_review_selection CHECK (selected IN ('UNKNOWN', 'YES', 'NO')),
    CONSTRAINT chk_combination_review_commitment CHECK (commitment_submitted IN ('UNKNOWN', 'YES', 'NO')),
    CONSTRAINT chk_combination_review_agreement CHECK (agreement_signed IN ('UNKNOWN', 'YES', 'NO')),
    CONSTRAINT chk_combination_review_execution CHECK (execution_status IN ('UNKNOWN', 'NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'STOPPED')),
    CONSTRAINT chk_combination_review_funding CHECK (funding_received IN ('UNKNOWN', 'YES', 'NO'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
