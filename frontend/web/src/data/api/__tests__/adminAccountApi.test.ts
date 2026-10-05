import { afterEach, describe, expect, it, vi } from 'vitest'

import { AccountApiError } from '../accountApi'
import { AdminAccountRepositoryImpl } from '../../repositories/AdminAccountRepositoryImpl'
import { browseAdminAccountsApi, getAdminAccountStatsApi } from '../adminAccountApi'
import { adminAccountDetailDtoSchema } from '../../models/AdminAccountDto'

afterEach(() => {
  vi.unstubAllGlobals()
})

const summaryDto = {
  id: 11,
  email: 'kakao@kakao.com',
  role: 'USER',
  tier: 'MEMBER',
  status: 'SUSPENDED',
  emailVerified: true,
  hasPassword: false,
  loginMethods: ['KAKAO'],
  company: null,
  createdAt: '2026-09-05T09:00:00',
  lastLoginAt: null,
  suspendedAt: '2026-09-10T15:00:00',
}

const detailDto = {
  account: summaryDto,
  company: null,
  activity: { recruitmentCount: 0, openRecruitmentCount: 0, sentProposalCount: 0, activeSessionCount: 0 },
  actions: [{ id: 3, action: 'SESSIONS_REVOKE', reason: '기기 분실', adminEmail: 'admin@govbiz.local', createdAt: '2026-09-11T09:00:00' }],
  isSelf: false,
}

describe('adminAccountApi', () => {
  it('sends only the chosen filters with the session cookie and validates the page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ accounts: [summaryDto], total: 1, page: 1, pageSize: 20, totalPages: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    const list = await browseAdminAccountsApi({ keyword: 'kakao', status: 'SUSPENDED', role: '', loginMethod: 'KAKAO', sort: 'LAST_LOGIN', page: 1 })
    expect(list.accounts[0]!.loginMethods).toEqual(['KAKAO'])

    const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const url = new URL(requestUrl)
    expect(url.pathname).toBe('/api/v1/admin/accounts')
    // 비운 역할은 보내지 않습니다.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      keyword: 'kakao', sort: 'LAST_LOGIN', page: '1', pageSize: '20', status: 'SUSPENDED', loginMethod: 'KAKAO',
    })
    expect(init.credentials).toBe('include')

    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [], total: 0, page: 2, pageSize: 20, totalPages: 0 }))
    await expect(browseAdminAccountsApi({ keyword: '', status: '', role: '', loginMethod: '', sort: 'RECENT', page: 1 }))
      .rejects.toThrow('요청한 페이지와 응답이 다릅니다.')
  })

  it('reads the summary and rejects a non-admin session with the problem code', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ total: 3, companyRegistered: 1, socialLinked: 1, suspended: 0, admins: 1, joinedRecently: 3, recentJoinDays: 7 }))
      .mockResolvedValueOnce(jsonResponse({ code: 'ADMIN_ACCESS_DENIED' }, 403)))

    await expect(getAdminAccountStatsApi()).resolves.toMatchObject({ total: 3, recentJoinDays: 7 })
    await expect(getAdminAccountStatsApi()).rejects.toMatchObject({ status: 403, code: 'ADMIN_ACCESS_DENIED' })
  })

  it('posts the reason to each action path and maps refusals to outcomes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(detailDto))
      .mockResolvedValueOnce(jsonResponse(detailDto))
      .mockResolvedValueOnce(jsonResponse({ code: 'ADMIN_SELF_ACTION' }, 422))
      .mockResolvedValueOnce(jsonResponse({ code: 'ADMIN_TARGET_PROTECTED' }, 422))
      .mockResolvedValueOnce(jsonResponse({ code: 'ADMIN_ACCOUNT_STATE_CONFLICT' }, 409))
      .mockResolvedValueOnce(jsonResponse({ code: 'ADMIN_ACCOUNT_NOT_FOUND' }, 404))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = new AdminAccountRepositoryImpl()

    await expect(repository.act(11, 'revoke-sessions', '기기 분실')).resolves.toMatchObject({ outcome: 'done', detail: { isSelf: false } })
    await expect(repository.act(11, 'unsuspend', '소명 확인')).resolves.toMatchObject({ outcome: 'done' })
    const calls = fetchMock.mock.calls as [string, RequestInit][]
    expect(new URL(calls[0]![0]).pathname).toBe('/api/v1/admin/accounts/11/sessions/revoke')
    expect(calls[0]![1].method).toBe('POST')
    expect(calls[0]![1].credentials).toBe('include')
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ reason: '기기 분실' })
    expect(new URL(calls[1]![0]).pathname).toBe('/api/v1/admin/accounts/11/unsuspend')

    await expect(repository.act(1, 'suspend', '테스트')).resolves.toEqual({ outcome: 'self-action' })
    await expect(repository.act(2, 'suspend', '테스트')).resolves.toEqual({ outcome: 'protected' })
    await expect(repository.act(11, 'suspend', '테스트')).resolves.toEqual({ outcome: 'conflict' })
    await expect(repository.act(99, 'suspend', '테스트')).resolves.toEqual({ outcome: 'not-found' })
    await expect(repository.act(11, 'suspend', '테스트')).rejects.toBeInstanceOf(AccountApiError)
  })

  it('posts the new role with the reason for admin grants and revokes and maps the last-admin refusal', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(detailDto))
      .mockResolvedValueOnce(jsonResponse({ code: 'ADMIN_LAST_ACTIVE_ADMIN' }, 422))
    vi.stubGlobal('fetch', fetchMock)
    const repository = new AdminAccountRepositoryImpl()

    await expect(repository.act(11, 'grant-admin', '운영 담당 추가')).resolves.toMatchObject({ outcome: 'done' })
    await expect(repository.act(2, 'revoke-admin', '퇴사')).resolves.toEqual({ outcome: 'last-admin' })
    const calls = fetchMock.mock.calls as [string, RequestInit][]
    expect(new URL(calls[0]![0]).pathname).toBe('/api/v1/admin/accounts/11/role')
    expect(calls[0]![1].method).toBe('POST')
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ role: 'ADMIN', reason: '운영 담당 추가' })
    expect(new URL(calls[1]![0]).pathname).toBe('/api/v1/admin/accounts/2/role')
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ role: 'USER', reason: '퇴사' })
  })

  it('reads role change records in the action history', () => {
    const parsed = adminAccountDetailDtoSchema.parse({
      ...detailDto,
      actions: [
        { id: 4, action: 'ADMIN_GRANT', reason: '운영 담당 추가', adminEmail: 'admin@govbiz.local', createdAt: '2026-09-11T09:00:00' },
        { id: 5, action: 'ADMIN_REVOKE', reason: '퇴사', adminEmail: 'admin@govbiz.local', createdAt: '2026-09-12T09:00:00' },
      ],
    })
    expect(parsed.actions.map((action) => action.action)).toEqual(['ADMIN_GRANT', 'ADMIN_REVOKE'])
  })

  it('reads a missing account as null', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'ADMIN_ACCOUNT_NOT_FOUND' }, 404))
      .mockResolvedValueOnce(jsonResponse(detailDto)))
    const repository = new AdminAccountRepositoryImpl()

    await expect(repository.getDetail(99)).resolves.toBeNull()
    await expect(repository.getDetail(11)).resolves.toMatchObject({ account: { email: 'kakao@kakao.com', hasPassword: false } })
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
