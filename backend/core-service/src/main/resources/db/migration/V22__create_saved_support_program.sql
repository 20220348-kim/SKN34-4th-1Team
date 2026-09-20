-- 회원이 다시 볼 공고를 담아 두는 관심 공고함입니다. 계정당 같은 공고는 한 번만 담깁니다.
-- 공고 행은 동기화 때 갱신·비노출(is_source_present=FALSE)되므로 FK만 걸고 노출 여부는 조회 때 확인합니다.
CREATE TABLE saved_support_program (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_id BIGINT UNSIGNED NOT NULL,
    support_program_id BIGINT UNSIGNED NOT NULL,
    saved_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT uq_saved_support_program_account_program UNIQUE (account_id, support_program_id),
    CONSTRAINT fk_saved_support_program_account
        FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT fk_saved_support_program_program
        FOREIGN KEY (support_program_id) REFERENCES support_program (id) ON DELETE CASCADE,
    INDEX idx_saved_support_program_account (account_id, saved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
