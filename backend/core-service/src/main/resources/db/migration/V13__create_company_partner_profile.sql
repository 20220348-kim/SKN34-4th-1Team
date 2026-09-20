-- 기업당 하나인 협업·파트너 설정입니다. 역할·관심 분야·역량은 모집글의 capabilities와 같이 JSON 배열로 둡니다.
CREATE TABLE company_partner_profile (
    company_id BIGINT UNSIGNED NOT NULL,
    roles JSON NOT NULL,
    interest_areas JSON NOT NULL,
    introduction VARCHAR(200) NOT NULL DEFAULT '',
    capabilities JSON NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (company_id),
    CONSTRAINT fk_company_partner_profile_company
        FOREIGN KEY (company_id) REFERENCES company (id) ON DELETE CASCADE,
    CONSTRAINT chk_company_partner_profile_roles CHECK (JSON_TYPE(roles) = 'ARRAY' AND JSON_LENGTH(roles) BETWEEN 1 AND 3),
    CONSTRAINT chk_company_partner_profile_interest_areas CHECK (JSON_TYPE(interest_areas) = 'ARRAY' AND JSON_LENGTH(interest_areas) <= 3),
    CONSTRAINT chk_company_partner_profile_capabilities CHECK (JSON_TYPE(capabilities) = 'ARRAY' AND JSON_LENGTH(capabilities) <= 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
