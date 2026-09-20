-- 소셜 로그인(카카오·Google)으로만 가입한 계정은 비밀번호가 없습니다. 이메일 로그인은 해시가 있는 계정만 됩니다.
ALTER TABLE account MODIFY password_hash VARCHAR(100) NULL;

-- 공급자 계정(OpenID Connect sub)과 계정의 연결입니다. 공급자 이메일은 바뀔 수 있어 식별자로 쓰지 않습니다.
-- (provider, subject)는 한 공급자 계정이 두 계정에 붙는 것을, (account_id, provider)는 한 계정이 같은 공급자를
-- 두 번 연결하는 것을 막습니다.
CREATE TABLE account_oauth_identity (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_id BIGINT UNSIGNED NOT NULL,
    provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    subject VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    linked_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT uq_account_oauth_identity_subject UNIQUE (provider, subject),
    CONSTRAINT uq_account_oauth_identity_account_provider UNIQUE (account_id, provider),
    CONSTRAINT fk_account_oauth_identity_account
        FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT chk_account_oauth_identity_provider CHECK (provider IN ('KAKAO', 'GOOGLE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
