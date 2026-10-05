import { adminAuditLogPageSize, type AdminAuditLogQuery } from '../../domain/entities/AdminAuditLog'
import { adminAuditLogListDtoSchema, type AdminAuditLogListDto } from '../models/AdminAuditLogDto'
import { rejectFailedResponse } from './adminAccountApi'
import { getCoreApiBaseUrl } from './coreApiConfig'

const ADMIN_AUDIT_LOGS_PATH = '/api/v1/admin/audit-logs'

/**
 * 감사 기록을 최신순으로 읽습니다. 고른 조건과 커서(`before`)만 보내고 세션 쿠키로 관리자인지 확인합니다.
 * 기록에는 관리자 이메일과 접속 주소가 있으므로 브라우저 캐시를 쓰지 않습니다.
 */
export async function browseAdminAuditLogsApi(
  query: AdminAuditLogQuery,
  before: number | null,
  signal?: AbortSignal,
): Promise<AdminAuditLogListDto> {
  const params = new URLSearchParams({ limit: String(adminAuditLogPageSize) })
  if (query.actorAccountId !== null) params.set('actorAccountId', String(query.actorAccountId))
  if (query.targetAccountId !== null) params.set('targetAccountId', String(query.targetAccountId))
  if (query.action !== '') params.set('action', query.action)
  if (query.from !== '') params.set('from', query.from)
  if (query.to !== '') params.set('to', query.to)
  if (before !== null) params.set('before', String(before))
  const response = await fetch(`${getCoreApiBaseUrl()}${ADMIN_AUDIT_LOGS_PATH}?${params}`, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
    cache: 'no-store',
    signal,
  })
  await rejectFailedResponse(response)

  return adminAuditLogListDtoSchema.parse(await response.json())
}
