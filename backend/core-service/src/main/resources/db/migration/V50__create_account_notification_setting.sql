-- 계정별 알림 설정입니다. 실제로 보내는 알림은 관심 공고 마감 알림뿐이며 기본은 꺼져 있습니다.
-- 이메일은 맞춤 리포트의 수신 주소 확인을 마친 계정에만, 앱 알림은 앱 알림을 켠 기기에만 보냅니다.
-- email_consented_at은 마감 알림 이메일을 처음 선택한 시각이며, 이메일 선택을 끄면 비웁니다.
CREATE TABLE account_notification_setting (
    account_id BIGINT UNSIGNED NOT NULL,
    deadline_reminder_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    deadline_reminder_days_before TINYINT UNSIGNED NOT NULL DEFAULT 3,
    deadline_reminder_email BOOLEAN NOT NULL DEFAULT FALSE,
    deadline_reminder_push BOOLEAN NOT NULL DEFAULT FALSE,
    email_consented_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (account_id),
    CONSTRAINT fk_account_notification_setting_account
        FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT chk_account_notification_deadline_days CHECK (deadline_reminder_days_before BETWEEN 1 AND 7),
    CONSTRAINT chk_account_notification_deadline_channel
        CHECK (deadline_reminder_enabled = FALSE OR deadline_reminder_email = TRUE OR deadline_reminder_push = TRUE),
    CONSTRAINT chk_account_notification_email_consent
        CHECK (deadline_reminder_email = FALSE OR email_consented_at IS NOT NULL),
    INDEX idx_account_notification_deadline (deadline_reminder_enabled, account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 마감 알림 발송 기록입니다. 같은 계정·공고·종류·마감일(due_date)의 알림은 한 번만 예약하며,
-- 채널별 상태는 NOT_REQUESTED(선택 안 함) → PENDING → SENDING → SENT/FAILED/UNKNOWN/SKIPPED로만 바뀝니다.
-- 결과를 확인하지 못한 UNKNOWN은 자동으로 다시 보내지 않습니다. 오류 칸에는 안정적인 코드만 남깁니다.
CREATE TABLE deadline_reminder (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_id BIGINT UNSIGNED NOT NULL,
    source_code VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
    source_program_id VARCHAR(255) COLLATE utf8mb4_0900_bin NOT NULL,
    kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    due_date DATE NOT NULL,
    days_before TINYINT UNSIGNED NOT NULL,
    email_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    email_error VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
    email_started_at DATETIME(6) NULL,
    email_finished_at DATETIME(6) NULL,
    push_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    push_error VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
    push_started_at DATETIME(6) NULL,
    push_finished_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT uq_deadline_reminder_once UNIQUE (account_id, source_code, source_program_id, kind, due_date),
    CONSTRAINT fk_deadline_reminder_account FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT chk_deadline_reminder_source
        CHECK (CHAR_LENGTH(TRIM(source_code)) > 0 AND CHAR_LENGTH(TRIM(source_program_id)) > 0),
    CONSTRAINT chk_deadline_reminder_kind CHECK (kind IN ('DEADLINE')),
    CONSTRAINT chk_deadline_reminder_days CHECK (days_before BETWEEN 1 AND 7),
    CONSTRAINT chk_deadline_reminder_email_status
        CHECK (email_status IN ('NOT_REQUESTED', 'PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'SKIPPED')),
    CONSTRAINT chk_deadline_reminder_push_status
        CHECK (push_status IN ('NOT_REQUESTED', 'PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'SKIPPED')),
    INDEX idx_deadline_reminder_email (email_status, created_at),
    INDEX idx_deadline_reminder_push (push_status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
