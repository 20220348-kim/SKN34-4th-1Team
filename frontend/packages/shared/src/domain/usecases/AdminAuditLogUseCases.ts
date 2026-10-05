import { adminAuditLogQueryIssue, type AdminAuditLogQuery } from '../entities/AdminAuditLog'
import type { AdminAuditLogRepository } from '../repositories/AdminAuditLogRepository'

/** 잘못된 계정 ID·날짜·거꾸로 된 기간이나 커서는 서버에 보내지 않습니다. */
export class BrowseAdminAuditLogsUseCase {
  private readonly repository: Pick<AdminAuditLogRepository, 'browse'>

  constructor(repository: Pick<AdminAuditLogRepository, 'browse'>) {
    this.repository = repository
  }

  execute(query: AdminAuditLogQuery, before: number | null = null, signal?: AbortSignal) {
    const issue = adminAuditLogQueryIssue(query)
    if (issue !== null) throw new RangeError(`audit log query is invalid: ${issue}`)
    if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw new RangeError('cursor must be a positive integer')
    return this.repository.browse(query, before, signal)
  }
}
