CREATE TABLE application_preparation_fact (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    preparation_id BIGINT UNSIGNED NOT NULL,
    section_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    field_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    fact_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    value_text TEXT COLLATE utf8mb4_0900_ai_ci NULL,
    source_text TEXT COLLATE utf8mb4_0900_ai_ci NOT NULL,
    input_revision BIGINT NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_application_preparation_fact_preparation
        FOREIGN KEY (preparation_id) REFERENCES application_preparation(id) ON DELETE CASCADE,
    CONSTRAINT uq_application_preparation_fact_field UNIQUE (preparation_id, section_key, field_key),
    CONSTRAINT chk_application_preparation_fact_section CHECK (section_key REGEXP '^[a-z][a-z0-9-]{0,63}$'),
    CONSTRAINT chk_application_preparation_fact_field CHECK (field_key REGEXP '^[a-z][a-z0-9-]{0,63}$'),
    CONSTRAINT chk_application_preparation_fact_status CHECK (fact_status IN ('PROVIDED', 'UNKNOWN')),
    CONSTRAINT chk_application_preparation_fact_value CHECK (
        (fact_status = 'PROVIDED' AND value_text IS NOT NULL AND CHAR_LENGTH(TRIM(value_text)) > 0)
        OR (fact_status = 'UNKNOWN' AND value_text IS NULL)
    ),
    CONSTRAINT chk_application_preparation_fact_source CHECK (CHAR_LENGTH(TRIM(source_text)) > 0),
    CONSTRAINT chk_application_preparation_fact_revision CHECK (input_revision > 0),
    INDEX idx_application_preparation_fact_preparation (preparation_id, section_key, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE application_preparation_interpretation_run (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    preparation_id BIGINT UNSIGNED NOT NULL,
    section_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    input_revision BIGINT NOT NULL,
    request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    run_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'RUNNING',
    input_json JSON NOT NULL,
    output_json JSON NULL,
    failure_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    started_at DATETIME(6) NOT NULL,
    finished_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_application_preparation_interpretation_preparation
        FOREIGN KEY (preparation_id) REFERENCES application_preparation(id) ON DELETE CASCADE,
    CONSTRAINT uq_application_preparation_interpretation_request UNIQUE (preparation_id, request_key),
    CONSTRAINT chk_application_preparation_interpretation_section CHECK (section_key REGEXP '^[a-z][a-z0-9-]{0,63}$'),
    CONSTRAINT chk_application_preparation_interpretation_revision CHECK (input_revision > 0),
    CONSTRAINT chk_application_preparation_interpretation_request_key CHECK (
        request_key REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
    CONSTRAINT chk_application_preparation_interpretation_hash CHECK (request_hash REGEXP '^[0-9a-f]{64}$'),
    CONSTRAINT chk_application_preparation_interpretation_status CHECK (run_status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
    CONSTRAINT chk_application_preparation_interpretation_json CHECK (
        JSON_VALID(input_json) AND (output_json IS NULL OR JSON_VALID(output_json))
    ),
    INDEX idx_application_preparation_interpretation_preparation (preparation_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
