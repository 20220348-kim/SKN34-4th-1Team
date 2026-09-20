-- 신청 준비를 시작한 공고는 관심 공고함에도 담겨 있어야 합니다. 이 규칙이 생기기 전에 만들어진 신청 준비 건은
-- 관심 공고 행이 없어, 같은 공고가 진행 관리에는 있고 관심 공고함에는 없는 상태로 갈라져 있었습니다.
-- 이미 담긴 건은 유니크 키(account_id, support_program_id) 덕분에 그대로 두고, 빠진 건만 채웁니다.
-- 담긴 시각은 관심 공고함 정렬 기준이라 실제 준비를 시작한 때인 신청 준비 생성 시각을 씁니다.
INSERT IGNORE INTO saved_support_program (account_id, support_program_id, saved_at)
SELECT preparation.owner_account_id, program.id, preparation.created_at
FROM application_preparation preparation
JOIN support_program program
    ON program.source_code = preparation.source_code
    AND program.source_program_id = preparation.source_program_id;
