-- 기존 발송 상태와 리포트 ID를 재사용한다. 수신 주소·본문·원문 토큰은 큐에 복제하지 않는다.
ALTER TABLE daily_report
    ADD COLUMN delivery_queued_at DATETIME(6) NULL,
    ADD COLUMN delivery_deadline_at DATETIME(6) NULL,
    ADD COLUMN delivery_next_publish_at DATETIME(6) NULL,
    ADD COLUMN delivery_last_published_at DATETIME(6) NULL,
    ADD CONSTRAINT ck_daily_report_delivery_outbox CHECK (
        (delivery_queued_at IS NULL AND delivery_deadline_at IS NULL
            AND delivery_next_publish_at IS NULL AND delivery_last_published_at IS NULL)
        OR (delivery_queued_at IS NOT NULL AND delivery_deadline_at IS NOT NULL
            AND delivery_next_publish_at IS NOT NULL AND delivery_deadline_at > delivery_queued_at)
    ),
    ADD INDEX idx_daily_report_delivery_outbox (delivery_status, delivery_next_publish_at, id);
