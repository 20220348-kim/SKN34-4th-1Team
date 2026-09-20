CREATE TABLE support_program_sync_status (
    source_code VARCHAR(64) NOT NULL,
    published_generation BIGINT UNSIGNED NULL,
    published_catalog_fingerprint CHAR(64) NULL,
    published_program_count INT UNSIGNED NOT NULL DEFAULT 0,
    index_ready BOOLEAN NOT NULL DEFAULT FALSE,
    last_successful_sync_at DATETIME(6) NULL,
    last_failed_sync_at DATETIME(6) NULL,
    last_sync_outcome VARCHAR(16) NOT NULL DEFAULT 'NONE',
    PRIMARY KEY (source_code),
    CONSTRAINT chk_support_program_sync_status_outcome
        CHECK (last_sync_outcome IN ('NONE', 'SUCCESS', 'FAILURE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
