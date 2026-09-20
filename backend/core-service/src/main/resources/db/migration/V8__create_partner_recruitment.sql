CREATE TABLE partner_recruitment (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_id BIGINT UNSIGNED NOT NULL,
    company_id BIGINT UNSIGNED NOT NULL,
    support_program_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(80) NOT NULL,
    body TEXT NOT NULL,
    own_role VARCHAR(20) NOT NULL,
    seeking_role VARCHAR(20) NOT NULL,
    seeking_count TINYINT UNSIGNED NOT NULL,
    region VARCHAR(20) NOT NULL,
    minimum_company_age_years TINYINT UNSIGNED NULL,
    capabilities JSON NOT NULL,
    recruitment_deadline DATE NOT NULL,
    closed_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT uq_partner_recruitment_account_program UNIQUE (account_id, support_program_id),
    CONSTRAINT fk_partner_recruitment_account
        FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT fk_partner_recruitment_company
        FOREIGN KEY (company_id) REFERENCES company (id) ON DELETE CASCADE,
    CONSTRAINT fk_partner_recruitment_support_program
        FOREIGN KEY (support_program_id) REFERENCES support_program (id),
    CONSTRAINT chk_partner_recruitment_seeking_count CHECK (seeking_count BETWEEN 1 AND 9),
    CONSTRAINT chk_partner_recruitment_company_age CHECK (minimum_company_age_years IS NULL OR minimum_company_age_years BETWEEN 1 AND 50),
    INDEX idx_partner_recruitment_deadline (recruitment_deadline),
    INDEX idx_partner_recruitment_support_program (support_program_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
