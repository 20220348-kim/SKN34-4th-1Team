// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import App from './App'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import { sessionHintStorageKey } from './data/storage/sessionHintStorage'
import type { Account } from './domain/entities/Account'
import { sessionRecheckIntervalMs } from './presentation/shared/auth/hooks/useAuthSession'
import { sessionRestored, signedOut } from './presentation/shared/auth/state/authSlice'

const member: Account = { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }
const expiredNotice = '로그인이 만료됐어요. 다시 로그인하면 보던 화면으로 돌아가요.'
const elsewhereNotice = '다른 창에서 로그인이 끝나 이 창도 로그아웃했어요. 다시 로그인해 주세요.'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function CurrentLocation() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderApp(path: string, account: Account | null) {
  const store = createAppStore()
  store.dispatch(sessionRestored(account))
  render(<Provider store={store}><MemoryRouter initialEntries={[path]}><App /><CurrentLocation /></MemoryRouter></Provider>)
  return store
}

function hintChanged(newValue: string | null) {
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: sessionHintStorageKey, newValue })) })
}

it('회원 화면의 Core API가 401을 주면 로그인 화면으로 보내 만료를 알리고, 다시 로그인하면 보던 화면으로 갈 주소를 남긴다', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
  const store = renderApp('/app/saved-programs', member)

  expect(await screen.findByText(expiredNotice)).toBeTruthy()
  expect(screen.getByTestId('location').textContent).toBe('/login?next=%2Fapp%2Fsaved-programs')
  expect(store.getState().auth.endReason).toBe('expired')
  // 사이드바도 함께 사라져 회원 화면을 더 넘길 수 없습니다.
  expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
})

it('직접 로그아웃하면 만료 안내 없이 로그인 화면이 열린다', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  const store = renderApp('/app/saved-programs', member)
  act(() => { store.dispatch(signedOut()) })

  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/login?next=%2Fapp%2Fsaved-programs'))
  expect(screen.queryByText(expiredNotice)).toBeNull()
  expect(screen.queryByText(elsewhereNotice)).toBeNull()
})

it('다른 창에서 로그아웃해 세션 힌트가 지워지면 이 창도 로그아웃하고, 다른 창에서 다시 로그인하면 보던 화면으로 돌아간다', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  const currentAccount = vi.spyOn(appContainer.resolve('getCurrentAccountUseCase'), 'execute').mockResolvedValue(member)
  const store = renderApp('/app/saved-programs', member)

  hintChanged(null)
  expect(await screen.findByText(elsewhereNotice)).toBeTruthy()
  expect(store.getState().auth.status).toBe('anonymous')
  expect(currentAccount).not.toHaveBeenCalled()

  hintChanged('1')
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/saved-programs'))
  expect(currentAccount).toHaveBeenCalledOnce()
  expect(store.getState().auth.status).toBe('authenticated')
  expect(store.getState().auth.endReason).toBeNull()
})

it('탭으로 돌아왔을 때 마지막 확인 뒤 5분이 지났을 때만 서버에 다시 묻고, 세션이 없으면 로그아웃한다', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let now = 1_000_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const currentAccount = vi.spyOn(appContainer.resolve('getCurrentAccountUseCase'), 'execute').mockResolvedValue(null)
  renderApp('/app/saved-programs', member)
  const returnToTab = () => act(() => { document.dispatchEvent(new Event('visibilitychange')) })

  now += sessionRecheckIntervalMs - 1
  returnToTab()
  expect(currentAccount).not.toHaveBeenCalled()

  now += 1
  returnToTab()
  expect(await screen.findByText(expiredNotice)).toBeTruthy()
  expect(currentAccount).toHaveBeenCalledOnce()
  expect(visibility).toHaveBeenCalled()
})

it('다시 묻다가 네트워크 오류가 나면 로그인 상태를 그대로 둔다', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let now = 1_000_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const currentAccount = vi.spyOn(appContainer.resolve('getCurrentAccountUseCase'), 'execute').mockRejectedValue(new TypeError('Failed to fetch'))
  const store = renderApp('/app/saved-programs', member)

  now += sessionRecheckIntervalMs
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  await waitFor(() => expect(currentAccount).toHaveBeenCalledOnce())
  await act(async () => {})
  expect(store.getState().auth.status).toBe('authenticated')
  expect(screen.getByTestId('location').textContent).toBe('/app/saved-programs')
})
