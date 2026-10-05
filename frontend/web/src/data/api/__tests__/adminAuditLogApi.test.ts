import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultAdminAuditLogQuery } from '../../../domain/entities/AdminAuditLog'
import { AdminAuditLogRepositoryImpl } from '../../repositories/AdminAuditLogRepositoryImpl'
import { browseAdminAuditLogsApi } from '../adminAuditLogApi'

afterEach(() => {
  vi.unstubAllGlobals()
})

const recordDto = {
  id: 42,
  action: 'ACCOUNT_ADMIN_GRANT',
  actorAccountId: 1,
  actorEmail: 'admin@govbiz.local',
  targetAccountId: 11,
  requestSummary: 'role=USER->ADMIN, adminActionId=5',
  clientIp: '198.51.100.7',
  userAgent: 'Mozilla/5.0',
  createdAt: '2026-09-06T12:00:00.123456',
}

describe('adminAuditLogApi', () => {
  it('sends only the chosen conditions with the cursor and the session cookie without caching', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ records: [recordDto], nextCursor: 41 }))
    vi.stubGlobal('fetch', fetchMock)

    const page = await new AdminAuditLogRepositoryImpl().browse(
      { actorAccountId: null, targetAccountId: 11, action: 'ACCOUNT_ADMIN_GRANT', from: '2026-09-01', to: '' },
      120,
    )

    expect(page).toEqual({ records: [recordDto], nextCursor: 41 })
    const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const url = new URL(requestUrl)
    expect(url.pathname).toBe('/api/v1/admin/audit-logs')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '50', targetAccountId: '11', action: 'ACCOUNT_ADMIN_GRANT', from: '2026-09-01', before: '120',
    })
    expect(init.credentials).toBe('include')
    expect(init.cache).toBe('no-store')
  })

  it('rejects refusals with the problem code and unexpected payloads', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'ADMIN_ACCESS_LOG_UNAVAILABLE' }, 503))
      .mockResolvedValueOnce(jsonResponse({ records: [{ ...recordDto, action: 'ACCOUNT_DELETE' }], nextCursor: null })))

    await expect(browseAdminAuditLogsApi(defaultAdminAuditLogQuery, null)).rejects.toMatchObject({ status: 503, code: 'ADMIN_ACCESS_LOG_UNAVAILABLE' })
    await expect(browseAdminAuditLogsApi(defaultAdminAuditLogQuery, null)).rejects.toThrow()
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
