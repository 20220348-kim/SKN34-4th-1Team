ALTER TABLE application_document_file
    ADD COLUMN generation_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    DROP INDEX uk_application_document_generator,
    ADD CONSTRAINT uk_application_document_fingerprint UNIQUE (preparation_id, input_revision, generator_version, generation_fingerprint);
