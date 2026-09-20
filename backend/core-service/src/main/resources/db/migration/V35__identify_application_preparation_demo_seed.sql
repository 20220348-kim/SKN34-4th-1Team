-- 일반 신청 작업은 NULL을 유지하므로 같은 공고·분야로 여러 작업을 저장할 수 있습니다.
-- 로컬 시드만 고정 키를 넣어 사용자 작업과 별개로 목업을 한 건씩 유지합니다.
ALTER TABLE application_preparation
    ADD COLUMN demo_seed_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD CONSTRAINT uq_application_preparation_demo_seed UNIQUE (owner_account_id, demo_seed_key);
