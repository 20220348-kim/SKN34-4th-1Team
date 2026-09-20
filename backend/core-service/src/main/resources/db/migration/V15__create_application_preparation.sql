CREATE TABLE application_preparation (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    owner_account_id BIGINT UNSIGNED NOT NULL,
    source_code VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
    source_program_id VARCHAR(255) COLLATE utf8mb4_0900_bin NOT NULL,
    form_version_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    service_field VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    input_revision BIGINT NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_application_preparation_owner
        FOREIGN KEY (owner_account_id) REFERENCES account(id) ON DELETE CASCADE,
    CONSTRAINT chk_application_preparation_source
        CHECK (CHAR_LENGTH(TRIM(source_code)) > 0 AND CHAR_LENGTH(TRIM(source_program_id)) > 0),
    CONSTRAINT chk_application_preparation_form_version
        CHECK (form_version_id REGEXP '^[a-z0-9][a-z0-9-]{0,159}$'),
    CONSTRAINT chk_application_preparation_service_field
        CHECK (service_field IN ('CONSULTING', 'TECHNICAL_SUPPORT', 'MARKETING')),
    CONSTRAINT chk_application_preparation_revision CHECK (input_revision > 0),
    INDEX idx_application_preparation_owner_id (owner_account_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
