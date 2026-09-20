import { useEffect, useState } from 'react'

import { appContainer } from '../../../app/appContainer'
import type { PartnerProposalBoxPage } from '../../../domain/entities/PartnerProposal'
import type { BrowsePartnerProposalsUseCase } from '../../../domain/usecases/PartnerProposalUseCases'
import { useAuthSession } from '../auth/hooks/useAuthSession'

export type SentProposalBoxState =
  | { phase: 'loading'; page: PartnerProposalBoxPage | null }
  | { phase: 'ready'; page: PartnerProposalBoxPage }
  | { phase: 'failed'; page: PartnerProposalBoxPage | null }

/**
 * 보낸 제안함입니다. 제안함 화면의 보낸 탭만 읽으므로 Redux가 아니라 Hook 로컬 상태로 두고, 탭을 열었을 때(`enabled`)만 요청합니다.
 * 기업을 등록한 회원만 제안을 보내므로 등록 전에는 요청하지 않고 빈 상자로 둡니다.
 */
export function useSentProposalBox(
  enabled: boolean,
  useCase: Pick<BrowsePartnerProposalsUseCase, 'execute'> = appContainer.resolve('browsePartnerProposalsUseCase'),
) {
  const { hasCompany } = useAuthSession()
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<SentProposalBoxState>({ phase: 'loading', page: null })

  useEffect(() => {
    if (!enabled) return
    if (!hasCompany) {
      setState({ phase: 'ready', page: { box: 'sent', proposals: [], pendingCount: 0 } })
      return
    }
    const controller = new AbortController()
    let current = true
    setState((previous) => ({ phase: 'loading', page: previous.page }))
    void Promise.resolve().then(() => useCase.execute('sent', controller.signal))
      .then((page) => { if (current && !controller.signal.aborted) setState({ phase: 'ready', page }) })
      .catch(() => { if (current && !controller.signal.aborted) setState((previous) => ({ phase: 'failed', page: previous.page })) })
    return () => { current = false; controller.abort() }
  }, [enabled, hasCompany, version, useCase])

  return {
    phase: state.phase,
    page: state.page,
    reload: () => setVersion((value) => value + 1),
  }
}
