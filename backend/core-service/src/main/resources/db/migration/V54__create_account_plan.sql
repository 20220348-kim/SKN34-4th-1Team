-- 계정별로 배정한 요금제입니다. 결제 연동 전이라 행이 없으면 FREE이고,
-- 테스트·제휴 계정처럼 다른 요금제가 필요한 계정만 운영자가 직접 배정합니다.
CREATE TABLE account_plan (
    account_id BIGINT UNSIGNED NOT NULL,
    plan_code VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    assigned_at DATETIME(6) NOT NULL,
    PRIMARY KEY (account_id),
    CONSTRAINT fk_account_plan_account FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT chk_account_plan_code CHECK (plan_code IN ('FREE', 'PLUS', 'PREMIUM'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
