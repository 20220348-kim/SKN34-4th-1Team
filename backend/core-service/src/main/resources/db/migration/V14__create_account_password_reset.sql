-- 비밀번호 재설정 링크의 일회용 토큰입니다. 토큰 원문은 메일로만 보내고 SHA-256 해시만 저장합니다.
CREATE TABLE account_password_reset (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_id BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    used_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    CONSTRAINT uq_account_password_reset_token UNIQUE (token_hash),
    CONSTRAINT fk_account_password_reset_account
        FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE,
    INDEX idx_account_password_reset_account_created (account_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
