-- 끝난 양식 분석을 사용자가 신청 문서 작성 목록에서 지운 시각이다. 기록은 남겨 최근 분석 판단과 사용량에 그대로 쓴다.
ALTER TABLE application_form_discovery_job ADD COLUMN dismissed_at DATETIME(6) NULL AFTER seen_at;
