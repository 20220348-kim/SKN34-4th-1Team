-- 월 한도 기능(APPLICATION_DRAFT·COMBINATION_REVIEW)과 서울 달 기간 키(YYYY-MM)를 사용량 표에 더합니다.
-- 월 한도의 사용량은 각 기능의 작업 표에서 실패하지 않은 작업으로 세며, 이 표에는 이번 달에 지운 신청 문서·중복 검토가
-- 이미 쓴 횟수만 더해 두어 삭제로 한도가 다시 늘지 않게 합니다.
-- MySQL 8.4는 CHECK 제약을 바로 고칠 수 없어 같은 이름으로 지우고 다시 만듭니다. 기존 행은 새 조건도 만족합니다.
ALTER TABLE plan_usage_counter
    DROP CHECK chk_plan_usage_counter_feature,
    DROP CHECK chk_plan_usage_counter_period;

ALTER TABLE plan_usage_counter
    ADD CONSTRAINT chk_plan_usage_counter_feature
        CHECK (feature IN ('AI_SEARCH', 'EVIDENCE_QUESTION', 'APPLICATION_DRAFT', 'COMBINATION_REVIEW')),
    ADD CONSTRAINT chk_plan_usage_counter_period
        CHECK (period_key REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$');
