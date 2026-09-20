-- 기존 index_ready는 Qdrant만 검증한 값이다. 원본·동기화 이력은 보존하고 파생 준비 상태만 재검증한다.
-- 배포 후 색인 복구가 Elasticsearch와 Qdrant를 모두 확인하면 현재 스냅샷이 다시 검색 가능해진다.
UPDATE support_program_sync_status
SET index_ready = FALSE
WHERE index_ready = TRUE;
