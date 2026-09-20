CREATE TABLE partner_proposal (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    recruitment_id BIGINT UNSIGNED NOT NULL,
    proposer_account_id BIGINT UNSIGNED NOT NULL,
    proposer_company_id BIGINT UNSIGNED NOT NULL,
    message VARCHAR(500) NOT NULL,
    share_profile BOOLEAN NOT NULL,
    decision VARCHAR(20) NULL,
    responded_at DATETIME(6) NULL,
    withdrawn_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT uq_partner_proposal_recruitment_proposer UNIQUE (recruitment_id, proposer_account_id),
    CONSTRAINT fk_partner_proposal_recruitment
        FOREIGN KEY (recruitment_id) REFERENCES partner_recruitment (id) ON DELETE CASCADE,
    CONSTRAINT fk_partner_proposal_proposer_account
        FOREIGN KEY (proposer_account_id) REFERENCES account (id) ON DELETE CASCADE,
    CONSTRAINT fk_partner_proposal_proposer_company
        FOREIGN KEY (proposer_company_id) REFERENCES company (id) ON DELETE CASCADE,
    CONSTRAINT chk_partner_proposal_decision CHECK (decision IS NULL OR decision IN ('ACCEPTED', 'DECLINED')),
    INDEX idx_partner_proposal_proposer (proposer_account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
