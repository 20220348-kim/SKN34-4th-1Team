-- 공식 문서 분석의 실행 상태와 발행 대기(Outbox)를 함께 보관한다.
CREATE TABLE application_form_discovery_job (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    owner_account_id BIGINT UNSIGNED NOT NULL,
    request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_code VARCHAR(64) NOT NULL,
    source_program_id VARCHAR(255) NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'QUEUED',
    active_slot TINYINT GENERATED ALWAYS AS (CASE WHEN status IN ('QUEUED', 'RUNNING', 'UNKNOWN') THEN 1 ELSE NULL END) STORED,
    result_json JSON NULL,
    failure_code VARCHAR(64) NULL,
    ai_started_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    started_at DATETIME(6) NULL,
    finished_at DATETIME(6) NULL,
    next_publish_at DATETIME(6) NOT NULL,
    last_published_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_form_discovery_owner FOREIGN KEY (owner_account_id) REFERENCES account(id),
    CONSTRAINT uq_form_discovery_request UNIQUE (owner_account_id, request_key),
    CONSTRAINT uq_form_discovery_active UNIQUE (source_code, source_program_id, active_slot),
    CONSTRAINT chk_form_discovery_status CHECK (
        (status = 'QUEUED' AND started_at IS NULL AND finished_at IS NULL)
        OR (status = 'RUNNING' AND started_at IS NOT NULL AND finished_at IS NULL)
        OR (status IN ('SUCCEEDED', 'FAILED', 'UNKNOWN') AND finished_at IS NOT NULL)
    ),
    CONSTRAINT chk_form_discovery_result CHECK (
        (status = 'SUCCEEDED' AND result_json IS NOT NULL AND failure_code IS NULL)
        OR (status <> 'SUCCEEDED' AND result_json IS NULL)
    ),
    INDEX idx_form_discovery_owner (owner_account_id, id),
    INDEX idx_form_discovery_publish (status, next_publish_at, id),
    INDEX idx_form_discovery_expiry (status, created_at, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
