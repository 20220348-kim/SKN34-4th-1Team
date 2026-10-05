import type { AdminAuditLogPage, AdminAuditLogQuery } from '../entities/AdminAuditLog'

/** 감사 기록 화면이 Data Layer의 HTTP 세부사항과 분리되도록 하는 Domain 포트입니다. 관리자 세션이 있어야 합니다. */
export interface AdminAuditLogRepository {
  /** 최신 기록부터 읽습니다. `before`가 있으면 그 ID보다 오래된 기록입니다. 이 조회도 서버의 감사 기록에 남습니다. */
  browse(query: AdminAuditLogQuery, before: number | null, signal?: AbortSignal): Promise<AdminAuditLogPage>
}
