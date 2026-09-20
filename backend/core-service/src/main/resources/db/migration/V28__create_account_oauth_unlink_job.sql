-- 탈퇴 transaction에 저장하는 카카오 연결 해제 작업. 원래 identity는 성공 확인 전까지 재가입 방지용으로 유지한다.
CREATE TABLE account_oauth_unlink_job (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_id BIGINT UNSIGNED NOT NULL,
    provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    subject VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
    failure_code VARCHAR(64) NULL,
    created_at DATETIME(6) NOT NULL,
    started_at DATETIME(6) NULL,
    finished_at DATETIME(6) NULL,
    next_publish_at DATETIME(6) NOT NULL,
    last_published_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    CONSTRAINT uq_account_oauth_unlink_identity UNIQUE (account_id, provider, subject),
    CONSTRAINT fk_account_oauth_unlink_account FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT chk_account_oauth_unlink_provider CHECK (provider = 'KAKAO'),
    CONSTRAINT chk_account_oauth_unlink_status CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
    INDEX idx_account_oauth_unlink_pending (status, next_publish_at, id),
    INDEX idx_account_oauth_unlink_running (status, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
