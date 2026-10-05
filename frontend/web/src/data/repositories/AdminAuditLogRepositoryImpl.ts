import type { AdminAuditLogPage, AdminAuditLogQuery } from '../../domain/entities/AdminAuditLog'
import type { AdminAuditLogRepository } from '../../domain/repositories/AdminAuditLogRepository'
import { browseAdminAuditLogsApi } from '../api/adminAuditLogApi'
import { toAdminAuditLogPage } from '../models/AdminAuditLogDto'

/** Core API 감사 기록 DTO를 Domain 값으로 바꾸는 adapter입니다. 실패는 화면이 한 가지로 안내하므로 그대로 던집니다. */
export class AdminAuditLogRepositoryImpl implements AdminAuditLogRepository {
  async browse(query: AdminAuditLogQuery, before: number | null, signal?: AbortSignal): Promise<AdminAuditLogPage> {
    return toAdminAuditLogPage(await browseAdminAuditLogsApi(query, before, signal))
  }
}
