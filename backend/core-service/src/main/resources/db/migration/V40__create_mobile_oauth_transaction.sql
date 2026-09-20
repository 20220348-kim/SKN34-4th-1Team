CREATE TABLE mobile_oauth_transaction (
    state_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    redirect_uri VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
    app_state VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    code_challenge CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    remember_me BOOLEAN NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    callback_claimed_at DATETIME(6) NULL,
    code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    code_expires_at DATETIME(6) NULL,
    account_id BIGINT UNSIGNED NULL,
    consumed_at DATETIME(6) NULL,
    CONSTRAINT uq_mobile_oauth_code UNIQUE (code_hash),
    CONSTRAINT fk_mobile_oauth_account FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE,
    INDEX idx_mobile_oauth_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
