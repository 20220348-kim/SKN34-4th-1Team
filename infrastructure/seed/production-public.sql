-- 운영용 추가 전용 시드. seed-production-demo.py가 고정 공고 ID·비밀번호 해시·트랜잭션을 전달합니다.
-- 계정/기업 충돌은 중단하고 기존 값·세션·권한·비밀번호를 변경하지 않습니다. 관리자 조치 기록은 만들지 않습니다.
CREATE TEMPORARY TABLE production_demo_account (
    seq INT PRIMARY KEY, email VARCHAR(320) NOT NULL, role VARCHAR(20) NOT NULL,
    password_hash VARCHAR(100), business_number CHAR(10) NOT NULL, company_name VARCHAR(200) NOT NULL,
    region VARCHAR(40) NOT NULL, industry VARCHAR(80) NOT NULL, founded_year INT NOT NULL,
    introduction VARCHAR(200) NOT NULL, capabilities JSON NOT NULL
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO production_demo_account VALUES
    (0, 'admin@govbiz.local', 'ADMIN', @account_hash_0, '2208800113', '거북섬테크 주식회사', '서울특별시', '정보통신업', 2021, '[시연용] 전자·소프트웨어 협업을 확인하는 가상 기업입니다.', '["전자","소프트웨어"]'),
    (1, 'member@govbiz.local', 'USER', @account_hash_1, '2148812034', '넥스트웨이브 주식회사', '서울특별시', '정보통신업', 2020, '[시연용] AI 문서 분류와 공공 데이터 활용 서비스를 만드는 가상 기업입니다.', '["문서 분류 AI","공공 데이터 연계"]'),
    (2, 'jihoon.park@demo.govbiz.local', 'USER', @account_hash_2, '1208734519', '데이터브릿지 주식회사', '서울특별시', '정보통신업', 2021, '[시연용] 데이터 구축·라벨링·품질 검수를 전문으로 하는 가상 기업입니다.', '["데이터 구축","라벨링","품질 검수"]'),
    (3, 'hana.choi@demo.govbiz.local', 'USER', @account_hash_3, '6098246118', '한빛정밀', '경상남도', '제조업', 2012, '[시연용] 정밀 가공 부품을 설계·양산하는 가상 기업입니다.', '["정밀 가공","금형 설계"]'),
    (4, 'dohyun.jung@demo.govbiz.local', 'USER', @account_hash_4, '3148937762', '마루헬스케어', '대전광역시', '보건업 및 사회복지 서비스업', 2020, '[시연용] 디지털 헬스케어 서비스를 운영하는 가상 기업입니다.', '["헬스케어 데이터","IoT 센서"]'),
    (5, 'yuna.kang@demo.govbiz.local', 'USER', @account_hash_5, '1318128490', '오션로지스', '인천광역시', '운수 및 창고업', 2015, '[시연용] 수출 식품 콜드체인 실증을 준비하는 가상 기업입니다.', '["냉장 보관","수출 물류"]');

CREATE TEMPORARY TABLE production_demo_guard (
    ok BOOLEAN NOT NULL CHECK (ok = TRUE)
);
INSERT INTO production_demo_guard VALUES (@personal_demo_seed_lock_acquired = 1);
-- 기존 휴면/정지/삭제 계정이나 다른 권한 계정을 데모 계정으로 바꾸지 않습니다.
INSERT INTO production_demo_guard
SELECT COUNT(*) = 0 FROM account a JOIN production_demo_account d ON d.email = a.email
WHERE a.deleted_at IS NOT NULL OR a.suspended_at IS NOT NULL OR a.role <> d.role;
INSERT INTO production_demo_guard
SELECT COUNT(*) = 0 FROM production_demo_account d LEFT JOIN account a ON a.email = d.email
WHERE a.id IS NULL AND (d.password_hash IS NULL OR LEFT(d.password_hash, 4) NOT IN ('$2a$', '$2b$', '$2y$') OR CHAR_LENGTH(d.password_hash) <> 60);
-- 사업자번호가 다른 소유자에게 있거나 대상 계정에 다른 기업이 있으면 전체 중단합니다.
INSERT INTO production_demo_guard
SELECT COUNT(*) = 0 FROM production_demo_account d
LEFT JOIN account a ON a.email = d.email
JOIN company c ON c.business_number = d.business_number OR c.account_id = a.id
WHERE a.id IS NULL OR c.account_id <> a.id OR c.business_number <> d.business_number;

INSERT INTO account (email, password_hash, role, email_verified_at, terms_agreed_at, created_at)
SELECT d.email, d.password_hash, d.role, @now, @now, @now
FROM production_demo_account d LEFT JOIN account a ON a.email = d.email WHERE a.id IS NULL;
SELECT a.id FROM account a JOIN production_demo_account d ON d.email = a.email ORDER BY a.id FOR UPDATE;

-- plan에 저장한 공고를 재사용합니다. 재실행 때 다른 공고로 바뀌어 데모가 늘어나지 않습니다.
CREATE TEMPORARY TABLE production_demo_program (seq INT PRIMARY KEY, id BIGINT UNSIGNED NOT NULL UNIQUE);
INSERT INTO production_demo_program VALUES (1,@p1),(2,@p2),(3,@p3),(4,@p4),(5,@p5);
INSERT INTO production_demo_guard
SELECT COUNT(*) = 5 FROM production_demo_program d JOIN support_program p ON p.id = d.id
WHERE p.source_code = 'BIZINFO';
-- 새로운 모집글은 유효한 공고에만 생성합니다. 이미 있는 모집글의 마감/내용은 보존합니다.
INSERT INTO production_demo_guard
SELECT COUNT(*) = 0 FROM production_demo_account d
JOIN account a ON a.email = d.email JOIN production_demo_program p ON p.seq = d.seq
JOIN support_program s ON s.id = p.id
LEFT JOIN partner_recruitment r ON r.account_id = a.id AND r.support_program_id = p.id
WHERE r.id IS NULL AND (s.is_source_present = FALSE OR s.application_end_date IS NULL
    OR s.application_end_date < DATE_ADD(CURDATE(), INTERVAL 21 DAY));

INSERT INTO company (account_id, business_number, company_name, business_status, business_status_code,
    region, industry, founded_year, business_verified_at, created_at, updated_at)
SELECT a.id, d.business_number, d.company_name, '계속사업자', '01', d.region, d.industry, d.founded_year, @now, @now, @now
FROM production_demo_account d JOIN account a ON a.email = d.email
LEFT JOIN company c ON c.account_id = a.id WHERE c.id IS NULL;
INSERT INTO company_partner_profile (company_id, roles, interest_areas, introduction, capabilities, created_at, updated_at)
SELECT c.id, JSON_ARRAY('LEAD','PARTICIPANT'), JSON_ARRAY('기술','사업화'), d.introduction, d.capabilities, @now, @now
FROM production_demo_account d JOIN account a ON a.email = d.email JOIN company c ON c.account_id = a.id
LEFT JOIN company_partner_profile p ON p.company_id = c.id WHERE p.company_id IS NULL;

CREATE TEMPORARY TABLE production_demo_recruitment (
    seq INT PRIMARY KEY, title VARCHAR(80) NOT NULL, body TEXT NOT NULL, own_role VARCHAR(20) NOT NULL,
    seeking_role VARCHAR(20) NOT NULL, seeking_count INT NOT NULL
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO production_demo_recruitment VALUES
    (1, '[시연용] AI 실증 데이터 구축·라벨링 참여기관 모집', '가상 모집글입니다. 문서 분류 AI 실증을 위한 데이터 구축·라벨링 협업 흐름을 시연합니다.', 'LEAD','PARTICIPANT',1),
    (2, '[시연용] 스마트공장 고도화 제조 기업 모집', '가상 모집글입니다. 데이터 파이프라인 구축·예측 모델과 제조 현장 협업을 시연합니다.', 'PARTICIPANT','LEAD',1),
    (3, '[시연용] 정밀 가공 부품 국산화 수요처 모집', '가상 모집글입니다. 시제품 시험 평가와 부품 국산화 수요처 협업을 시연합니다.', 'LEAD','DEMAND',2),
    (4, '[시연용] 디지털 헬스케어 실증 참여기관 모집', '가상 모집글입니다. 센서 설치·데이터 분석·요양 시설 현장 협업을 시연합니다.', 'LEAD','PARTICIPANT',2),
    (5, '[시연용] 콜드체인 물류 수출 식품 기업 모집', '가상 모집글입니다. 냉장 보관·온도 추적·식품 수출 기업 협업을 시연합니다.', 'PARTICIPANT','LEAD',1);
INSERT INTO partner_recruitment (account_id, company_id, support_program_id, title, body, own_role, seeking_role,
    seeking_count, region, capabilities, recruitment_deadline, created_at, updated_at)
SELECT a.id, c.id, p.id, f.title, f.body, f.own_role, f.seeking_role, f.seeking_count, '전국', d.capabilities,
    DATE_ADD(CURDATE(), INTERVAL 18 DAY), @now, @now
FROM production_demo_account d JOIN account a ON a.email = d.email JOIN company c ON c.account_id = a.id
JOIN production_demo_program p ON p.seq = d.seq JOIN production_demo_recruitment f ON f.seq = d.seq
LEFT JOIN partner_recruitment r ON r.account_id = a.id AND r.support_program_id = p.id WHERE r.id IS NULL;

CREATE TEMPORARY TABLE production_demo_proposal (sender_seq INT PRIMARY KEY, recipient_seq INT NOT NULL);
INSERT INTO production_demo_proposal VALUES (2,4),(4,5),(5,3),(3,2);
-- MySQL 임시 테이블은 동일 쿼리에서 두 번 열 수 없어 받는 기업 매핑을 별도로 만듭니다.
CREATE TEMPORARY TABLE production_demo_recipient AS SELECT seq, email FROM production_demo_account;
INSERT INTO partner_proposal (recruitment_id, proposer_account_id, proposer_company_id, message, share_profile, created_at, updated_at)
SELECT r.id, sender.id, c.id, '[시연용] 가상 기업 간 협업 제안입니다. 수락·거절 흐름을 확인해 주세요.', TRUE, @now, @now
FROM production_demo_proposal f JOIN production_demo_account d ON d.seq = f.sender_seq
JOIN account sender ON sender.email = d.email JOIN company c ON c.account_id = sender.id
JOIN production_demo_recipient target ON target.seq = f.recipient_seq JOIN account recipient ON recipient.email = target.email
JOIN production_demo_program p ON p.seq = target.seq
JOIN partner_recruitment r ON r.account_id = recipient.id AND r.support_program_id = p.id
LEFT JOIN partner_proposal existing ON existing.recruitment_id = r.id AND existing.proposer_account_id = sender.id
WHERE existing.id IS NULL;

CREATE TEMPORARY TABLE production_demo_saved (account_seq INT NOT NULL, program_seq INT NOT NULL);
INSERT INTO production_demo_saved VALUES
    (0,1),(0,2),(0,5),(1,1),(1,2),(1,3),(1,4),(2,2),(2,1),(2,3),
    (3,3),(3,1),(3,5),(4,4),(4,2),(4,5),(4,1),(5,5),(5,3),(5,4);
INSERT INTO saved_support_program (account_id, support_program_id, saved_at)
SELECT a.id, p.id, @now FROM production_demo_saved f
JOIN production_demo_account d ON d.seq = f.account_seq JOIN account a ON a.email = d.email
JOIN production_demo_program p ON p.seq = f.program_seq
LEFT JOIN saved_support_program s ON s.account_id = a.id AND s.support_program_id = p.id WHERE s.account_id IS NULL;
