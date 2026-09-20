CREATE TABLE application_document_file (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    preparation_id BIGINT UNSIGNED NOT NULL,
    input_revision BIGINT NOT NULL,
    file_name VARCHAR(500) NOT NULL,
    media_type VARCHAR(100) NOT NULL,
    file_bytes LONGBLOB NOT NULL,
    source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    placements_json JSON NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uk_application_document_revision UNIQUE (preparation_id, input_revision),
    CONSTRAINT fk_application_document_preparation FOREIGN KEY (preparation_id) REFERENCES application_preparation(id) ON DELETE CASCADE,
    CONSTRAINT ck_application_document_revision CHECK (input_revision > 0),
    CONSTRAINT ck_application_document_size CHECK (OCTET_LENGTH(file_bytes) BETWEEN 1 AND 33554432)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
