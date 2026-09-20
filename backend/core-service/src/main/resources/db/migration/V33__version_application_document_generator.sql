ALTER TABLE application_document_file
    ADD COLUMN generator_version INT NOT NULL DEFAULT 1,
    DROP INDEX uk_application_document_revision,
    ADD CONSTRAINT uk_application_document_generator UNIQUE (preparation_id, input_revision, generator_version);
