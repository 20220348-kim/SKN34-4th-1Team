CREATE TABLE daily_report_subscription (
    account_id BIGINT UNSIGNED NOT NULL,
    support_purpose VARCHAR(100) NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_email VARCHAR(320) NULL,
    confirmed_at DATETIME(6) NULL,
    consent_at DATETIME(6) NULL,
    verification_email VARCHAR(320) NULL,
    verification_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    verification_expires_at DATETIME(6) NULL,
    verification_requested_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (account_id),
    CONSTRAINT fk_daily_report_subscription_account FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE,
    CONSTRAINT uq_daily_report_verification_token UNIQUE (verification_token_hash),
    CONSTRAINT chk_daily_report_subscription_consent CHECK (enabled = FALSE OR (confirmed_email IS NOT NULL AND confirmed_at IS NOT NULL AND consent_at IS NOT NULL)),
    INDEX idx_daily_report_subscription_enabled (enabled, account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE daily_report (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_id BIGINT UNSIGNED NOT NULL,
    report_date DATE NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    delivery_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'NOT_REQUESTED',
    input_json JSON NOT NULL,
    content_json JSON NULL,
    error_message VARCHAR(300) NULL,
    generation_attempts INT NOT NULL DEFAULT 1,
    generation_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    started_at DATETIME(6) NOT NULL,
    generated_at DATETIME(6) NULL,
    delivery_started_at DATETIME(6) NULL,
    delivered_at DATETIME(6) NULL,
    unsubscribe_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_daily_report_account FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE,
    CONSTRAINT uq_daily_report_account_date UNIQUE (account_id, report_date),
    CONSTRAINT uq_daily_report_unsubscribe_token UNIQUE (unsubscribe_token_hash),
    CONSTRAINT chk_daily_report_attempts CHECK (generation_attempts BETWEEN 1 AND 2),
    CONSTRAINT chk_daily_report_state CHECK (
        (status = 'GENERATING' AND content_json IS NULL AND generated_at IS NULL AND error_message IS NULL)
        OR (status = 'READY' AND content_json IS NOT NULL AND generated_at IS NOT NULL AND error_message IS NULL)
        OR (status = 'FAILED' AND content_json IS NULL AND error_message IS NOT NULL)
    ),
    CONSTRAINT chk_daily_report_delivery_state CHECK (delivery_status IN ('NOT_REQUESTED', 'SENDING', 'SENT', 'UNKNOWN', 'SKIPPED')),
    INDEX idx_daily_report_date (report_date, account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 날짜별 생성 시도 예산을 여러 서버에서 함께 사용한다. 재시도도 한 번으로 계산한다.
CREATE TABLE daily_report_generation_budget (
    report_date DATE NOT NULL,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (report_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
