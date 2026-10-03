-- 양식 분석에서 사용자에게 알려야 하는 안내(받지 못한 첨부, 제외한 양식, 직접 체크할 동의 항목 등)를 공고별 상태와 함께 둔다.
-- 분석 결과가 바뀌면 다시 쓰고, 공고가 바뀌어 상태가 무효가 되면 비운다.
ALTER TABLE application_form_availability
    ADD COLUMN analysis_warnings JSON NULL;
