-- 삭제한 대화 내용은 비우고, 늦게 도착한 자동 저장을 거절하기 위한 삭제 표시만 남깁니다.
ALTER TABLE chat_conversation ADD COLUMN deleted_at DATETIME(6) NULL;
