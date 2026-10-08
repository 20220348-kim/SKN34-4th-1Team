-- 계정·기능·하루별 사용 횟수입니다. 기간 키는 서울 날짜(YYYY-MM-DD)이며,
-- 날짜가 바뀌면 새 행을 쓰므로 따로 초기화하지 않습니다.
-- 하루 한도 기능(AI_SEARCH·EVIDENCE_QUESTION)은 AI를 부르기 전에 한도 안에서만 1을 더하고, 요청이 실패하면 되돌립니다.
-- 한도를 아직 정하지 않은 요금제도 사용량을 남기도록 같은 방식으로 셉니다.
CREATE TABLE plan_usage_counter (
    account_id BIGINT UNSIGNED NOT NULL,
    feature VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    period_key VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    used_count INT UNSIGNED NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (account_id, feature, period_key),
    CONSTRAINT fk_plan_usage_counter_account FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT chk_plan_usage_counter_feature
        CHECK (feature IN ('AI_SEARCH', 'EVIDENCE_QUESTION')),
    CONSTRAINT chk_plan_usage_counter_period
        CHECK (period_key REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
