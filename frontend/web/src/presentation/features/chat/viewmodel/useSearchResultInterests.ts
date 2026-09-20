import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import { useAppSelector } from '../../../../app/hooks'
import type { SupportProgramIdentity } from '../../../../domain/repositories/SupportProgramRepository'
import { selectCurrentAccount, selectIsAuthenticated } from '../../../shared/auth/state/authSlice'

export function searchResultInterestKey(identity: SupportProgramIdentity): string {
  return JSON.stringify([identity.sourceCode, identity.sourceProgramId])
}

export const searchResultInterestMessages = {
  loadFailed: '관심 공고 상태를 불러오지 못했습니다. 다시 시도해 주세요.',
  saveFailed: '관심 공고 변경에 실패했습니다. 잠시 후 다시 시도해 주세요.',
  notFound: '더 이상 제공되지 않는 공고라 관심 공고에 담을 수 없습니다.',
} as const

type InterestState = {
  accountEmail: string | null
  phase: 'loading' | 'ready' | 'failed'
  savedKeys: Set<string>
  pendingKeys: Set<string>
  errors: Record<string, string>
}

function emptyState(accountEmail: string | null): InterestState {
  return { accountEmail, phase: 'loading', savedKeys: new Set(), pendingKeys: new Set(), errors: {} }
}

/** 한 대화의 여러 결과에 같은 공고가 나와도 관심 상태와 진행 중인 변경을 함께 사용합니다. */
export function useSearchResultInterests(hasResults: boolean) {
  const isAuthenticated = useAppSelector(selectIsAuthenticated)
  const accountEmail = useAppSelector(selectCurrentAccount)?.email ?? null
  const browse = appContainer.resolve('browseSavedSupportProgramsUseCase')
  const save = appContainer.resolve('saveSupportProgramUseCase')
  const remove = appContainer.resolve('removeSavedSupportProgramUseCase')
  const [state, setState] = useState<InterestState>(() => emptyState(null))
  const [version, setVersion] = useState(0)
  const requestRef = useRef<{ controller: AbortController; pending: Set<string> } | null>(null)

  useEffect(() => {
    if (!isAuthenticated || !accountEmail || !hasResults) return
    const controller = new AbortController()
    const request = { controller, pending: new Set<string>() }
    requestRef.current = request
    setState(emptyState(accountEmail))
    void browse.execute(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return
        setState({ ...emptyState(accountEmail), phase: 'ready', savedKeys: new Set(items.map(({ program }) =>
          searchResultInterestKey({ sourceCode: program.sourceCode, sourceProgramId: program.id }))) })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ ...emptyState(accountEmail), phase: 'failed' })
      })
    return () => {
      controller.abort()
      requestRef.current = null
    }
  }, [accountEmail, isAuthenticated, hasResults, browse, version])

  const toggle = useCallback(async (identity: SupportProgramIdentity) => {
    const request = requestRef.current
    const key = searchResultInterestKey(identity)
    if (!isAuthenticated || state.accountEmail !== accountEmail || state.phase !== 'ready'
      || !request || request.controller.signal.aborted || request.pending.has(key)) return
    // React의 다음 렌더 전 연속 클릭도 같은 요청을 중복 전송하지 않습니다.
    request.pending.add(key)
    setState((current) => ({ ...current, pendingKeys: new Set(request.pending), errors: { ...current.errors, [key]: '' } }))
    try {
      const wasSaved = state.savedKeys.has(key)
      if (wasSaved) {
        await remove.execute(identity, request.controller.signal)
      } else {
        const result = await save.execute(identity, request.controller.signal)
        if (request.controller.signal.aborted) return
        if (result.outcome === 'not-found') {
          setState((current) => ({ ...current, errors: { ...current.errors, [key]: searchResultInterestMessages.notFound } }))
          return
        }
      }
      if (request.controller.signal.aborted) return
      setState((current) => {
        const savedKeys = new Set(current.savedKeys)
        if (wasSaved) savedKeys.delete(key)
        else savedKeys.add(key)
        return { ...current, savedKeys }
      })
    } catch {
      if (!request.controller.signal.aborted) {
        setState((current) => ({ ...current, errors: { ...current.errors, [key]: searchResultInterestMessages.saveFailed } }))
      }
    } finally {
      request.pending.delete(key)
      if (!request.controller.signal.aborted) setState((current) => ({ ...current, pendingKeys: new Set(request.pending) }))
    }
  }, [accountEmail, isAuthenticated, state.accountEmail, state.phase, state.savedKeys, save, remove])

  const retry = useCallback(() => setVersion((current) => current + 1), [])
  // 입력 초안만 바뀔 때는 memo 처리된 기존 결과 카드가 다시 렌더되지 않게 참조를 유지합니다.
  return useMemo(() => {
    if (!isAuthenticated || !hasResults) return null
    const current = state.accountEmail === accountEmail ? state : emptyState(accountEmail)
    return { ...current, toggle, retry }
  }, [accountEmail, hasResults, isAuthenticated, state, toggle, retry])
}

export type SearchResultInterests = NonNullable<ReturnType<typeof useSearchResultInterests>>
