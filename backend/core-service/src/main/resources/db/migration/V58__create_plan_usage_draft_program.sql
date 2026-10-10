-- 작업 표를 남기지 않는 신청 문서 경로(이전 동기 양식 분석·문서 생성, 문항별 AI 해석·초안)가
-- AI를 부르기 전에 그 공고를 이번 달 신청 문서 사용량으로 남기는 기록입니다.
-- 같은 계정의 접수와 함께 계정 행을 잠근 transaction에서, 이번 달에 아직 세지 않은 공고일 때만 한 행을 넣습니다.
-- AI 실행이 실패하면 넣은 행을 지워 돌려주고, 신청 문서를 지워도 이 기록은 남아 삭제로 한도가 다시 늘지 않습니다.
CREATE TABLE plan_usage_draft_program (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_id BIGINT UNSIGNED NOT NULL,
    source_code VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
    source_program_id VARCHAR(255) COLLATE utf8mb4_0900_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_plan_usage_draft_program_account_created (account_id, created_at),
    CONSTRAINT fk_plan_usage_draft_program_account FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT chk_plan_usage_draft_program_identity
        CHECK (CHAR_LENGTH(TRIM(source_code)) > 0 AND CHAR_LENGTH(TRIM(source_program_id)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
