CREATE TABLE combination_review_run (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    review_id BIGINT UNSIGNED NOT NULL,
    input_revision BIGINT NOT NULL,
    request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    input_json JSON NOT NULL,
    evidence_json JSON NULL,
    configuration_json JSON NULL,
    analysis_json JSON NULL,
    failure_code VARCHAR(64) NULL,
    runner_instance_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    started_at DATETIME(6) NOT NULL,
    finished_at DATETIME(6) NULL,
    running_slot TINYINT GENERATED ALWAYS AS (CASE WHEN status = 'RUNNING' THEN 1 ELSE NULL END) STORED,
    PRIMARY KEY (id),
    CONSTRAINT fk_combination_run_review FOREIGN KEY (review_id) REFERENCES combination_review(id) ON DELETE CASCADE,
    CONSTRAINT uq_combination_run_request UNIQUE (review_id, request_key),
    CONSTRAINT uq_combination_run_active UNIQUE (review_id, running_slot),
    CONSTRAINT chk_combination_run_revision CHECK (input_revision > 0),
    CONSTRAINT chk_combination_run_state CHECK (
        (status = 'RUNNING' AND finished_at IS NULL AND analysis_json IS NULL AND failure_code IS NULL)
        OR (status = 'SUCCEEDED' AND finished_at IS NOT NULL AND evidence_json IS NOT NULL AND configuration_json IS NOT NULL AND analysis_json IS NOT NULL AND failure_code IS NULL)
        OR (status IN ('FAILED', 'INTERRUPTED') AND finished_at IS NOT NULL AND analysis_json IS NULL AND failure_code IS NOT NULL)
    ),
    INDEX idx_combination_run_review_id (review_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE combination_review_run_source (
    run_id BIGINT UNSIGNED NOT NULL,
    document_index INT NOT NULL,
    raw_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    raw_bytes MEDIUMBLOB NOT NULL,
    PRIMARY KEY (run_id, document_index),
    CONSTRAINT fk_combination_run_source FOREIGN KEY (run_id) REFERENCES combination_review_run(id) ON DELETE CASCADE,
    CONSTRAINT chk_combination_source_index CHECK (document_index >= 0 AND document_index < 12)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
