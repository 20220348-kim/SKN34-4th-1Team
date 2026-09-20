// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAppStore } from '../../../../app/store'
import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import { seoulConversationContext } from '../../../../data/fixtures/supportProgramConversation'
import type { RestoredSupportProgramSearchResult } from '../../../../domain/entities/SupportProgramSearchResult'
import { SupportProgramSearchRestoreError } from '../../../../domain/errors/SupportProgramSearchRestoreError'
import type { RestoreSupportProgramSearchUseCase } from '../../../../domain/usecases/RestoreSupportProgramSearchUseCase'
import { sessionRestored, signedIn, signedOut } from '../../../shared/auth/state/authSlice'
import { conversationReset, draftChanged } from '../state/chatSlice'
import { searchResultRestoreMessages, useRestoreSupportProgramSearch } from './useRestoreSupportProgramSearch'

const token = 'ce5a0b64-5496-47e4-8bab-05392e7661c9'
const account = { email: 'member@example.test', role: 'USER' as const, tier: 'MEMBER' as const, emailVerified: true, hasPassword: true, company: null }
const restored: RestoredSupportProgramSearchResult = {
  query: seoulConversationContext.query!, context: seoulConversationContext,
  programs: Array.from({ length: 5 }, (_, index) => ({ ...supportPrograms[0]!, id: 'selected-' + index, title: '선택한 공고 ' + index })),
  totalCount: 5, resultToken: null, expiresAt: null,
}
type RestoreExecute = RestoreSupportProgramSearchUseCase['execute']

afterEach(cleanup)

