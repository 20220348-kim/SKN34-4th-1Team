CREATE TABLE application_preparation_draft_run (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    preparation_id BIGINT UNSIGNED NOT NULL,
    section_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    input_revision BIGINT NOT NULL,
    expected_version_id BIGINT UNSIGNED NULL,
    request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    run_status VARCHAR(16) NOT NULL,
    input_json JSON NOT NULL,
    output_json JSON NULL,
    applied BOOLEAN NOT NULL DEFAULT FALSE,
    started_at DATETIME(6) NOT NULL,
    finished_at DATETIME(6) NULL,
    CONSTRAINT uk_application_draft_request UNIQUE (preparation_id, request_key),
    CONSTRAINT fk_application_draft_run_preparation FOREIGN KEY (preparation_id) REFERENCES application_preparation(id) ON DELETE CASCADE,
    CONSTRAINT ck_application_draft_run_status CHECK (run_status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
    CONSTRAINT ck_application_draft_run_revision CHECK (input_revision > 0)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE application_preparation_content (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    preparation_id BIGINT UNSIGNED NOT NULL,
    section_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    input_revision BIGINT NOT NULL,
    content_kind VARCHAR(16) NOT NULL,
    content_text MEDIUMTEXT NOT NULL,
    facts_json JSON NOT NULL,
    run_id BIGINT UNSIGNED NULL,
    created_at DATETIME(6) NOT NULL,
    confirmed_at DATETIME(6) NULL,
    INDEX ix_application_content_section (preparation_id, section_key, id),
    CONSTRAINT fk_application_content_preparation FOREIGN KEY (preparation_id) REFERENCES application_preparation(id) ON DELETE CASCADE,
    CONSTRAINT fk_application_content_run FOREIGN KEY (run_id) REFERENCES application_preparation_draft_run(id) ON DELETE CASCADE,
    CONSTRAINT ck_application_content_kind CHECK (content_kind IN ('AI_DRAFT', 'USER_EDIT')),
    CONSTRAINT ck_application_content_revision CHECK (input_revision > 0),
    CONSTRAINT ck_application_content_length CHECK (CHAR_LENGTH(content_text) BETWEEN 1 AND 15000)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
