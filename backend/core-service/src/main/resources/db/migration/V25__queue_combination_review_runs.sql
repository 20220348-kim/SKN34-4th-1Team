-- 기존 실행·원문은 보존한다. 실행 행 자체가 미발행 작업을 보관하는 Outbox다.
ALTER TABLE combination_review_run
    ADD COLUMN queue_expires_at DATETIME(6) NULL,
    ADD COLUMN execution_started_at DATETIME(6) NULL,
    ADD COLUMN next_publish_at DATETIME(6) NULL,
    ADD COLUMN last_published_at DATETIME(6) NULL,
    DROP CHECK chk_combination_run_state,
    MODIFY COLUMN running_slot TINYINT GENERATED ALWAYS AS
        (CASE WHEN status IN ('QUEUED', 'RUNNING', 'UNKNOWN') THEN 1 ELSE NULL END) STORED,
    ADD CONSTRAINT chk_combination_run_state CHECK (
        (status IN ('QUEUED', 'RUNNING') AND finished_at IS NULL AND analysis_json IS NULL AND failure_code IS NULL)
        OR (status = 'SUCCEEDED' AND finished_at IS NOT NULL AND evidence_json IS NOT NULL AND configuration_json IS NOT NULL AND analysis_json IS NOT NULL AND failure_code IS NULL)
        OR (status IN ('FAILED', 'INTERRUPTED', 'UNKNOWN') AND finished_at IS NOT NULL AND analysis_json IS NULL AND failure_code IS NOT NULL)
    ),
    ADD INDEX idx_combination_run_outbox (status, next_publish_at, id),
    ADD INDEX idx_combination_run_expiry (status, queue_expires_at);
