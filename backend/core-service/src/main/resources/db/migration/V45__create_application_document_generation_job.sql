-- 신청 문서 생성을 동기 요청 대신 계정별 작업으로 실행한다. 준비 건마다 진행 중인 작업은 하나만 둔다.
CREATE TABLE application_document_generation_job (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    owner_account_id BIGINT UNSIGNED NOT NULL,
    preparation_id BIGINT UNSIGNED NOT NULL,
    request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expected_revision BIGINT UNSIGNED NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'QUEUED',
    stage VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
    active_slot TINYINT GENERATED ALWAYS AS (CASE WHEN status IN ('QUEUED', 'RUNNING', 'UNKNOWN') THEN 1 ELSE NULL END) STORED,
    result_json JSON NULL,
    failure_code VARCHAR(64) NULL,
    failure_message VARCHAR(500) NULL,
    failure_detail_json JSON NULL,
    created_at DATETIME(6) NOT NULL,
    started_at DATETIME(6) NULL,
    ai_started_at DATETIME(6) NULL,
    finished_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_document_generation_owner FOREIGN KEY (owner_account_id) REFERENCES account(id),
    CONSTRAINT fk_document_generation_preparation FOREIGN KEY (preparation_id) REFERENCES application_preparation(id) ON DELETE CASCADE,
    CONSTRAINT uq_document_generation_request UNIQUE (owner_account_id, request_key),
    CONSTRAINT uq_document_generation_active UNIQUE (preparation_id, active_slot),
    CONSTRAINT chk_document_generation_status CHECK (
        (status = 'QUEUED' AND started_at IS NULL AND finished_at IS NULL)
        OR (status = 'RUNNING' AND started_at IS NOT NULL AND finished_at IS NULL)
        OR (status IN ('SUCCEEDED', 'FAILED', 'UNKNOWN') AND finished_at IS NOT NULL)
    ),
    CONSTRAINT chk_document_generation_result CHECK (
        (status = 'SUCCEEDED' AND result_json IS NOT NULL AND failure_code IS NULL)
        OR (status <> 'SUCCEEDED' AND result_json IS NULL)
    ),
    INDEX idx_document_generation_owner (owner_account_id, id),
    INDEX idx_document_generation_preparation (preparation_id, id),
    INDEX idx_document_generation_pending (status, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
