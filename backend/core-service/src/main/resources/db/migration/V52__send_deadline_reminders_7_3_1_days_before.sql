-- 관심 공고 마감 알림을 마감 7·3·1일 전에 한 번씩 보냅니다. 같은 공고·마감일이라도 며칠 전(days_before)마다 따로 예약하도록
-- 중복 방지 키에 days_before를 더합니다. 기존 발송 기록은 그대로 두며 새 키와 충돌하지 않습니다.
-- 계정 설정의 deadline_reminder_days_before는 더 이상 고르지 않고 읽지도 않지만, 되돌릴 수 있도록 값과 컬럼은 남겨 둡니다.
ALTER TABLE deadline_reminder
    ADD CONSTRAINT uq_deadline_reminder_days UNIQUE (account_id, source_code, source_program_id, kind, due_date, days_before);

ALTER TABLE deadline_reminder DROP INDEX uq_deadline_reminder_once;
