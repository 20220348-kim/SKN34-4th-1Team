ALTER TABLE application_preparation
    ADD COLUMN progress_stage VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PREPARING' AFTER service_field,
    ADD COLUMN progress_revision BIGINT NOT NULL DEFAULT 1 AFTER progress_stage,
    ADD COLUMN progress_stage_updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) AFTER progress_revision,
    ADD CONSTRAINT chk_application_preparation_progress_stage
        CHECK (progress_stage IN ('PREPARING', 'APPLIED', 'DOCUMENT_REVIEW', 'PRESENTATION_REVIEW', 'SELECTED', 'REJECTED')),
    ADD CONSTRAINT chk_application_preparation_progress_revision CHECK (progress_revision > 0);

UPDATE application_preparation
SET progress_stage_updated_at = updated_at;
