-- 중복 검토 세 질문(v3)의 검토 단위 선택 입력입니다. 두 사업이 같은 과제인지(same_project), 같은 비용인지(same_cost)를
-- 사용자가 고르지 않았으면 UNKNOWN(모름)으로 둡니다. 기존 검토도 UNKNOWN으로 채우며 다른 입력에서 추론하지 않습니다.
-- 참여 사실 칸과 같이 대소문자를 구분하는 binary collation으로 'yes' 같은 값을 CHECK에서 거절합니다.
ALTER TABLE combination_review
    ADD COLUMN same_project VARCHAR(7) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'UNKNOWN',
    ADD COLUMN same_cost VARCHAR(7) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT 'UNKNOWN',
    ADD CONSTRAINT chk_combination_review_same_project CHECK (same_project IN ('UNKNOWN', 'YES', 'NO')),
    ADD CONSTRAINT chk_combination_review_same_cost CHECK (same_cost IN ('UNKNOWN', 'YES', 'NO'));
