-- 관심 공고를 담을 때 공고 원문을 미리 수집·색인하는 큐 적재 상태(outbox)입니다.
-- PENDING: 발행 대기, PUBLISHED: 큐에 실림(소비 대기), DONE: 원문·색인 준비됨, FAILED: 수집 불가(기업마당 외 공고 등).
-- DONE 행은 하루가 지나면 신선도 갱신을 위해 다시 PENDING이 됩니다.
ALTER TABLE saved_support_program
    ADD COLUMN source_prefetch_status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    ADD COLUMN source_prefetch_next_publish_at DATETIME(6) NULL,
    ADD COLUMN source_prefetch_updated_at DATETIME(6) NULL,
    ADD INDEX idx_saved_support_program_prefetch (source_prefetch_status, source_prefetch_next_publish_at);
