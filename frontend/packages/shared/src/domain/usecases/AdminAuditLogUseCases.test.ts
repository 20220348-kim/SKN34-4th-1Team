import { describe, expect, it, vi } from 'vitest'

import { adminAuditLogListDtoSchema, toAdminAuditLogPage } from '../../data/models/AdminAuditLogDto'
import { adminAuditLogQueryIssue, defaultAdminAuditLogQuery, isAdminAuditDate } from '../entities/AdminAuditLog'
import { BrowseAdminAuditLogsUseCase } from './AdminAuditLogUseCases'

const recordDto = {
  id: 42,
  action: 'ACCOUNT_DETAIL',
  actorAccountId: 1,
  actorEmail: 'admin@govbiz.local',
  targetAccountId: 11,
  requestSummary: null,
  clientIp: '198.51.100.7',
  userAgent: 'Mozilla/5.0',
  createdAt: '2026-09-06T12:00:00.123456',
}

describe('감사 기록 조건', () => {
  it('달력에 있는 yyyy-MM-dd 날짜만 받는다', () => {
    expect(isAdminAuditDate('2026-09-30')).toBe(true)
    expect(isAdminAuditDate('2028-02-29')).toBe(true)
    expect(isAdminAuditDate('2026-02-30')).toBe(false)
    expect(isAdminAuditDate('2026-9-1')).toBe(false)
    expect(isAdminAuditDate('20260901')).toBe(false)
  })

  it('잘못된 계정 ID·날짜와 거꾸로 된 기간을 찾는다', () => {
    expect(adminAuditLogQueryIssue(defaultAdminAuditLogQuery)).toBeNull()
    expect(adminAuditLogQueryIssue({ ...defaultAdminAuditLogQuery, actorAccountId: 0 })).toBe('invalid-account-id')
    expect(adminAuditLogQueryIssue({ ...defaultAdminAuditLogQuery, targetAccountId: 1.5 })).toBe('invalid-account-id')
    expect(adminAuditLogQueryIssue({ ...defaultAdminAuditLogQuery, from: '2026-13-01' })).toBe('invalid-date')
    expect(adminAuditLogQueryIssue({ ...defaultAdminAuditLogQuery, from: '2026-09-30', to: '2026-09-01' })).toBe('reversed-period')
    // 같은 날 하루만 보는 기간은 괜찮습니다.
    expect(adminAuditLogQueryIssue({ ...defaultAdminAuditLogQuery, from: '2026-09-01', to: '2026-09-01' })).toBeNull()
  })
})

describe('BrowseAdminAuditLogsUseCase', () => {
  it('올바른 조건과 커서만 Repository로 넘긴다', async () => {
    const browse = vi.fn().mockResolvedValue({ records: [], nextCursor: null })
    const useCase = new BrowseAdminAuditLogsUseCase({ browse })
    const query = { ...defaultAdminAuditLogQuery, targetAccountId: 11, from: '2026-09-01', to: '2026-09-30' }

    await useCase.execute(query, 120)
    expect(browse).toHaveBeenCalledWith(query, 120, undefined)

    expect(() => useCase.execute({ ...query, from: '2026-10-01' })).toThrow(RangeError)
    expect(() => useCase.execute(query, 0)).toThrow(RangeError)
    expect(browse).toHaveBeenCalledTimes(1)
  })
})

describe('AdminAuditLogDto', () => {
  it('서버 응답을 검증해 복사하고, 모르는 작업이나 빈 접속 주소는 거절한다', () => {
    const page = toAdminAuditLogPage(adminAuditLogListDtoSchema.parse({ records: [recordDto], nextCursor: 41 }))

    expect(page).toEqual({ records: [recordDto], nextCursor: 41 })
    expect(page.records[0]).not.toBe(recordDto)
    expect(adminAuditLogListDtoSchema.safeParse({ records: [{ ...recordDto, action: 'ACCOUNT_DELETE' }], nextCursor: null }).success).toBe(false)
    expect(adminAuditLogListDtoSchema.safeParse({ records: [{ ...recordDto, clientIp: '' }], nextCursor: null }).success).toBe(false)
    expect(adminAuditLogListDtoSchema.safeParse({ records: [{ ...recordDto, actorEmail: null, userAgent: null }], nextCursor: null }).success).toBe(true)
  })
})
