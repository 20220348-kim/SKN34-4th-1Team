import { useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import type { PartnerRecruitmentSummary } from '../../../../domain/entities/PartnerRecruitment'
import { defaultPartnerRecruitmentQuery, type PartnerRecruitmentQuery } from '../../../../domain/entities/PartnerRecruitmentQuery'
import type { ClosePartnerRecruitmentUseCase } from '../../../../domain/usecases/PartnerRecruitmentUseCases'
import { useAuthSession } from '../../../shared/auth/hooks/useAuthSession'
import { usePartnerRecruitmentBrowse } from '../../../shared/partner-recruitment/usePartnerRecruitmentBrowse'
import { appPaths } from '../../../shared/routes/appPaths'
import { recruitmentCloseMessages } from './usePartnerRecruitmentDetailViewModel'

type CloseState =
  | { status: 'idle' }
  | { status: 'confirming'; recruitment: PartnerRecruitmentSummary }
  | { status: 'closing'; recruitment: PartnerRecruitmentSummary }
  | { status: 'failed'; recruitment: PartnerRecruitmentSummary; message: string }

/**
 * "내 모집글" 탭의 대표 ViewModel입니다. 내 글만 최근 등록순으로 읽고(검색·필터 없음), 마감된 글을 뒤로 보내며,
 * 카드에서 바로 마감할 수 있게 확인 상자와 마감 UseCase를 소유합니다. 마감하면 다시 읽지 않고 그 카드만 마감 상태로 바꿉니다.
 */
export function useMyPartnerRecruitmentsViewModel(
  closeUseCase: Pick<ClosePartnerRecruitmentUseCase, 'execute'> = appContainer.resolve('closePartnerRecruitmentUseCase'),
) {
  const { hasCompany } = useAuthSession()
  const [page, setPage] = useState(1)
  const query: PartnerRecruitmentQuery = { ...defaultPartnerRecruitmentQuery, mineOnly: true, sort: 'RECENT', page }
  const { phase, page: result, retry } = usePartnerRecruitmentBrowse(query)
  const [closedIds, setClosedIds] = useState<ReadonlySet<number>>(new Set())
  const [closeState, setCloseState] = useState<CloseState>({ status: 'idle' })

  const recruitments = (result?.recruitments ?? [])
    .map((recruitment) => (closedIds.has(recruitment.id) ? { ...recruitment, status: 'CLOSED' as const } : recruitment))
    // 모집 중인 글이 먼저, 마감된 글은 뒤로. 같은 묶음 안에서는 서버 순서(최근 등록순)를 지킵니다.
    .sort((a, b) => Number(a.status === 'CLOSED') - Number(b.status === 'CLOSED'))

  async function confirmClose() {
    if (closeState.status !== 'confirming' && closeState.status !== 'failed') return
    const target = closeState.recruitment
    setCloseState({ status: 'closing', recruitment: target })
    try {
      const outcome = await closeUseCase.execute(target.id)
      switch (outcome.outcome) {
        case 'closed':
          setClosedIds((current) => new Set([...current, target.id]))
          setCloseState({ status: 'idle' })
          return
        case 'already-closed':
          setClosedIds((current) => new Set([...current, target.id]))
          setCloseState({ status: 'failed', recruitment: target, message: recruitmentCloseMessages.alreadyClosed })
          return
        case 'forbidden':
          setCloseState({ status: 'failed', recruitment: target, message: recruitmentCloseMessages.notMine })
          return
        case 'not-found':
          setCloseState({ status: 'failed', recruitment: target, message: recruitmentCloseMessages.notFound })
          return
      }
    } catch {
      setCloseState({ status: 'failed', recruitment: target, message: recruitmentCloseMessages.failed })
    }
  }

  return {
    hasCompany,
    phase,
    recruitments,
    total: result?.total ?? 0,
    totalPages: result?.totalPages ?? 0,
    page,
    goToPage: setPage,
    retry,
    createPath: hasCompany ? appPaths.partnerNew : appPaths.profile,
    detailPathFor: (id: number) => `${appPaths.partnerDetail}?${new URLSearchParams({ recruitmentId: String(id) })}`,
    editPathFor: (id: number) => `${appPaths.partnerEdit}?${new URLSearchParams({ recruitmentId: String(id) })}`,
    /** 확인 상자에 이름을 보여 주려고 마감할 글을 함께 둡니다. */
    closingRecruitment: closeState.status === 'idle' ? null : closeState.recruitment,
    isClosing: closeState.status === 'closing',
    closeError: closeState.status === 'failed' ? closeState.message : null,
    openCloseConfirm: (recruitment: PartnerRecruitmentSummary) => setCloseState({ status: 'confirming', recruitment }),
    cancelClose: () => setCloseState({ status: 'idle' }),
    confirmClose,
  }
}
