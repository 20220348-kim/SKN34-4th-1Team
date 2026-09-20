-- 개발 환경에서 Django가 test_govbiz4 DB를 생성·삭제할 수 있도록 허용합니다.
-- 이름은 Compose의 govbiz4 및 Django의 기본 test_ 접두사와 일치합니다.
GRANT ALL PRIVILEGES ON test_govbiz4.* TO 'govbiz4'@'%';
