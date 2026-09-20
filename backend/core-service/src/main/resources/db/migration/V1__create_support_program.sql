CREATE TABLE support_program (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    source_code VARCHAR(64) NOT NULL,
    source_program_id VARCHAR(255) NOT NULL,
    title VARCHAR(500) NOT NULL,
    organization VARCHAR(255) NOT NULL,
    summary TEXT NOT NULL,
    categories JSON NOT NULL,
    regions JSON NOT NULL,
    target_description TEXT NOT NULL,
    application_period_raw TEXT NOT NULL,
    application_start_date DATE NULL,
    application_end_date DATE NULL,
    source_url VARCHAR(2048) NOT NULL,
    source_sort_timestamp VARCHAR(64) NULL,
    content_hash CHAR(64) NULL,
    is_source_present BOOLEAN NOT NULL DEFAULT TRUE,
    first_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    CONSTRAINT uq_support_program_source_identity
        UNIQUE (source_code, source_program_id),
    INDEX idx_support_program_present_end_date
        (is_source_present, application_end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
