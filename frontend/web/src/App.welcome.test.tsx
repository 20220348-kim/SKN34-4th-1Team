// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import type { Account } from './domain/entities/Account'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'

const freshAccount: Account = {
  email: 'new@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null,
  accountType: null, onboarded: false,
}

function Location() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

function renderApp(path: string, account: Account) {
  const store = createAppStore()
  store.dispatch(sessionRestored(account))
  render(<Provider store={store}><MemoryRouter initialEntries={[path]}><App /><Location /></MemoryRouter></Provider>)
  return store
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('최초 로그인 환영 화면', () => {
  it('아직 답하지 않은 계정은 어떤 작업 화면을 열어도 환영 화면을 먼저 보고, 사이드바와 도우미는 없다', async () => {
    renderApp('/app/saved-programs', freshAccount)
    expect(await screen.findByRole('heading', { name: '어떤 회원으로 시작할까요?' })).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe('/app/welcome')
    expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
    expect(screen.queryByRole('button', { name: /도우미/ })).toBeNull()
  })

  it('기본은 개인 회원이고, 시작하면 저장한 뒤 검색 화면으로 가며 사이드바가 열린다', async () => {
    const complete = vi.spyOn(appContainer.resolve('completeOnboardingUseCase'), 'execute')
      .mockResolvedValue({ ...freshAccount, accountType: 'INDIVIDUAL', onboarded: true })
    renderApp('/app/chat', freshAccount)
    await screen.findByRole('heading', { name: '어떤 회원으로 시작할까요?' })
    expect((screen.getByRole('radio', { name: /개인 회원/ }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '시작하기' }))

    await waitFor(() => expect(complete).toHaveBeenCalledWith({ accountType: 'INDIVIDUAL' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/chat'))
    expect(await screen.findByRole('complementary', { name: '작업 사이드바' })).toBeTruthy()
    // 예시 검색은 회원 유형과 무관하게 같습니다.
    expect(screen.getByRole('button', { name: '서울 AI 창업지원 사업 찾아줘' })).toBeTruthy()
  })

  it('기업 회원을 고르면 버튼이 [다음]이 되고, 저장한 뒤 기업 등록 2단계로 간다', async () => {
    const complete = vi.spyOn(appContainer.resolve('completeOnboardingUseCase'), 'execute')
      .mockResolvedValue({ ...freshAccount, accountType: 'BUSINESS', onboarded: true })
    renderApp('/app/chat', freshAccount)
    await screen.findByRole('heading', { name: '어떤 회원으로 시작할까요?' })
    fireEvent.click(screen.getByRole('radio', { name: /기업 회원/ }))
    expect(screen.queryByRole('button', { name: '시작하기' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '다음' }))

    await waitFor(() => expect(complete).toHaveBeenCalledWith({ accountType: 'BUSINESS' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/welcome/company'))
    expect(await screen.findByRole('heading', { name: '기업 정보를 알려 주세요' })).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
  })

  it('저장에 실패하면 화면에 남아 안내한다', async () => {
    vi.spyOn(appContainer.resolve('completeOnboardingUseCase'), 'execute').mockRejectedValue(new Error('down'))
    renderApp('/app/chat', freshAccount)
    fireEvent.click(await screen.findByRole('button', { name: '시작하기' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe('/app/welcome')
  })

  it('이미 답한 계정은 환영 화면으로 보내지 않는다', async () => {
    renderApp('/app/saved-programs', { ...freshAccount, accountType: 'BUSINESS', onboarded: true })
    expect(await screen.findByRole('heading', { name: '관심 공고함' })).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe('/app/saved-programs')
  })
})
