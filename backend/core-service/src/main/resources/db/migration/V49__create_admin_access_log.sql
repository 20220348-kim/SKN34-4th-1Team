-- 관리자 접속기록입니다. 관리자가 회원 개인정보를 조회하거나 계정을 조치하거나 이 기록을 볼 때마다 요청 하나에 한 행을 남깁니다.
-- 개인정보의 안전성 확보조치 기준 제8조의 항목(처리자 식별자·접속일시·접속지·처리한 정보주체·수행업무)을 담고,
-- 제5조의 권한 부여·해제도 같은 행으로 남습니다. 애플리케이션은 INSERT와 SELECT만 하며 행을 고치거나 지우지 않습니다.
--
-- 계정 ID 두 칸에는 외래 키를 걸지 않습니다. ON DELETE CASCADE는 계정 행을 지울 때 기록까지 지우고,
-- ON DELETE SET NULL은 처리한 정보주체를 기록에서 지우는 수정이 되어 보관 의무와 맞지 않습니다. 계정은 삭제 표시로만
-- 지우지만, 행을 직접 지우는 일이 생겨도 기록이 그대로 남도록 ID 값만 보관합니다.
-- 요청 요약에는 검색어 원문 같은 개인정보를 넣지 않고 조건 이름·건수·조치 기록 번호만 넣습니다.
CREATE TABLE admin_access_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    actor_account_id BIGINT UNSIGNED NOT NULL,
    action VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_account_id BIGINT UNSIGNED NULL,
    request_summary VARCHAR(500) NULL,
    client_ip VARCHAR(64) NOT NULL,
    user_agent VARCHAR(255) NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT chk_admin_access_log_action CHECK (action IN (
        'ACCOUNT_LIST',
        'ACCOUNT_DETAIL',
        'ACCOUNT_SUSPEND',
        'ACCOUNT_UNSUSPEND',
        'ACCOUNT_SESSIONS_REVOKE',
        'ACCOUNT_ADMIN_GRANT',
        'ACCOUNT_ADMIN_REVOKE',
        'AUDIT_LOG_LIST'
    )),
    CONSTRAINT chk_admin_access_log_client_ip CHECK (CHAR_LENGTH(client_ip) BETWEEN 1 AND 64),
    INDEX idx_admin_access_log_created_at (created_at),
    INDEX idx_admin_access_log_actor (actor_account_id),
    INDEX idx_admin_access_log_target (target_account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 관리자 권한 부여·해제도 정지·강제 로그아웃처럼 사유와 함께 조치 기록에 남깁니다.
-- 기존 행은 바꾸지 않고 CHECK 제약이 허용하는 값만 넓힙니다. 기존 값은 모두 새 목록에 들어 있습니다.
ALTER TABLE account_admin_action
    DROP CHECK chk_account_admin_action_action;

ALTER TABLE account_admin_action
    ADD CONSTRAINT chk_account_admin_action_action
        CHECK (action IN ('SUSPEND', 'UNSUSPEND', 'SESSIONS_REVOKE', 'ADMIN_GRANT', 'ADMIN_REVOKE'));
