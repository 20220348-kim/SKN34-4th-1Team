// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import type { Account } from './domain/entities/Account'
import { loginMessages } from './presentation/features/auth/viewmodel/useLoginViewModel'
import { oauthCompleteMessages } from './presentation/features/auth/viewmodel/useOAuthCompleteViewModel'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({
  CoreApiConnectionStatus: () => null,
}))

const memberAccount: Account = { email: 'manager@kakao.com', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null }

beforeEach(() => {
  // 세션 확인 외의 화면 요청은 실제 서버에 연결하지 않습니다.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('소셜 로그인', () => {
  it('로그인 화면은 요청 없이 두 버튼을 바로 보여 주고 복귀 경로와 로그인 상태 유지 선택을 서버 시작 주소로 넘긴다', () => {
    renderApp('/login?next=%2Fapp%2Fpartners')

    const kakao = screen.getByRole('link', { name: '카카오계정으로 로그인' })
    const google = screen.getByRole('link', { name: 'Google 계정으로 로그인' })
    expect(kakao.getAttribute('href')).toMatch(/\/api\/v1\/auth\/oauth\/kakao\/authorize\?next=%2Fapp%2Fpartners$/)
    expect(google.getAttribute('href')).toMatch(/\/api\/v1\/auth\/oauth\/google\/authorize\?next=%2Fapp%2Fpartners$/)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/auth/oauth/'))).toBe(false)

    fireEvent.click(screen.getByLabelText('로그인 상태 유지'))
    expect(screen.getByRole('link', { name: '카카오계정으로 로그인' }).getAttribute('href')).toContain('rememberMe=true')
  })

  it('회원가입 화면은 같은 형식의 가입 문구로 두 버튼을 보여 준다', () => {
    renderApp('/signup')

    expect(screen.getByRole('link', { name: '카카오계정으로 시작하기' }).getAttribute('href'))
      .toMatch(/\/api\/v1\/auth\/oauth\/kakao\/authorize$/)
    expect(screen.getByRole('link', { name: 'Google 계정으로 시작하기' }).getAttribute('href'))
      .toMatch(/\/api\/v1\/auth\/oauth\/google\/authorize$/)
  })

  it('서버가 돌려보낸 소셜 로그인 실패 사유를 로그인 화면에 안내하고 모르는 값은 무시한다', () => {
    renderApp('/login?oauthError=account-exists')
    expect(screen.getByRole('alert').textContent).toBe(loginMessages.oauth['account-exists'])
    cleanup()

    renderApp('/login?oauthError=unavailable')
    expect(screen.getByRole('alert').textContent).toBe(loginMessages.oauth.unavailable)
    cleanup()

    renderApp('/login?oauthError=unknown')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('explains why a Kakao account awaiting unlink cannot sign up again', () => {
    renderApp('/login?oauthError=unlink-pending')
    expect(screen.getByRole('alert').textContent).toBe(loginMessages.oauth['unlink-pending'])
  })

  it('완료 화면은 세션으로 계정을 확인해 복귀 경로로 이동한다', async () => {
    const execute = vi.spyOn(appContainer.resolve('completeOAuthSignInUseCase'), 'execute').mockResolvedValue(memberAccount)
    renderApp('/oauth/complete?next=%2Fapp%2Fpricing')

    expect(screen.getByRole('status').textContent).toBe(oauthCompleteMessages.signingIn)
    // 요금제 작업 화면은 사이드바와 함께 그려져 부하가 큰 전체 실행에서 1초를 넘길 수 있어 기다림을 늘립니다.
    expect(await screen.findByRole('heading', { name: '기업의 다음 단계에 맞는 요금제' }, { timeout: 10000 })).toBeTruthy()
    expect(execute).toHaveBeenCalled()
  })

  it('완료 화면에서 세션이 없으면 로그인 화면에 실패를 알린다', async () => {
    vi.spyOn(appContainer.resolve('completeOAuthSignInUseCase'), 'execute').mockResolvedValue(null)
    renderApp('/oauth/complete?next=%2Fapp%2Fpartners')

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(loginMessages.oauth.failed))
  })
})

function renderApp(initialEntry: string, account: Account | null = null) {
  const store = createAppStore()
  store.dispatch(sessionRestored(account))
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}
