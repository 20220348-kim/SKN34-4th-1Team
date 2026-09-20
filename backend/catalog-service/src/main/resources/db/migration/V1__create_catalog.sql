-- 독립 카탈로그 DB 전용 초기 스키마. Core DB 또는 기존 Flyway 이력에 적용하지 않습니다.
CREATE TABLE catalog_instance (
    singleton_id TINYINT NOT NULL,
    catalog_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (singleton_id),
    CONSTRAINT chk_catalog_singleton CHECK (singleton_id = 1),
    CONSTRAINT uq_catalog_instance_id UNIQUE (catalog_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO catalog_instance (singleton_id, catalog_id) VALUES (1, UUID());

CREATE TABLE catalog_source_revision (
    source_code VARCHAR(64) NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (source_code),
    CONSTRAINT chk_catalog_source CHECK (source_code IN ('BIZINFO', 'KSTARTUP', 'MSIT', 'CNTRADE_NOTICE')),
    CONSTRAINT chk_catalog_revision CHECK (revision >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO catalog_source_revision (source_code) VALUES ('BIZINFO'), ('KSTARTUP'), ('MSIT'), ('CNTRADE_NOTICE');

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
    startup_details JSON NULL,
    is_source_present BOOLEAN NOT NULL DEFAULT TRUE,
    first_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    CONSTRAINT uq_support_program_source_identity UNIQUE (source_code, source_program_id),
    CONSTRAINT fk_support_program_source FOREIGN KEY (source_code) REFERENCES catalog_source_revision (source_code),
    INDEX idx_support_program_present_end_date (is_source_present, application_end_date),
    CONSTRAINT chk_support_program_startup_details CHECK (
        startup_details IS NULL OR (
            source_code = 'KSTARTUP'
            AND JSON_TYPE(startup_details) = 'OBJECT'
            AND JSON_CONTAINS_PATH(startup_details, 'all', '$.startupStages', '$.applicantTypes', '$.founderAges')
            AND JSON_TYPE(JSON_EXTRACT(startup_details, '$.startupStages')) = 'ARRAY'
            AND JSON_TYPE(JSON_EXTRACT(startup_details, '$.applicantTypes')) = 'ARRAY'
            AND JSON_TYPE(JSON_EXTRACT(startup_details, '$.founderAges')) = 'ARRAY'
        )
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE support_program_sync_generation (
    source_code VARCHAR(64) NOT NULL,
    latest_started_generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (source_code),
    CONSTRAINT fk_sync_generation_source FOREIGN KEY (source_code) REFERENCES catalog_source_revision (source_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

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
    CONSTRAINT fk_sync_status_source FOREIGN KEY (source_code) REFERENCES catalog_source_revision (source_code),
    CONSTRAINT chk_support_program_sync_status_outcome CHECK (last_sync_outcome IN ('NONE', 'SUCCESS', 'FAILURE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
