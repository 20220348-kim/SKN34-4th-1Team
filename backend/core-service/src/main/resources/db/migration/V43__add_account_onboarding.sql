-- 최초 로그인 온보딩 답을 계정에 둡니다. 회원 유형은 앱 구조(협업 메뉴 잠금·프로필 형태)를 가릅니다.
-- onboarded_at이 NULL이면 아직 환영 화면을 거치지 않은 계정입니다.
ALTER TABLE account
    ADD COLUMN account_type VARCHAR(20) NULL COMMENT '회원 유형 INDIVIDUAL·BUSINESS. 온보딩 전에는 NULL',
    ADD COLUMN onboarded_at DATETIME(6) NULL COMMENT '환영 화면을 마친 시각';
