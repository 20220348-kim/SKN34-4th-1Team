import { useEffect } from 'react'

import { appContainer } from '../../../app/appContainer'
import { useAppDispatch, useAppSelector } from '../../../app/hooks'
import type { AppDispatch, RootState } from '../../../app/store'
import type { PartnerProposal } from '../../../domain/entities/PartnerProposal'
import type { BrowsePartnerProposalsUseCase } from '../../../domain/usecases/PartnerProposalUseCases'
import { useAuthSession } from '../auth/hooks/useAuthSession'
import {
  receivedProposalsLoadFailed,
  receivedProposalsLoadStarted,
  receivedProposalsLoaded,
  selectPendingReceivedCount,
  selectReceivedProposals,
  selectReceivedProposalsAccountEmail,
  selectReceivedProposalsPhase,
} from './state/receivedProposalsSlice'

type BrowseUseCase = Pick<BrowsePartnerProposalsUseCase, 'execute'>

/**
 * 받은 제안함을 한 번만 읽어 Redux에 두는 thunk입니다. 이미 같은 계정의 상자를 읽었거나 읽는 중이면 다시 요청하지 않고,
 * `force`는 처리 실패 뒤 목록을 새로 읽을 때 씁니다. 응답이 돌아왔을 때 계정이 바뀌었으면 버립니다.
 */
export function loadReceivedProposals(useCase: BrowseUseCase, accountEmail: string, force = false) {
  return (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    const current = getState().receivedProposals
    if (!force && current.accountEmail === accountEmail && (current.phase === 'loading' || current.phase === 'ready')) {
      return Promise.resolve()
    }
    dispatch(receivedProposalsLoadStarted({ accountEmail }))
    return Promise.resolve()
      .then(() => useCase.execute('received'))
      .then((page) => { dispatch(receivedProposalsLoaded({ accountEmail, page })) })
      .catch(() => { dispatch(receivedProposalsLoadFailed({ accountEmail })) })
  }
}

export type ReceivedProposalsView = {
  /** 기업이 없는 회원은 요청하지 않고 빈 상자로 `ready`입니다. */
  phase: 'loading' | 'ready' | 'failed'
  proposals: PartnerProposal[]
  pendingCount: number
  reload: () => void
}

/**
 * 사이드바 배지·제안함 화면·모집글 상세가 함께 쓰는 받은 제안함입니다. 어디서 먼저 부르든 계정당 한 번만 조회하고,
 * 제안함 화면의 수락·거절은 slice를 바꿔 세 곳에 함께 반영됩니다. 특정 페이지의 ViewModel이 아니므로 shared에 둡니다.
 */
export function useReceivedProposals(
  useCase: BrowseUseCase = appContainer.resolve('browsePartnerProposalsUseCase'),
): ReceivedProposalsView {
  const dispatchToStore = useAppDispatch()
  const { account, hasCompany } = useAuthSession()
  const accountEmail = account?.email ?? null
  const phase = useAppSelector(selectReceivedProposalsPhase)
  const loadedAccountEmail = useAppSelector(selectReceivedProposalsAccountEmail)
  const proposals = useAppSelector(selectReceivedProposals)
  const pendingCount = useAppSelector(selectPendingReceivedCount)

  useEffect(() => {
    if (accountEmail === null || !hasCompany) return
    void dispatchToStore(loadReceivedProposals(useCase, accountEmail))
  }, [accountEmail, hasCompany, dispatchToStore, useCase])

  if (accountEmail === null || !hasCompany) {
    return { phase: 'ready', proposals: [], pendingCount: 0, reload: () => undefined }
  }
  const isCurrent = loadedAccountEmail === accountEmail && phase !== 'idle'
  return {
    phase: isCurrent ? (phase === 'failed' ? 'failed' : phase === 'ready' ? 'ready' : 'loading') : 'loading',
    proposals: isCurrent ? proposals : [],
    pendingCount: isCurrent ? pendingCount : 0,
    reload: () => { void dispatchToStore(loadReceivedProposals(useCase, accountEmail, true)) },
  }
}

/** 사이드바 배지용 받은 제안 대기 건수입니다. 0이면 null을 돌려줘 배지를 그리지 않습니다. */
export function usePendingReceivedProposalCount(): number | null {
  const { pendingCount } = useReceivedProposals()
  return pendingCount > 0 ? pendingCount : null
}
