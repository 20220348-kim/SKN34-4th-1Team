-- 출시 전 무료 체험입니다. 플러스·프리미엄을 요금제마다 계정당 한 번, 14일 동안 그 요금제의 이용권으로 씁니다.
-- 체험을 시작하면 이 표에 기록하고 account_plan에 체험 이용권(source = TRIAL, ends_at = 시작 + 14일)을 배정합니다.
-- 기본 키가 (계정, 요금제)라 같은 요금제를 두 번 체험할 수 없고, 계정을 지우면 함께 지워집니다.
CREATE TABLE plan_trial (
    account_id BIGINT UNSIGNED NOT NULL,
    plan_code VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    started_at DATETIME(6) NOT NULL,
    ends_at DATETIME(6) NOT NULL,
    PRIMARY KEY (account_id, plan_code),
    CONSTRAINT fk_plan_trial_account FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT chk_plan_trial_code CHECK (plan_code IN ('PLUS', 'PREMIUM')),
    CONSTRAINT chk_plan_trial_period CHECK (ends_at > started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 배정한 요금제가 운영자 배정인지 체험인지 구분합니다. 기존 배정은 모두 운영자 배정입니다.
ALTER TABLE account_plan
    ADD COLUMN source VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'OPERATOR' AFTER plan_code,
    ADD CONSTRAINT chk_account_plan_source CHECK (source IN ('OPERATOR', 'TRIAL'));
