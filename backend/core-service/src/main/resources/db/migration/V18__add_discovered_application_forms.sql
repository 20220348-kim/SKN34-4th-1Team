CREATE TABLE application_form_snapshot (
    form_version_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_code VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
    source_program_id VARCHAR(255) COLLATE utf8mb4_0900_bin NOT NULL,
    source_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    attachment_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    manifest_json JSON NOT NULL,
    parser_version VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    extraction_model VARCHAR(200) NOT NULL,
    extraction_prompt_version VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (form_version_id),
    CONSTRAINT uq_application_form_snapshot_source
        UNIQUE (source_code, source_program_id, source_fingerprint, attachment_sha256, parser_version, extraction_model, extraction_prompt_version),
    CONSTRAINT chk_application_form_snapshot_source
        CHECK (CHAR_LENGTH(TRIM(source_code)) > 0 AND CHAR_LENGTH(TRIM(source_program_id)) > 0),
    CONSTRAINT chk_application_form_snapshot_hash
        CHECK (source_fingerprint REGEXP '^[0-9a-f]{64}$' AND attachment_sha256 REGEXP '^[0-9a-f]{64}$'),
    CONSTRAINT chk_application_form_snapshot_manifest CHECK (JSON_TYPE(manifest_json) = 'OBJECT'),
    CONSTRAINT chk_application_form_snapshot_prompt
        CHECK (extraction_prompt_version REGEXP '^sha256:[0-9a-f]{64}$'),
    INDEX idx_application_form_snapshot_program (source_code, source_program_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE application_preparation
    DROP CHECK chk_application_preparation_service_field,
    ADD CONSTRAINT chk_application_preparation_service_field
        CHECK (service_field IN ('GENERAL', 'CONSULTING', 'TECHNICAL_SUPPORT', 'MARKETING'));
