ALTER TABLE support_program
    ADD COLUMN startup_details JSON NULL,
    ADD CONSTRAINT chk_support_program_startup_details CHECK (
        startup_details IS NULL OR (
            source_code = 'KSTARTUP'
            AND JSON_TYPE(startup_details) = 'OBJECT'
            AND JSON_CONTAINS_PATH(startup_details, 'all', '$.startupStages', '$.applicantTypes', '$.founderAges')
            AND JSON_TYPE(JSON_EXTRACT(startup_details, '$.startupStages')) = 'ARRAY'
            AND JSON_TYPE(JSON_EXTRACT(startup_details, '$.applicantTypes')) = 'ARRAY'
            AND JSON_TYPE(JSON_EXTRACT(startup_details, '$.founderAges')) = 'ARRAY'
        )
    );
