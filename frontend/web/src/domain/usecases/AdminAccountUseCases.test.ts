import { describe, expect, it, vi } from 'vitest'

import { availableAdminAccountActions, defaultAdminAccountQuery, type AdminAccountDetail } from '../entities/AdminAccount'
import { BrowseAdminAccountsUseCase, GetAdminAccountDetailUseCase, TakeAdminAccountActionUseCase } from './AdminAccountUseCases'

const detail: AdminAccountDetail = {
  account: {
    id: 11,
    email: 'member@company.co.kr',
    role: 'USER',
    tier: 'MEMBER',
    status: 'ACTIVE',
    emailVerified: true,
    hasPassword: true,
    loginMethods: ['EMAIL'],
    company: null,
    createdAt: '2026-09-01T10:00:00',
    lastLoginAt: null,
    suspendedAt: null,
  },
  company: null,
  activity: { recruitmentCount: 0, openRecruitmentCount: 0, sentProposalCount: 0, activeSessionCount: 1 },
  actions: [],
  isSelf: false,
}

describe('AdminAccountUseCases', () => {
  it('trims the keyword and falls back to the first page', async () => {
    const browse = vi.fn().mockResolvedValue({ accounts: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })

    await new BrowseAdminAccountsUseCase({ browse }).execute({ ...defaultAdminAccountQuery, keyword: ' kakao ', page: 0 })

    expect(browse).toHaveBeenCalledWith({ ...defaultAdminAccountQuery, keyword: 'kakao', page: 1 }, undefined)
  })

  it('refuses invalid ids and empty or overlong reasons before calling the server', async () => {
    const act = vi.fn().mockResolvedValue({ outcome: 'done', detail })
    const useCase = new TakeAdminAccountActionUseCase({ act })

    expect(() => useCase.execute(0, 'suspend', '사유')).toThrow(RangeError)
    expect(() => useCase.execute(11, 'suspend', '   ')).toThrow(RangeError)
    expect(() => useCase.execute(11, 'suspend', '가'.repeat(501))).toThrow(RangeError)
    expect(act).not.toHaveBeenCalled()

    await useCase.execute(11, 'revoke-sessions', '  기기 분실 ')
    expect(act).toHaveBeenCalledWith(11, 'revoke-sessions', '기기 분실', undefined)
    expect(() => new GetAdminAccountDetailUseCase({ getDetail: vi.fn() }).execute(1.5)).toThrow(RangeError)
  })

  it('offers suspension for active members, only unsuspension for suspended ones, and nothing for admins or yourself', () => {
    expect(availableAdminAccountActions(detail)).toEqual(['suspend', 'revoke-sessions'])
    expect(availableAdminAccountActions({ ...detail, account: { ...detail.account, status: 'SUSPENDED' } })).toEqual(['unsuspend'])
    expect(availableAdminAccountActions({ ...detail, account: { ...detail.account, role: 'ADMIN', tier: 'ADMIN' } })).toEqual([])
    expect(availableAdminAccountActions({ ...detail, isSelf: true })).toEqual([])
  })
})
