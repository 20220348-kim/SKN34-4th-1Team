-- 이메일 동의와 별개인 앱 기기 수신 설정. 세션 삭제/만료 후에는 발송하지 않는다.
CREATE TABLE daily_report_push_device (
    device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    account_id BIGINT UNSIGNED NOT NULL,
    session_id BIGINT UNSIGNED NULL,
    expo_token VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (device_id),
    UNIQUE KEY uq_daily_report_push_token (expo_token),
    CONSTRAINT fk_daily_report_push_account FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE,
    CONSTRAINT fk_daily_report_push_session FOREIGN KEY (session_id) REFERENCES account_session(id) ON DELETE SET NULL,
    INDEX idx_daily_report_push_account (account_id, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 리포트와 기기별 한 번만 예약한다. 결과 불명은 자동 재전송하지 않는다.
CREATE TABLE daily_report_push_delivery (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    report_id BIGINT UNSIGNED NOT NULL,
    device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    session_id BIGINT UNSIGNED NOT NULL,
    expo_token VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING',
    ticket_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
    error_code VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at DATETIME(6) NOT NULL,
    started_at DATETIME(6) NULL,
    receipt_due_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_daily_report_push_once (report_id, device_id),
    CONSTRAINT fk_daily_report_push_report FOREIGN KEY (report_id) REFERENCES daily_report(id) ON DELETE CASCADE,
    CONSTRAINT fk_daily_report_push_device FOREIGN KEY (device_id) REFERENCES daily_report_push_device(device_id) ON DELETE CASCADE,
    CONSTRAINT chk_daily_report_push_status CHECK (status IN ('PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'FAILED', 'UNKNOWN', 'SKIPPED')),
    INDEX idx_daily_report_push_status (status, receipt_due_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
