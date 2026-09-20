CREATE TABLE support_program_sync_generation (
    source_code VARCHAR(64) NOT NULL,
    latest_started_generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (source_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
