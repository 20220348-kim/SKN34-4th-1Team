import { useEffect, useRef, useState } from 'react'
import { useStore } from 'react-redux'
import { useLocation, useNavigate } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import { useAppSelector } from '../../../../app/hooks'
import type { AppStore, RootState } from '../../../../app/store'
import { SupportProgramSearchRestoreError } from '../../../../domain/errors/SupportProgramSearchRestoreError'
import type { RestoreSupportProgramSearchUseCase } from '../../../../domain/usecases/RestoreSupportProgramSearchUseCase'
import { selectAuthStatus, selectCurrentAccount } from '../../../shared/auth/state/authSlice'
import { appPaths } from '../../../shared/routes/appPaths'
import { searchResultRestored, searchResultRestoreFailed } from '../state/chatSlice'

export const searchResultRestoreMessages = {
  expired: '이전 검색 결과의 보관 시간이 지났거나 불러올 수 없는 결과입니다. 원하는 조건으로 다시 검색해 주세요.',
  unauthorized: '이전 검색 결과를 보려면 로그인이 필요합니다. 다시 로그인해 주세요.',
  unavailable: '이전 검색 결과를 불러오지 못했습니다. 잠시 후 원하는 조건으로 다시 검색해 주세요.',
} as const

type PendingRestore = {
  resultToken: string
  accountEmail: string
  chat: RootState['chat']
  invalidated: boolean
}

/** 가입·로그인 뒤 선택한 검색 결과만 복원하며 입력·계정·화면이 바뀌면 이전 복원을 폐기합니다. */
export function useRestoreSupportProgramSearch(
  restoreUseCase: Pick<RestoreSupportProgramSearchUseCase, 'execute'> = appContainer.resolve('restoreSupportProgramSearchUseCase'),
) {
  const store = useStore() as AppStore
  const authStatus = useAppSelector(selectAuthStatus)
  const accountEmail = useAppSelector(selectCurrentAccount)?.email ?? null
  const location = useLocation()
  const navigate = useNavigate()
  const path = location.pathname.replace(/\/+$/, '')
  const consumed = useRef<{ resultToken: string; accountEmail: string } | null>(null)
  const [pending, setPending] = useState<PendingRestore | null>(null)

  useEffect(() => {
    if (authStatus !== 'authenticated' || accountEmail === null || path !== appPaths.chat) return
    const params = new URLSearchParams(location.search)
    if (!params.has('searchResult')) {
      consumed.current = null
      return
    }
    const resultToken = params.get('searchResult') ?? ''
    const duplicateParameter = params.getAll('searchResult').length !== 1
    params.delete('searchResult')
    const search = params.toString()
    // 즉시 주소에서 제거해 로그아웃 후 다른 계정의 복귀 경로에 토큰이 붙지 않게 합니다.
    void navigate({ pathname: location.pathname, search: search ? '?' + search : '', hash: location.hash }, { replace: true })
    if (consumed.current?.resultToken === resultToken && consumed.current.accountEmail === accountEmail) return
    consumed.current = { resultToken, accountEmail }
    if (duplicateParameter || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resultToken)) {
      store.dispatch(searchResultRestoreFailed(searchResultRestoreMessages.expired))
      return
    }
    setPending({ resultToken, accountEmail, chat: store.getState().chat, invalidated: false })
  }, [accountEmail, authStatus, location.hash, location.pathname, location.search, navigate, path, store])

  useEffect(() => {
    if (!pending) return
    if (pending.invalidated || authStatus !== 'authenticated' || accountEmail !== pending.accountEmail || path !== appPaths.chat) {
      pending.invalidated = true
      return
    }
    const controller = new AbortController()
    let active = true
    let started = false
    const isCurrent = () => {
      const state = store.getState()
      return state.auth.status === 'authenticated' && state.auth.account?.email === pending.accountEmail
        && state.chat === pending.chat
    }
    if (!isCurrent()) {
      pending.invalidated = true
      return
    }
    const unsubscribe = store.subscribe(() => {
      if (isCurrent()) return
      active = false
      pending.invalidated = true
      controller.abort()
      unsubscribe()
    })

    // StrictMode의 첫 setup/cleanup에서는 HTTP 호출 전에 취소되고 마지막 setup만 실행됩니다.
    void Promise.resolve().then(async () => {
      if (!active || pending.invalidated) return
      started = true
      try {
        const restored = await restoreUseCase.execute(pending.resultToken, controller.signal)
        if (!active || controller.signal.aborted || !isCurrent()) return
        unsubscribe()
        store.dispatch(searchResultRestored(restored))
      } catch (error) {
        if (!active || controller.signal.aborted || !isCurrent()) return
        unsubscribe()
        const reason = error instanceof SupportProgramSearchRestoreError ? error.reason : 'unavailable'
        store.dispatch(searchResultRestoreFailed(searchResultRestoreMessages[reason]))
      } finally {
        unsubscribe()
        if (active) setPending((current) => current === pending ? null : current)
      }
    })

    return () => {
      active = false
      if (started) pending.invalidated = true
      unsubscribe()
      controller.abort()
    }
  }, [accountEmail, authStatus, path, pending, restoreUseCase, store])
}