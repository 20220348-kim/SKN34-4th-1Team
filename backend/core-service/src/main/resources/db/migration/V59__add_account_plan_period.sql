-- 유료 요금제를 30일 이용권으로 다룹니다. assigned_at은 이용권이 시작한 서울 시각이고, ends_at이 지나면 무료로 돌아갑니다.
-- ends_at이 없는 배정(운영자·검증 계정)은 assigned_at부터 30일마다 새 이용 기간이 시작됩니다. 기존 배정 행은 ends_at 없이 남습니다.
ALTER TABLE account_plan
    ADD COLUMN ends_at DATETIME(6) NULL AFTER assigned_at,
    ADD CONSTRAINT chk_account_plan_period CHECK (ends_at IS NULL OR ends_at > assigned_at);

-- 유료 요금제의 사용량은 이용 기간 키(P와 기간이 시작한 서울 시각, 예: P20261020T153000)로 셉니다.
-- MySQL 8.4는 CHECK 제약을 바로 고칠 수 없어 지우고 길이를 넓힌 뒤 다시 만듭니다. 기존 날짜·달 키는 새 조건도 만족합니다.
ALTER TABLE plan_usage_counter
    DROP CHECK chk_plan_usage_counter_period;

ALTER TABLE plan_usage_counter
    MODIFY period_key VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;

ALTER TABLE plan_usage_counter
    ADD CONSTRAINT chk_plan_usage_counter_period
        CHECK (period_key REGEXP '^([0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?|P[0-9]{8}T[0-9]{6})$');
