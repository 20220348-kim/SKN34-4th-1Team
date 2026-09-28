import { useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch } from '../../../../app/hooks'
import { partnerProposalStatusLabels, type PartnerProposal, type PartnerProposalBox, type PartnerProposalStatus } from '../../../../domain/entities/PartnerProposal'
import type { PartnerProposalAction } from '../../../../domain/repositories/PartnerProposalRepository'
import type { RespondPartnerProposalUseCase } from '../../../../domain/usecases/PartnerProposalUseCases'
import { useAuthSession } from '../../../shared/auth/hooks/useAuthSession'
import { receivedProposalUpdated } from '../../../shared/partner-proposal/state/receivedProposalsSlice'
import { useReceivedProposals } from '../../../shared/partner-proposal/useReceivedProposals'
import { useSentProposalBox } from '../../../shared/partner-proposal/useSentProposalBox'
import { appPaths } from '../../../shared/routes/appPaths'

export const proposalBoxMessages = {
  notPending: '이미 처리됐거나 만료된 제안입니다. 목록을 새로 고쳤습니다.',
  forbidden: '이 제안을 처리할 권한이 없습니다.',
  notFound: '제안을 찾을 수 없습니다. 목록을 새로 고쳤습니다.',
  failed: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
} as const

export const proposalActionLabels: Record<PartnerProposalAction, string> = {
  accept: '수락',
  decline: '거절',
  withdraw: '철회',
}

/** 확인 모달의 제목입니다. */
export const proposalActionTitles: Record<PartnerProposalAction, string> = {
  accept: '제안을 수락할까요?',
  decline: '제안을 거절할까요?',
  withdraw: '제안을 철회할까요?',
}

/** 처리 전에 한 번 더 묻는 문구입니다. 수락은 담당자 이메일이 공개되므로 그 사실을 알립니다. */
export const proposalActionConfirmations: Record<PartnerProposalAction, string> = {
  accept: '수락하면 양쪽 담당자 이메일과 기업 기본정보가 서로에게 공개됩니다.',
  decline: '거절하면 되돌릴 수 없고 상대는 이 모집글에 다시 제안할 수 없습니다.',
  withdraw: '철회하면 이 모집글에 다시 제안할 수 없습니다.',
}

/** 상태 칩입니다. "종료"는 거절·철회·만료를 한데 묶습니다. */
export type ProposalStatusFilter = 'all' | 'pending' | 'accepted' | 'closed'

const closedStatuses: PartnerProposalStatus[] = ['DECLINED', 'WITHDRAWN', 'EXPIRED']

export function matchesProposalStatusFilter(proposal: PartnerProposal, filter: ProposalStatusFilter): boolean {
  switch (filter) {
    case 'all': return true
    case 'pending': return proposal.status === 'PENDING'
    case 'accepted': return proposal.status === 'ACCEPTED'
    case 'closed': return closedStatuses.includes(proposal.status)
  }
}

type PendingConfirmation = { proposalId: number; action: PartnerProposalAction }

/**
 * 제안함의 대표 ViewModel입니다. 받은·보낸 상자, 상태 칩, 옆 패널에 연 제안, 확인 모달, 수락·거절·철회 요청과 안내를 소유합니다.
 * 받은 제안은 Redux 상자를 읽고 응답 결과를 slice에 반영해 사이드바 배지·모집글 상세와 함께 바뀌며,
 * 보낸 제안은 이 화면만 쓰므로 Hook 로컬 상자를 읽고 결과를 화면 안에서만 덮어씁니다. 처리할 수 없는 상태였으면 목록을 다시 읽습니다.
 */
