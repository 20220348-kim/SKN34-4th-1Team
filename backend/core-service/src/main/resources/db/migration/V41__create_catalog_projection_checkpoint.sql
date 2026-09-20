-- Core의 기존 공고 행과 외래키는 유지하고, 외부 Catalog에서 반영한 revision만 별도로 관리합니다.
CREATE TABLE catalog_projection_checkpoint (
    source_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    catalog_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    published_generation BIGINT UNSIGNED NOT NULL,
    payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    programs_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (source_code),
    CONSTRAINT chk_catalog_projection_source CHECK (source_code IN ('BIZINFO', 'KSTARTUP', 'MSIT', 'CNTRADE_NOTICE')),
    CONSTRAINT chk_catalog_projection_payload CHECK (payload_hash REGEXP '^[0-9a-f]{64}$'),
    CONSTRAINT chk_catalog_projection_programs CHECK (programs_hash REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
