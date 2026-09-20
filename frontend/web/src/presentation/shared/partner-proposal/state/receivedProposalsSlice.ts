import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

import type { RootState } from '../../../../app/store'
import type { PartnerProposal, PartnerProposalBoxPage } from '../../../../domain/entities/PartnerProposal'
import { sessionRestored, signedIn, signedOut } from '../../auth/state/authSlice'

export type ReceivedProposalsPhase = 'idle' | 'loading' | 'ready' | 'failed'

/**
 * 받은 제안함의 서버 사본입니다. 사이드바 배지·제안함 화면·모집글 상세가 함께 읽고 제안함 화면이 수락·거절로 바꾸므로
 * Hook 로컬이 아니라 Redux에 둡니다. `accountEmail`은 어느 계정의 상자인지(계정 식별자는 이메일)이며 다른 계정으로 바뀌면 비웁니다.
 */
type ReceivedProposalsState = {
  phase: ReceivedProposalsPhase
  accountEmail: string | null
  proposals: PartnerProposal[]
  pendingCount: number
}

const initialState: ReceivedProposalsState = {
  phase: 'idle',
  accountEmail: null,
  proposals: [],
  pendingCount: 0,
}

function countPending(proposals: readonly PartnerProposal[]): number {
  return proposals.filter((proposal) => proposal.status === 'PENDING').length
}

const receivedProposalsSlice = createSlice({
  name: 'receivedProposals',
  initialState,
  reducers: {
    receivedProposalsLoadStarted(state, action: PayloadAction<{ accountEmail: string }>) {
      if (state.accountEmail !== action.payload.accountEmail) {
        state.proposals = []
        state.pendingCount = 0
      }
      state.accountEmail = action.payload.accountEmail
      state.phase = 'loading'
    },
    receivedProposalsLoaded(state, action: PayloadAction<{ accountEmail: string; page: PartnerProposalBoxPage }>) {
      if (state.accountEmail !== action.payload.accountEmail) return
      state.phase = 'ready'
      state.proposals = action.payload.page.proposals
      state.pendingCount = action.payload.page.pendingCount
    },
    receivedProposalsLoadFailed(state, action: PayloadAction<{ accountEmail: string }>) {
      if (state.accountEmail !== action.payload.accountEmail) return
      state.phase = 'failed'
    },
    /** 수락·거절 응답으로 돌아온 제안 하나를 바꾸고 대기 건수를 다시 셉니다. 목록에 없는 제안은 무시합니다. */
    receivedProposalUpdated(state, action: PayloadAction<PartnerProposal>) {
      const index = state.proposals.findIndex((proposal) => proposal.id === action.payload.id)
      if (index === -1) return
      state.proposals[index] = action.payload
      state.pendingCount = countPending(state.proposals)
    },
    receivedProposalsCleared() {
      return initialState
    },
  },
  extraReducers: (builder) => {
    // 로그아웃하거나 다른 계정으로 바뀌면 이전 계정의 상자를 남기지 않습니다.
    builder
      .addCase(signedOut, () => initialState)
      .addCase(signedIn, (state, action) => (state.accountEmail === action.payload.email ? state : initialState))
      .addCase(sessionRestored, (state, action) => (action.payload !== null && state.accountEmail === action.payload.email ? state : initialState))
  },
})

export const {
  receivedProposalsLoadStarted,
  receivedProposalsLoaded,
  receivedProposalsLoadFailed,
  receivedProposalUpdated,
  receivedProposalsCleared,
} = receivedProposalsSlice.actions

export const selectReceivedProposalsPhase = (state: RootState) => state.receivedProposals.phase
export const selectReceivedProposalsAccountEmail = (state: RootState) => state.receivedProposals.accountEmail
export const selectReceivedProposals = (state: RootState) => state.receivedProposals.proposals
export const selectPendingReceivedCount = (state: RootState) => state.receivedProposals.pendingCount

export default receivedProposalsSlice.reducer
