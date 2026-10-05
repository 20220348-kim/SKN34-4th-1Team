-- 공식 API의 문의처(K-Startup 담당 부서·전화번호, 기업마당 문의처 원문)와 K-Startup 우대 사항·주관 기관 유형을
-- 상세 표시용으로 보관합니다. 검색 문서·임베딩에는 넣지 않으며, 기존 행은 다음 정상 동기화의 UPSERT로 채워집니다.
ALTER TABLE support_program
    ADD COLUMN contact_department VARCHAR(255) NULL,
    ADD COLUMN contact_phone_number VARCHAR(64) NULL,
    ADD COLUMN contact_text TEXT NULL,
    ADD COLUMN preference_description TEXT NULL,
    ADD COLUMN supervising_institution_type VARCHAR(64) NULL;
