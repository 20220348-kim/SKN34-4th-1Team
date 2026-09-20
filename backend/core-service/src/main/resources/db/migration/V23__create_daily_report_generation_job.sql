-- 정기 리포트 생성 작업과 발행 대기 기록(Outbox)을 같은 행에서 관리한다.
CREATE TABLE daily_report_generation_job (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    report_id BIGINT UNSIGNED NOT NULL,
    generation_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'QUEUED',
    created_at DATETIME(6) NOT NULL,
    deadline_at DATETIME(6) NOT NULL,
    started_at DATETIME(6) NULL,
    finished_at DATETIME(6) NULL,
    next_publish_at DATETIME(6) NOT NULL,
    last_published_at DATETIME(6) NULL,
    publish_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    CONSTRAINT fk_daily_report_job_report FOREIGN KEY (report_id) REFERENCES daily_report(id) ON DELETE CASCADE,
    CONSTRAINT uq_daily_report_job_generation UNIQUE (report_id, generation_key),
    CONSTRAINT chk_daily_report_job_state CHECK (
        (status = 'QUEUED' AND started_at IS NULL AND finished_at IS NULL)
        OR (status = 'RUNNING' AND started_at IS NOT NULL AND finished_at IS NULL)
        OR (status IN ('SUCCEEDED', 'FAILED', 'SKIPPED', 'UNKNOWN') AND finished_at IS NOT NULL)
    ),
    CONSTRAINT chk_daily_report_job_deadline CHECK (deadline_at > created_at),
    INDEX idx_daily_report_job_publish (status, next_publish_at, id),
    INDEX idx_daily_report_job_expiry (status, deadline_at, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
