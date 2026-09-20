CREATE TABLE support_program_source_document (
    source_code VARCHAR(64) NOT NULL,
    source_program_id VARCHAR(255) NOT NULL,
    source_url VARCHAR(2048) NOT NULL,
    content MEDIUMTEXT NOT NULL,
    content_hash CHAR(64) NOT NULL,
    fetched_at DATETIME(6) NOT NULL,
    PRIMARY KEY (source_code, source_program_id),
    CONSTRAINT fk_support_program_source_document_program
        FOREIGN KEY (source_code, source_program_id)
        REFERENCES support_program (source_code, source_program_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
