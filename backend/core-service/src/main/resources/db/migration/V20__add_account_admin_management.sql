-- 관리자 계정 관리 화면이 쓰는 최근 로그인 시각입니다. 세션은 로그아웃하면 지워지므로 계정 행에 따로 남깁니다.
ALTER TABLE account
    ADD COLUMN last_login_at DATETIME(6) NULL AFTER created_at;

-- 관리자가 계정에 한 조치(정지·정지 해제·강제 로그아웃)와 사유입니다. 계정 행은 삭제해도 남으므로 기록도 함께 남습니다.
CREATE TABLE account_admin_action (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    target_account_id BIGINT UNSIGNED NOT NULL,
    admin_account_id BIGINT UNSIGNED NOT NULL,
    action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    reason VARCHAR(500) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_account_admin_action_target
        FOREIGN KEY (target_account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT fk_account_admin_action_admin
        FOREIGN KEY (admin_account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT chk_account_admin_action_action CHECK (action IN ('SUSPEND', 'UNSUSPEND', 'SESSIONS_REVOKE')),
    CONSTRAINT chk_account_admin_action_reason CHECK (CHAR_LENGTH(TRIM(reason)) BETWEEN 1 AND 500),
    INDEX idx_account_admin_action_target (target_account_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 이메일 익명화가 생기기 전에 삭제된 계정은 원래 이메일을 쥐고 있어 같은 이메일로 다시 가입하거나 개발용 시드 계정을
-- 만들 수 없었습니다. 삭제 표시된 행만 계정 ID로 겹치지 않는 주소로 바꿉니다.
UPDATE account
   SET email = CONCAT('deleted+', id, '+legacy@deleted.invalid')
 WHERE deleted_at IS NOT NULL
   AND email NOT LIKE 'deleted+%@deleted.invalid';