describe('선택한 검색 결과의 인증 후 복원', () => {
  it.each([false, true])('일반/StrictMode(%s)에서 원본 결과를 한 번만 복원하고 요청 중 URL 토큰을 제거한다', async (strict) => {
    const pending = deferred<RestoredSupportProgramSearchResult>()
    const execute = vi.fn<RestoreExecute>().mockReturnValue(pending.promise)
    const { store } = renderRestore(execute, { strict })
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())
    expect(execute).toHaveBeenCalledWith(token, expect.any(AbortSignal))
    expect(locationText()).toBe('/app/chat?mode=filter#results')
    expect(store.getState().chat.messages).toHaveLength(1)
    await act(async () => { pending.resolve(restored); await pending.promise })
    expect(store.getState().chat.messages.at(-1)?.programs).toEqual(restored.programs)
    expect(store.getState().chat.lastSearch).toEqual({ context: restored.context, resultCount: 5 })
    expect(store.getState().chat.accountEmail).toBe(account.email)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('세션 확인 중에는 토큰을 유지하고 인증 복원 이후에만 요청한다', async () => {
    const execute = vi.fn<RestoreExecute>().mockResolvedValue(restored)
    const { store } = renderRestore(execute, { session: 'unknown' })
    expect(locationText()).toContain('searchResult=' + token)
    expect(execute).not.toHaveBeenCalled()
    await act(async () => store.dispatch(sessionRestored(account)))
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())
    expect(locationText()).not.toContain('searchResult')
  })

  it('비회원 상태에서는 복원 API를 호출하거나 복귀 토큰을 제거하지 않는다', () => {
    const execute = vi.fn<RestoreExecute>().mockResolvedValue(restored)
    renderRestore(execute, { session: 'anonymous' })
    expect(execute).not.toHaveBeenCalled()
    expect(locationText()).toContain('searchResult=' + token)
  })

  it.each(['draft', 'reset', 'logout', 'account', 'navigation'] as const)('%s 이후에는 요청을 취소하고 늦은 원본 결과로 현재 대화를 덮어쓰지 않는다', async (change) => {
    const pending = deferred<RestoredSupportProgramSearchResult>()
    const execute = vi.fn<RestoreExecute>().mockReturnValue(pending.promise)
    const { store } = renderRestore(execute)
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())
    const signal = execute.mock.calls[0]![1]!
    act(() => {
      if (change === 'draft') store.dispatch(draftChanged('새로 입력한 검색어'))
      if (change === 'reset') store.dispatch(conversationReset())
      if (change === 'logout') store.dispatch(signedOut())
      if (change === 'account') store.dispatch(signedIn({ ...account, email: 'other@example.test' }))
      if (change === 'navigation') fireEvent.click(screen.getByRole('button', { name: '다른 화면' }))
    })
    const changed = store.getState().chat
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(restored); await pending.promise })
    expect(store.getState().chat).toEqual(changed)
    expect(locationText()).not.toContain('searchResult')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('화면 언마운트도 요청을 취소하고 늦은 오류를 대화에 표시하지 않는다', async () => {
    const pending = deferred<RestoredSupportProgramSearchResult>()
    const execute = vi.fn<RestoreExecute>().mockReturnValue(pending.promise)
    const { store, unmount } = renderRestore(execute)
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())
    const before = store.getState().chat
    unmount()
    expect(execute.mock.calls[0]![1]!.aborted).toBe(true)
    await act(async () => { pending.reject(new SupportProgramSearchRestoreError('expired')); await pending.promise.catch(() => undefined) })
    expect(store.getState().chat).toEqual(before)
  })

  it.each(['expired', 'unauthorized', 'unavailable'] as const)('%s 복원 실패는 안내 말풍선만 추가하고 검색 재시도를 활성화하지 않는다', async (reason) => {
    const execute = vi.fn<RestoreExecute>().mockRejectedValue(new SupportProgramSearchRestoreError(reason))
    const { store } = renderRestore(execute)
    await waitFor(() => expect(store.getState().chat.messages.at(-1)?.text).toBe(searchResultRestoreMessages[reason]))
    expect(store.getState().chat.messages.at(-1)?.role).toBe('assistant')
    expect(store.getState().chat.searchStatus).toBe('idle')
    expect(store.getState().chat.confirmedSearch).toBeNull()
    expect(store.getState().chat.lastSearch).toBeNull()
    expect(locationText()).not.toContain('searchResult')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('일시 실패 뒤 같은 결과 URL에 명시적으로 다시 들어오면 복원을 다시 시도한다', async () => {
    const execute = vi.fn<RestoreExecute>()
      .mockRejectedValueOnce(new SupportProgramSearchRestoreError('unavailable')).mockResolvedValueOnce(restored)
    const { store } = renderRestore(execute)
    await waitFor(() => expect(store.getState().chat.messages.at(-1)?.text).toBe(searchResultRestoreMessages.unavailable))
    fireEvent.click(screen.getByRole('button', { name: '같은 결과 다시 열기' }))
    await waitFor(() => expect(store.getState().chat.messages.at(-1)?.programs).toEqual(restored.programs))
    expect(execute).toHaveBeenCalledTimes(2)
    expect(locationText()).toBe('/app/chat')
  })

  it.each(['', 'not-a-token', token + '&searchResult=' + token])('잘못된 토큰 %s는 URL에서 제거하고 서버 요청 없이 안내한다', (invalidToken) => {
    const execute = vi.fn<RestoreExecute>().mockResolvedValue(restored)
    const { store } = renderRestore(execute, { path: '/app/chat?searchResult=' + invalidToken })
    expect(execute).not.toHaveBeenCalled()
    expect(locationText()).toBe('/app/chat')
    expect(store.getState().chat.messages.at(-1)?.text).toBe(searchResultRestoreMessages.expired)
  })
})

function renderRestore(execute: RestoreExecute, options: {
  strict?: boolean; session?: 'member' | 'anonymous' | 'unknown'; path?: string
} = {}) {
  const store = createAppStore()
  if (options.session !== 'unknown') store.dispatch(sessionRestored(options.session === 'anonymous' ? null : account))
  const useCase = { execute }
  function Harness() {
    useRestoreSupportProgramSearch(useCase)
    const location = useLocation()
    const navigate = useNavigate()
    return <><output data-testid="location">{location.pathname + location.search + location.hash}</output>
      <button type="button" onClick={() => void navigate('/pricing')}>다른 화면</button>
      <button type="button" onClick={() => void navigate('/app/chat?searchResult=' + token)}>같은 결과 다시 열기</button></>
  }
  const tree = <Provider store={store}><MemoryRouter initialEntries={[options.path ?? '/app/chat?searchResult=' + token + '&mode=filter#results']}>
    <Harness />
  </MemoryRouter></Provider>
  return { ...render(options.strict ? <StrictMode>{tree}</StrictMode> : tree), store }
}

function locationText() { return screen.getByTestId('location').textContent }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}