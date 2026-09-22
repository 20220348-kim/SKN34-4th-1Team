-- 비밀번호 재설정을 메일 링크 대신 6자리 인증번호로 바꿉니다.
-- 인증번호 해시·입력 시도 횟수·인증 시각과, 인증번호를 맞힌 뒤 새 비밀번호를 저장할 때 쓰는 통행 토큰 해시를 둡니다.
-- 인증번호는 같은 계정에 같은 번호가 다시 나올 수 있으므로 해시에 UNIQUE를 두지 않고, 통행 토큰 해시에만 둡니다.
ALTER TABLE account_password_reset
    DROP INDEX uq_account_password_reset_token,
    RENAME COLUMN token_hash TO code_hash,
    ADD COLUMN attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER expires_at,
    ADD COLUMN verified_at DATETIME(6) NULL AFTER attempt_count,
    ADD COLUMN pass_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER verified_at,
    ADD COLUMN pass_expires_at DATETIME(6) NULL AFTER pass_token_hash,
    ADD CONSTRAINT uq_account_password_reset_pass UNIQUE (pass_token_hash);
