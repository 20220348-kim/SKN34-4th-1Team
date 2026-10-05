-- Catalog snapshot의 공식 문의처(K-Startup 담당 부서·전화번호, 기업마당 문의처 원문)와 K-Startup 우대 사항·주관 기관 유형을
-- 공고 상세 API용으로 보관한다. 기존 행은 Catalog가 새 필드를 채워 공개한 다음 세대의 projection(UPSERT)에서 채워진다.
ALTER TABLE support_program
    ADD COLUMN contact_department VARCHAR(255) NULL,
    ADD COLUMN contact_phone_number VARCHAR(64) NULL,
    ADD COLUMN contact_text TEXT NULL,
    ADD COLUMN preference_description TEXT NULL,
    ADD COLUMN supervising_institution_type VARCHAR(64) NULL;

-- 새 필드가 projection의 payload_hash·programs_hash 계산에 들어가므로, 이전 형식으로 저장한 해시를 같은 revision과 비교하면
-- 다음 공개 세대까지 "이미 반영한 revision이 바뀌었다"는 거절이 반복된다. revision만 0(미반영)으로 되돌려 다음 수신 때
-- 같은 snapshot을 한 번 다시 UPSERT하고 새 형식의 해시를 기록하게 한다. 공고 행·Catalog UUID·공개 세대는 바꾸지 않으며
-- 세대 역전 거절도 그대로 유지된다. checkpoint가 없는 embedded 실행에서는 바뀌는 행이 없다.
UPDATE catalog_projection_checkpoint SET revision = 0 WHERE revision > 0;
