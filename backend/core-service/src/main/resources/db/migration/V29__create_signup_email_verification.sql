-- 회원가입 이메일 인증번호입니다. 계정이 아직 없으므로 이메일 기준으로 저장하고, 인증번호와 가입 통행 토큰은 SHA-256 해시만 둡니다.
-- 인증번호가 맞으면 verified_at과 통행 토큰을 기록하고, 가입이 그 토큰을 쓰면 consumed_at을 채웁니다.
CREATE TABLE signup_email_verification (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    email VARCHAR(320) NOT NULL,
    code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
    verified_at DATETIME(6) NULL,
    pass_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    pass_expires_at DATETIME(6) NULL,
    consumed_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    CONSTRAINT uq_signup_email_verification_pass UNIQUE (pass_token_hash),
    INDEX idx_signup_email_verification_email_created (email, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
