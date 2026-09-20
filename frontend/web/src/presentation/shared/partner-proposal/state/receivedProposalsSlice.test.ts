import { describe, expect, it, vi } from 'vitest'

import { createAppStore } from '../../../../app/store'
import { receivedAcceptedProposal, receivedPendingProposal, receivedProposalBox } from '../../../../data/fixtures/partnerProposals'
import type { Account } from '../../../../domain/entities/Account'
import { sessionRestored, signedIn, signedOut } from '../../auth/state/authSlice'
import { loadReceivedProposals } from '../useReceivedProposals'
import {
  receivedProposalUpdated,
  receivedProposalsLoaded,
  selectPendingReceivedCount,
  selectReceivedProposals,
  selectReceivedProposalsPhase,
} from './receivedProposalsSlice'

const email = 'company@example.test'
const companyAccount: Account = {
  email,
  role: 'USER',
  tier: 'COMPANY',
  emailVerified: false,
  hasPassword: true,
  company: { companyName: '데이터브릿지 주식회사', businessNumber: '1248100998' },
}

describe('receivedProposalsSlice', () => {
  it('loads the box once per account and keeps the pending count in step with accept and decline', async () => {
    const store = createAppStore()
    const execute = vi.fn().mockResolvedValue(receivedProposalBox)

    await store.dispatch(loadReceivedProposals({ execute }, email))
    await store.dispatch(loadReceivedProposals({ execute }, email))
    expect(execute).toHaveBeenCalledTimes(1)
    expect(selectReceivedProposalsPhase(store.getState())).toBe('ready')
    expect(selectPendingReceivedCount(store.getState())).toBe(1)

    store.dispatch(receivedProposalUpdated({ ...receivedPendingProposal, status: 'ACCEPTED' }))
    expect(selectPendingReceivedCount(store.getState())).toBe(0)
    expect(selectReceivedProposals(store.getState()).find((proposal) => proposal.id === receivedPendingProposal.id)?.status).toBe('ACCEPTED')

    // 목록에 없는 제안은 무시하고, force 재조회는 다시 요청합니다.
    store.dispatch(receivedProposalUpdated({ ...receivedAcceptedProposal, id: 999 }))
    expect(selectReceivedProposals(store.getState())).toHaveLength(2)
    await store.dispatch(loadReceivedProposals({ execute }, email, true))
    expect(execute).toHaveBeenCalledTimes(2)
    expect(selectPendingReceivedCount(store.getState())).toBe(1)
  })

  it('drops the box on logout or when a different account signs in, and ignores stale responses', async () => {
    const store = createAppStore()
    store.dispatch(receivedProposalsLoaded({ accountEmail: email, page: receivedProposalBox }))
    expect(selectReceivedProposalsPhase(store.getState())).toBe('idle')

    await store.dispatch(loadReceivedProposals({ execute: vi.fn().mockResolvedValue(receivedProposalBox) }, email))
    store.dispatch(sessionRestored({ ...companyAccount, email }))
    expect(selectReceivedProposalsPhase(store.getState())).toBe('ready')

    store.dispatch(signedIn({ ...companyAccount, email: 'other@example.test' }))
    expect(selectReceivedProposalsPhase(store.getState())).toBe('idle')
    expect(selectReceivedProposals(store.getState())).toEqual([])

    await store.dispatch(loadReceivedProposals({ execute: vi.fn().mockRejectedValue(new Error('down')) }, email))
    expect(selectReceivedProposalsPhase(store.getState())).toBe('failed')
    // 실패한 상자는 다음 호출에서 다시 읽습니다.
    const retry = vi.fn().mockResolvedValue(receivedProposalBox)
    await store.dispatch(loadReceivedProposals({ execute: retry }, email))
    expect(retry).toHaveBeenCalledTimes(1)

    store.dispatch(signedOut())
    expect(selectReceivedProposalsPhase(store.getState())).toBe('idle')
    expect(selectPendingReceivedCount(store.getState())).toBe(0)
  })
})
