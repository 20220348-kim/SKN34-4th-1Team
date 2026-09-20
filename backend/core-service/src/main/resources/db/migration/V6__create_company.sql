CREATE TABLE company (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_id BIGINT UNSIGNED NOT NULL,
    business_number CHAR(10) NOT NULL,
    company_name VARCHAR(200) NOT NULL,
    business_status VARCHAR(40) NOT NULL,
    business_status_code VARCHAR(4) NOT NULL,
    region VARCHAR(40) NOT NULL,
    industry VARCHAR(80) NOT NULL,
    founded_year SMALLINT UNSIGNED NOT NULL,
    homepage_url VARCHAR(500) NULL,
    business_verified_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT uq_company_account UNIQUE (account_id),
    CONSTRAINT uq_company_business_number UNIQUE (business_number),
    CONSTRAINT fk_company_account
        FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT chk_company_founded_year CHECK (founded_year BETWEEN 1900 AND 2100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