export function usePartnerProposalBoxViewModel(
  respondUseCase: Pick<RespondPartnerProposalUseCase, 'execute'> = appContainer.resolve('respondPartnerProposalUseCase'),
) {
  const { hasCompany } = useAuthSession()
  const dispatchToStore = useAppDispatch()
  const [box, setBox] = useState<PartnerProposalBox>('received')
  const [statusFilter, setStatusFilter] = useState<ProposalStatusFilter>('all')
  const [selectedProposalId, setSelectedProposalId] = useState<number | null>(null)
  const received = useReceivedProposals()
  const sent = useSentProposalBox(box === 'sent')
  const [sentOverrides, setSentOverrides] = useState<Record<number, PartnerProposal>>({})
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const [busyProposalId, setBusyProposalId] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const allProposals = box === 'received'
    ? received.proposals
    : (sent.page?.proposals ?? []).map((proposal) => sentOverrides[proposal.id] ?? proposal)
  const proposals = allProposals.filter((proposal) => matchesProposalStatusFilter(proposal, statusFilter))
  const phase = box === 'received' ? received.phase : sent.phase
  // 받은 제안 탭의 대기 배지는 어느 탭을 보고 있든 받은 제안함의 대기 건수입니다. 보낸 제안함의 대기 건수(내가 보낸 뒤 응답을 기다리는 수)와 섞지 않습니다.
  const receivedPendingCount = received.pendingCount
  const selectedProposal = selectedProposalId === null ? null : allProposals.find((proposal) => proposal.id === selectedProposalId) ?? null

  function reloadActiveBox() {
    if (box === 'received') received.reload()
    else { setSentOverrides({}); sent.reload() }
  }

  function selectBox(next: PartnerProposalBox) {
    setBox(next)
    setStatusFilter('all')
    setSelectedProposalId(null)
    setConfirmation(null)
    setNotice(null)
  }

  async function confirmAction() {
    if (confirmation === null || busyProposalId !== null) return
    const { proposalId, action } = confirmation
    setBusyProposalId(proposalId)
    setNotice(null)
    try {
      const result = await respondUseCase.execute(proposalId, action)
      switch (result.outcome) {
        case 'updated':
          if (result.proposal.isSent) setSentOverrides((current) => ({ ...current, [proposalId]: result.proposal }))
          else dispatchToStore(receivedProposalUpdated(result.proposal))
          setConfirmation(null)
          return
        case 'not-pending':
          setNotice(proposalBoxMessages.notPending)
          break
        case 'forbidden':
          setNotice(proposalBoxMessages.forbidden)
          break
        case 'not-found':
          setNotice(proposalBoxMessages.notFound)
          break
      }
      setConfirmation(null)
      reloadActiveBox()
    } catch {
      setNotice(proposalBoxMessages.failed)
    } finally {
      setBusyProposalId(null)
    }
  }

  return {
    hasCompany,
    profilePath: appPaths.profile,
    partnersPath: appPaths.partners,
    box,
    selectBox,
    boxes: [
      { key: 'received' as const, label: receivedPendingCount > 0 ? `받은 제안 (${receivedPendingCount})` : '받은 제안' },
      { key: 'sent' as const, label: '보낸 제안' },
    ],
    statusFilter,
    selectStatusFilter: (next: ProposalStatusFilter) => { setStatusFilter(next); setSelectedProposalId(null) },
    statusFilters: (['all', 'pending', 'accepted', 'closed'] as const).map((key) => ({
      key,
      label: { all: '전체', pending: '응답 대기', accepted: '수락', closed: '종료' }[key],
      count: allProposals.filter((proposal) => matchesProposalStatusFilter(proposal, key)).length,
    })),
    phase,
    proposals,
    receivedPendingCount,
    reload: reloadActiveBox,
    /** 행을 누르면 옆 패널에 그 제안이 열립니다. */
    selectedProposal,
    selectProposal: (proposalId: number | null) => { setSelectedProposalId(proposalId); setConfirmation(null) },
    confirmation,
    /** 패널의 수락·거절·철회 버튼은 바로 보내지 않고 확인 모달을 엽니다. */
    requestAction: (proposalId: number, action: PartnerProposalAction) => { setConfirmation({ proposalId, action }); setNotice(null) },
    cancelAction: () => setConfirmation(null),
    confirmAction,
    busyProposalId,
    notice,
    dismissNotice: () => setNotice(null),
    statusLabel: (proposal: PartnerProposal) => partnerProposalStatusLabels[proposal.status],
    /** 받은 대기 제안은 수락·거절, 보낸 대기 제안은 철회할 수 있습니다. */
    availableActions: (proposal: PartnerProposal): PartnerProposalAction[] => {
      if (proposal.status !== 'PENDING') return []
      return proposal.isSent ? ['withdraw'] : ['accept', 'decline']
    },
    recruitmentPath: (proposal: PartnerProposal) =>
      `${appPaths.partnerDetail}?${new URLSearchParams({ recruitmentId: String(proposal.recruitment.id) })}`,
  }
}
