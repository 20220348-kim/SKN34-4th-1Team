ALTER TABLE support_program
    ADD COLUMN application_method TEXT NULL,
    ADD COLUMN application_url VARCHAR(2048) NULL,
    ADD COLUMN application_route_type VARCHAR(32) NOT NULL DEFAULT 'UNKNOWN',
    ADD CONSTRAINT chk_application_route_type
        CHECK (application_route_type IN ('GOOGLE_FORMS', 'OTHER_ONLINE_FORM', 'FILE', 'UNKNOWN'));
