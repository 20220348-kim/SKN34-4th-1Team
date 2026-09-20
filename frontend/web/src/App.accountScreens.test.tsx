// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import { receivedAcceptedProposal, receivedPendingProposal, receivedProposalBox, sentPendingProposal, sentProposalBox } from './data/fixtures/partnerProposals'
import { partnerRecruitmentDetail, partnerRecruitmentPage } from './data/fixtures/partnerRecruitments'
import { supportPrograms } from './data/fixtures/supportPrograms'
import type { Account } from './domain/entities/Account'
import { accountSecurityMessages } from './presentation/features/company-profile/viewmodel/useAccountSecurityViewModel'
import { forgotPasswordMessages } from './presentation/features/auth/viewmodel/useForgotPasswordViewModel'
import { loginMessages } from './presentation/features/auth/viewmodel/useLoginViewModel'
import { resetPasswordMessages } from './presentation/features/auth/viewmodel/useResetPasswordViewModel'
import { signupMessages } from './presentation/features/auth/viewmodel/useSignupViewModel'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'
import { chooseOption, optionLabels, selectedValue } from './test/selectField'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({
  CoreApiConnectionStatus: () => null,
}))

const memberAccount: Account = { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null }
const adminAccount: Account = { email: 'admin@govbiz.local', role: 'ADMIN', tier: 'ADMIN', emailVerified: true, hasPassword: true, company: null }
const companyAccount: Account = {
  email: 'company@govbiz.local', role: 'USER', tier: 'COMPANY', emailVerified: false, hasPassword: true,
  company: { companyName: '테스트 기업 주식회사', businessNumber: '1234567890' },
}

beforeEach(() => {
  // 작업 화면 진입 후 readiness 확인도 실제 서버에 연결하지 않습니다.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('계정 화면', () => {
  it.each([['portfolio', false], ['development', true]] as const)(
    '%s 모드에서 개발 로그인 버튼 노출을 구분한다', (mode, visible) => {
      vi.stubEnv('MODE', mode)
      renderApp('/', null)
      expect(Boolean(screen.queryByRole('button', { name: '개발 로그인 · 관리자' }))).toBe(visible)
      expect(Boolean(screen.queryByRole('button', { name: '개발 로그인 · 회원' }))).toBe(visible)
    },
  )

  it('회원가입 화면은 이메일·인증번호·비밀번호만 받고 인증 전에는 가입 버튼을 잠근다', () => {
    renderApp('/signup')

    const form = screen.getByRole('form', { name: '회원가입' })
    expect(within(form).getByRole('heading', { name: '회원가입' })).toBeTruthy()
    expect(within(form).getByLabelText('이메일')).toBeTruthy()
    expect(within(form).getByRole('button', { name: '인증번호 받기' })).toBeTruthy()
    expect(within(form).queryByLabelText('인증번호')).toBeNull()
    expect(within(form).getByLabelText('비밀번호')).toBeTruthy()
    expect(within(form).getByLabelText('비밀번호 확인')).toBeTruthy()
    expect((within(form).getByRole('button', { name: '이메일로 가입하기' }) as HTMLButtonElement).disabled).toBe(true)
    for (const removedField of ['담당자 이름', '기업명', '사업자등록번호', '소재지', '업종']) {
      expect(within(form).queryByLabelText(removedField)).toBeNull()
    }
  })

  it('회원가입은 인증번호를 받아 맞힌 뒤에만 통행 토큰과 함께 가입을 요청한다', async () => {
    const send = vi.spyOn(appContainer.resolve('sendSignupEmailCodeUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'email-taken' })
      .mockResolvedValueOnce({ outcome: 'sent' })
    const verify = vi.spyOn(appContainer.resolve('verifySignupEmailCodeUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'code-invalid' })
      .mockResolvedValueOnce({ outcome: 'verified', passToken: 'b'.repeat(43) })
    const signUp = vi.spyOn(appContainer.resolve('signUpUseCase'), 'execute').mockResolvedValue({
      outcome: 'session', session: { account: memberAccount, expiresAt: '2026-12-01T00:00:00+09:00' },
    })
    renderApp('/signup')
    const form = screen.getByRole('form', { name: '회원가입' })

    fireEvent.click(within(form).getByRole('button', { name: '인증번호 받기' }))
    expect(screen.getByRole('alert').textContent).toBe(signupMessages.emailRequired)
    expect(send).not.toHaveBeenCalled()

    fireEvent.change(within(form).getByLabelText('이메일'), { target: { value: 'Member@Govbiz.local' } })
    fireEvent.click(within(form).getByRole('button', { name: '인증번호 받기' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(signupMessages.emailTaken))
    fireEvent.click(within(form).getByRole('button', { name: '인증번호 받기' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(signupMessages.codeSent))
    expect(send).toHaveBeenLastCalledWith('Member@Govbiz.local')
    expect(within(form).getByRole('button', { name: '다시 받기' })).toBeTruthy()

    fireEvent.change(within(form).getByLabelText('인증번호'), { target: { value: '12ab34' } })
    expect((within(form).getByLabelText('인증번호') as HTMLInputElement).value).toBe('1234')
    fireEvent.click(within(form).getByRole('button', { name: '확인' }))
    expect(screen.getByRole('alert').textContent).toBe(signupMessages.codeRequired)
    fireEvent.change(within(form).getByLabelText('인증번호'), { target: { value: '000000' } })
    fireEvent.click(within(form).getByRole('button', { name: '확인' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(signupMessages.codeInvalid))
    fireEvent.change(within(form).getByLabelText('인증번호'), { target: { value: '482137' } })
    fireEvent.click(within(form).getByRole('button', { name: '확인' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(signupMessages.codeVerified))
    expect(verify).toHaveBeenLastCalledWith('Member@Govbiz.local', '482137')
    expect(within(form).getByText('인증됨')).toBeTruthy()
    expect(within(form).queryByLabelText('인증번호')).toBeNull()
    expect((within(form).getByLabelText('이메일') as HTMLInputElement).readOnly).toBe(true)

    fireEvent.change(within(form).getByLabelText('비밀번호'), { target: { value: 'welcome-12' } })
    fireEvent.change(within(form).getByLabelText('비밀번호 확인'), { target: { value: 'welcome-12' } })
    fireEvent.submit(form)
    await waitFor(() => expect(signUp).toHaveBeenCalledWith({ email: 'Member@Govbiz.local', password: 'welcome-12', emailPassToken: 'b'.repeat(43) }))
  })

  it('회원가입에서 인증한 이메일을 고치면 인증이 풀리고 가입 버튼이 다시 잠긴다', async () => {
    vi.spyOn(appContainer.resolve('sendSignupEmailCodeUseCase'), 'execute').mockResolvedValue({ outcome: 'sent' })
    vi.spyOn(appContainer.resolve('verifySignupEmailCodeUseCase'), 'execute').mockResolvedValue({ outcome: 'verified', passToken: 'b'.repeat(43) })
    renderApp('/signup')
    const form = screen.getByRole('form', { name: '회원가입' })

    fireEvent.change(within(form).getByLabelText('이메일'), { target: { value: 'member@govbiz.local' } })
    fireEvent.click(within(form).getByRole('button', { name: '인증번호 받기' }))
    await screen.findByLabelText('인증번호')
    fireEvent.change(within(form).getByLabelText('인증번호'), { target: { value: '482137' } })
    fireEvent.click(within(form).getByRole('button', { name: '확인' }))
    await waitFor(() => expect((within(form).getByRole('button', { name: '이메일로 가입하기' }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.change(within(form).getByLabelText('이메일'), { target: { value: 'other@govbiz.local' } })
    expect(within(form).queryByText('인증됨')).toBeNull()
    expect(within(form).getByRole('button', { name: '인증번호 받기' })).toBeTruthy()
    expect((within(form).getByRole('button', { name: '이메일로 가입하기' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('로그인과 회원가입 화면은 서로를 오간다', () => {
    renderApp('/login')

    fireEvent.click(screen.getByRole('link', { name: '회원가입' }))
    expect(screen.getByRole('form', { name: '회원가입' })).toBeTruthy()

    fireEvent.click(screen.getByRole('link', { name: '로그인' }))
    expect(screen.getByRole('form', { name: '로그인' })).toBeTruthy()
  })

  it('로그인·회원가입 화면은 소개 패널 없이 로고 아래 카드 하나만 두고 비밀번호 찾기로 이어진다', () => {
    renderApp('/login')

    expect(screen.queryByRole('complementary', { name: 'GovBiz 계정 소개' })).toBeNull()
    expect(screen.getByRole('link', { name: 'GovBiz 홈으로' }).getAttribute('href')).toBe('/')
    expect(screen.queryByText('비밀번호 재설정 · 준비 중')).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: '비밀번호 찾기' }))
    expect(screen.getByRole('form', { name: '비밀번호 찾기' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '비밀번호를 잊으셨나요?' })).toBeTruthy()

    fireEvent.click(screen.getByRole('link', { name: '로그인으로 돌아가기' }))
    expect(screen.getByRole('form', { name: '로그인' })).toBeTruthy()
  })

  it('비밀번호 찾기는 이메일 형식을 먼저 확인하고 요청 뒤에는 가입 여부와 무관한 안내만 보여 준다', async () => {
    const execute = vi.spyOn(appContainer.resolve('requestPasswordResetUseCase'), 'execute')
      .mockResolvedValue({ outcome: 'requested' })
    renderApp('/forgot-password')

    const form = screen.getByRole('form', { name: '비밀번호 찾기' })
    fireEvent.change(within(form).getByLabelText('이메일'), { target: { value: 'manager' } })
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toBe(forgotPasswordMessages.emailRequired)
    expect(execute).not.toHaveBeenCalled()

    fireEvent.change(within(form).getByLabelText('이메일'), { target: { value: 'Manager@Company.co.kr' } })
    fireEvent.submit(form)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(forgotPasswordMessages.sent))
    expect(execute).toHaveBeenCalledWith('Manager@Company.co.kr')
    expect(within(form).queryByLabelText('이메일')).toBeNull()
    expect(within(form).queryByRole('button', { name: '재설정 링크 보내기' })).toBeNull()
  })

  it('비밀번호 찾기는 메일 불가·시도 제한을 구분해 안내한다', async () => {
    vi.spyOn(appContainer.resolve('requestPasswordResetUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'mail-unavailable' })
      .mockResolvedValueOnce({ outcome: 'rate-limited', retryAfterSeconds: 40 })
    renderApp('/forgot-password')

    const form = screen.getByRole('form', { name: '비밀번호 찾기' })
    fireEvent.change(within(form).getByLabelText('이메일'), { target: { value: 'manager@company.co.kr' } })
    fireEvent.submit(form)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(forgotPasswordMessages.mailUnavailable))
    fireEvent.submit(form)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(forgotPasswordMessages.rateLimited(40)))
  })

  it('비밀번호 재설정은 주소의 토큰으로 새 비밀번호를 저장하고 로그인으로 안내한다', async () => {
    const execute = vi.spyOn(appContainer.resolve('resetPasswordUseCase'), 'execute').mockResolvedValue({ outcome: 'reset' })
    const token = 'b'.repeat(43)
    renderApp(`/reset-password#token=${token}`)

    const form = screen.getByRole('form', { name: '비밀번호 재설정' })
    fireEvent.change(within(form).getByLabelText('새 비밀번호'), { target: { value: 'short' } })
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toBe(resetPasswordMessages.passwordLength)

    fireEvent.change(within(form).getByLabelText('새 비밀번호'), { target: { value: 'new-password-2' } })
    fireEvent.change(within(form).getByLabelText('새 비밀번호 확인'), { target: { value: 'new-password-3' } })
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toBe(resetPasswordMessages.passwordMismatch)
    expect(execute).not.toHaveBeenCalled()

    fireEvent.change(within(form).getByLabelText('새 비밀번호 확인'), { target: { value: 'new-password-2' } })
    fireEvent.submit(form)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(resetPasswordMessages.done))
    expect(execute).toHaveBeenCalledWith({ token, newPassword: 'new-password-2' })
    expect(within(form).queryByLabelText('새 비밀번호')).toBeNull()
    expect(screen.getByRole('link', { name: '로그인하러 가기' }).getAttribute('href')).toBe('/login')
  })

  it('비밀번호 재설정은 토큰이 없거나 거절되면 입력 대신 다시 요청하도록 안내한다', async () => {
    vi.spyOn(appContainer.resolve('resetPasswordUseCase'), 'execute').mockResolvedValue({ outcome: 'token-invalid' })
    renderApp('/reset-password')
    expect(screen.getByRole('alert').textContent).toBe(resetPasswordMessages.missingToken)
    expect(screen.queryByLabelText('새 비밀번호')).toBeNull()
    expect(screen.getByRole('link', { name: '재설정 링크 다시 요청' }).getAttribute('href')).toBe('/forgot-password')
    cleanup()

    renderApp(`/reset-password#token=${'c'.repeat(43)}`)
    const form = screen.getByRole('form', { name: '비밀번호 재설정' })
    fireEvent.change(within(form).getByLabelText('새 비밀번호'), { target: { value: 'new-password-2' } })
    fireEvent.change(within(form).getByLabelText('새 비밀번호 확인'), { target: { value: 'new-password-2' } })
    fireEvent.submit(form)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(resetPasswordMessages.tokenInvalid))
    expect(within(form).queryByLabelText('새 비밀번호')).toBeNull()
  })

  it('회원가입 입력이 비어 있으면 서버에 보내지 않고 이메일부터 안내한다', () => {
    const execute = vi.spyOn(appContainer.resolve('signUpUseCase'), 'execute')
    renderApp('/signup')
    fireEvent.submit(screen.getByRole('form', { name: '회원가입' }))
    expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('이메일')
    expect(execute).not.toHaveBeenCalled()
  })

  it('비밀번호 확인이 다르면 입력 화면에서 설명한다', async () => {
    renderApp('/signup')
    const form = screen.getByRole('form', { name: '회원가입' })
    await verifySignupEmail(form, 'demo@example.test')
    fireEvent.change(within(form).getByLabelText('비밀번호'), { target: { value: 'Demo1234' } })
    fireEvent.change(within(form).getByLabelText('비밀번호 확인'), { target: { value: 'Different1234' } })
    fireEvent.submit(form)
    expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('일치')
  })

  it('가입에 성공하면 세션 계정으로 작업 채팅에 들어간다', async () => {
    const execute = vi.spyOn(appContainer.resolve('signUpUseCase'), 'execute').mockResolvedValue({
      outcome: 'session',
      session: { expiresAt: '2026-09-07T00:00:00+09:00', account: { email: 'new@example.test', role: 'USER', tier: 'MEMBER', emailVerified: false, hasPassword: true, company: null } },
    })
    renderApp('/signup')
    const form = screen.getByRole('form', { name: '회원가입' })
    await verifySignupEmail(form, 'New@Example.test')
    fireEvent.change(within(form).getByLabelText('비밀번호'), { target: { value: 'welcome-12' } })
    fireEvent.change(within(form).getByLabelText('비밀번호 확인'), { target: { value: 'welcome-12' } })
    fireEvent.click(screen.getByRole('button', { name: '이메일로 가입하기' }))

    expect(execute).toHaveBeenCalledWith({ email: 'New@Example.test', password: 'welcome-12', emailPassToken: 'b'.repeat(43) })
    const sidebar = await screen.findByRole('complementary', { name: '작업 사이드바' })
    expect(within(sidebar).getByText('new@example.test')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '지원사업 검색어' })).toBeTruthy()
  })

  it('이미 가입된 이메일과 시도 제한은 화면에 구분해 안내하고 머문다', async () => {
    const execute = vi.spyOn(appContainer.resolve('signUpUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'email-taken' })
      .mockResolvedValueOnce({ outcome: 'rate-limited', retryAfterSeconds: 45 })
      .mockRejectedValueOnce(new Error('network'))
    renderApp('/signup')
    const form = screen.getByRole('form', { name: '회원가입' })
    await verifySignupEmail(form, 'taken@example.test')
    fireEvent.change(within(form).getByLabelText('비밀번호'), { target: { value: 'welcome-12' } })
    fireEvent.change(within(form).getByLabelText('비밀번호 확인'), { target: { value: 'welcome-12' } })

    fireEvent.submit(form)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(signupMessages.emailTaken))
    expect(within(form).getByLabelText('이메일').getAttribute('aria-invalid')).toBe('true')

    fireEvent.submit(form)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(signupMessages.rateLimited(45)))

    fireEvent.submit(form)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(signupMessages.requestFailed))
    expect(execute).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
  })

  it.each(['short1', 'p'.repeat(73)])('비밀번호 길이 조건을 충족하지 못하면 보내지 않는다: %s', async (password) => {
    const execute = vi.spyOn(appContainer.resolve('signUpUseCase'), 'execute')
    renderApp('/signup')
    const form = screen.getByRole('form', { name: '회원가입' })
    await verifySignupEmail(form, 'demo@example.test')
    fireEvent.change(within(form).getByLabelText('비밀번호'), { target: { value: password } })
    fireEvent.change(within(form).getByLabelText('비밀번호 확인'), { target: { value: password } })
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toContain('8자')
    expect(document.activeElement).toBe(within(form).getByLabelText('비밀번호'))
    expect(execute).not.toHaveBeenCalled()
  })

  it('약관 안내와 로고로 돌아가는 홈 링크만 두고 새 비밀번호 자동완성을 쓴다', () => {
    renderApp('/signup')
    const form = screen.getByRole('form')
    expect(within(form).getByText(/이용약관과 개인정보 처리방침에 동의한 것으로/)).toBeTruthy()
    expect(within(form).queryByText(/데모/)).toBeNull()
    expect(within(form).queryByRole('link', { name: /없이 지원사업 검색/ })).toBeNull()
    expect(within(form).getByRole('link', { name: 'GovBiz 홈으로' }).getAttribute('href')).toBe('/')
    expect(within(form).getByLabelText('비밀번호').getAttribute('autocomplete')).toBe('new-password')
  })

  it.each(['', 'invalid-email'])('로그인은 빈 값과 잘못된 이메일을 서버에 보내지 않는다: %s', (email) => {
    const execute = vi.spyOn(appContainer.resolve('logInUseCase'), 'execute')
    renderApp('/login')
    const form = screen.getByRole('form', { name: '로그인' })
    fireEvent.change(within(form).getByLabelText('이메일'), { target: { value: email } })
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toContain('이메일')
    expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
    expect(execute).not.toHaveBeenCalled()
  })

  it('로그인에 성공하면 세션을 올리고 사이드바가 있는 작업 화면으로 이동한다', async () => {
    const execute = vi.spyOn(appContainer.resolve('logInUseCase'), 'execute').mockResolvedValue({
      outcome: 'session',
      session: { expiresAt: '2026-10-06T12:00:00+09:00', account: memberAccount },
    })
    renderApp('/login')
    const form = screen.getByRole('form', { name: '로그인' })
    fireEvent.change(within(form).getByLabelText('이메일'), { target: { value: ' Member@GovBiz.local ' } })
    fireEvent.change(within(form).getByLabelText('비밀번호'), { target: { value: 'govbiz-admin1' } })
    fireEvent.click(within(form).getByLabelText('로그인 상태 유지'))
    fireEvent.click(within(form).getByRole('button', { name: '이메일로 로그인' }))

    await waitFor(() => expect(screen.getByRole('complementary', { name: '작업 사이드바' })).toBeTruthy())
    expect(execute).toHaveBeenCalledWith({ email: 'Member@GovBiz.local', password: 'govbiz-admin1', rememberMe: true })
    expect(screen.queryByRole('banner', { name: '앱 헤더' })).toBeNull()
    expect(within(screen.getByRole('complementary', { name: '작업 사이드바' })).getByText('member@govbiz.local')).toBeTruthy()
  })

  it('잘못된 비밀번호·정지·시도 제한은 화면에 구분해 안내한다', async () => {
    const execute = vi.spyOn(appContainer.resolve('logInUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'invalid-credentials' })
      .mockResolvedValueOnce({ outcome: 'suspended' })
      .mockResolvedValueOnce({ outcome: 'rate-limited', retryAfterSeconds: 30 })
    renderApp('/login')
    const form = screen.getByRole('form', { name: '로그인' })
    fireEvent.change(within(form).getByLabelText('이메일'), { target: { value: 'member@govbiz.local' } })
    fireEvent.change(within(form).getByLabelText('비밀번호'), { target: { value: 'wrong' } })

    for (const message of [loginMessages.invalidCredentials, loginMessages.suspended, loginMessages.rateLimited(30)]) {
      fireEvent.click(within(form).getByRole('button', { name: '이메일로 로그인' }))
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message))
    }
    expect(execute).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
  })

  it('비로그인으로 작업 화면에 들어가면 로그인으로 보내고 로그인 뒤 원래 화면으로 돌아간다', async () => {
    vi.spyOn(appContainer.resolve('logInUseCase'), 'execute').mockResolvedValue({
      outcome: 'session',
      session: { expiresAt: '2026-10-06T12:00:00+09:00', account: memberAccount },
    })
    renderApp('/app/partners', null)

    const form = screen.getByRole('form', { name: '로그인' })
    fireEvent.change(within(form).getByLabelText('이메일'), { target: { value: 'member@govbiz.local' } })
    fireEvent.change(within(form).getByLabelText('비밀번호'), { target: { value: 'govbiz-admin1' } })
    fireEvent.click(within(form).getByRole('button', { name: '이메일로 로그인' }))

    await waitFor(() => expect(screen.getByRole('heading', { name: '파트너 관리' })).toBeTruthy())
  })

  it('로그인 상태에서 로그인·회원가입 화면은 작업 화면으로 돌려보낸다', () => {
    renderApp('/login', memberAccount)
    expect(screen.getByRole('complementary', { name: '작업 사이드바' })).toBeTruthy()
    expect(screen.queryByRole('form', { name: '로그인' })).toBeNull()
  })

  it('사이드바에서 로그아웃하면 공개 화면으로 돌아간다', async () => {
    vi.spyOn(appContainer.resolve('logOutUseCase'), 'execute').mockResolvedValue(undefined)
    renderApp('/app/chat')

    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    // 로그아웃은 계정 카드를 눌러 여는 메뉴 안에 있습니다.
    fireEvent.click(within(sidebar).getByRole('button', { name: /계정 메뉴/ }))
    fireEvent.click(within(sidebar).getByRole('button', { name: '로그아웃' }))

    // 로그아웃하면 로그인 화면이 아니라 공개 메인 화면으로 돌아갑니다.
    await waitFor(() => expect(screen.getByRole('banner', { name: '앱 헤더' })).toBeTruthy())
    expect(screen.queryByRole('form', { name: '로그인' })).toBeNull()
    expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
  })

  it.each([memberAccount, companyAccount])('$tier 회원은 계정 메뉴를 열어도 관리자 메뉴와 화면을 보지 못한다', (account) => {
    renderApp('/app/admin/accounts', account)
    // 회원은 관리자 화면 대신 작업 채팅으로 돌아가고 메뉴도 보지 못합니다.
    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    expect(within(sidebar).queryByRole('link', { name: '회원·기업' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '계정 관리' })).toBeNull()
    fireEvent.click(within(sidebar).getByRole('button', { name: `계정 메뉴 · ${account.email}` }))
    expect(within(sidebar).getByRole('link', { name: '내 프로필' })).toBeTruthy()
    expect(within(sidebar).getByRole('button', { name: '로그아웃' })).toBeTruthy()
    expect(within(sidebar).queryByRole('link', { name: '회원·기업' })).toBeNull()
  })
})

describe('작업 화면 사이드바', () => {
  it('흰색 사이드바에서 선택 메뉴는 초록색, 준비 중 메뉴는 회색으로 표시하고 기존 메뉴 계약을 유지한다', () => {
    renderApp('/app/chat')
    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    expect(sidebar.classList.contains('bg-white')).toBe(true)
    const search = within(sidebar).getByRole('button', { name: '지원사업 새검색' })
    expect(search.getAttribute('aria-current')).toBe('page')
    expect(search.classList.contains('bg-[#e6f5ed]')).toBe(true)
    expect(search.classList.contains('text-brand-primary')).toBe(true)
    expect(search.classList.contains('rounded-2xl')).toBe(true)
    expect(search.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')

    const documents = within(sidebar).getByRole('link', { name: '신청 문서 작성' })
    expect(documents.getAttribute('href')).toBe('/app/application-preparations')
    expect(documents.classList.contains('rounded-2xl')).toBe(true)
    expect(documents.getAttribute('aria-current')).toBeNull()
    // 관심 공고함은 화면이 생겨 링크이며, 준비 중 배지가 없습니다.
    const savedPrograms = within(sidebar).getByRole('link', { name: '관심 공고함' })
    expect(savedPrograms.getAttribute('href')).toBe('/app/saved-programs')
    expect(savedPrograms.getAttribute('aria-disabled')).toBeNull()
    expect(within(sidebar).queryByText('준비 중')).toBeNull()

    fireEvent.click(within(sidebar).getByRole('link', { name: '요금제' }))
    expect(within(sidebar).getByRole('link', { name: '요금제' }).getAttribute('aria-current')).toBe('page')
    expect(within(sidebar).getByRole('link', { name: '요금제' }).classList.contains('bg-[#e6f5ed]')).toBe(true)
    expect(search.getAttribute('aria-current')).toBeNull()
    expect(search.classList.contains('bg-[#e6f5ed]')).toBe(false)
  })

  it('사이드바에서 파트너 모집을 열고 관리자 계정 메뉴에서 회원·기업으로 이동한다', () => {
    renderApp('/app/chat', adminAccount)

    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    fireEvent.click(within(sidebar).getByRole('link', { name: '파트너 관리' }))
    // 머리글 한 줄에 제목·탭·작성 버튼이 함께 놓이고, 탭으로 제안함을 오갑니다.
    const header = screen.getByRole('heading', { name: '파트너 관리' }).closest('header') as HTMLElement
    const tabs = within(header).getByRole('navigation', { name: '파트너 관리 탭' })
    expect(within(tabs).getByRole('link', { name: '모집글' }).getAttribute('aria-current')).toBe('page')
    expect(within(header).getByRole('link', { name: /작성$/ })).toBeTruthy()
    fireEvent.click(within(tabs).getByRole('link', { name: /제안함/ }))
    expect(screen.getByRole('heading', { name: '파트너 관리' })).toBeTruthy()
    expect(within(screen.getByRole('navigation', { name: '파트너 관리 탭' })).getByRole('link', { name: /제안함/ }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('tablist', { name: '제안함 종류' })).toBeTruthy()
    expect(within(sidebar).getByRole('link', { name: /파트너 관리/ }).getAttribute('aria-current')).toBe('page')

    expect(within(sidebar).queryByRole('navigation', { name: '관리자' })).toBeNull()
    expect(within(sidebar).queryByRole('link', { name: '회원·기업' })).toBeNull()
    const accountButton = within(sidebar).getByRole('button', { name: `계정 메뉴 · ${adminAccount.email}` })
    fireEvent.click(accountButton)
    expect(accountButton.getAttribute('aria-expanded')).toBe('true')
    const accountMenu = document.getElementById(accountButton.getAttribute('aria-controls')!)!
    expect(within(accountMenu).getByRole('link', { name: '내 프로필' })).toBeTruthy()
    expect(within(accountMenu).getByRole('button', { name: '로그아웃' })).toBeTruthy()
    const adminLink = within(accountMenu).getByRole('link', { name: '회원·기업' })
    expect(adminLink.getAttribute('href')).toBe('/app/admin/accounts')
    expect(adminLink.getAttribute('aria-current')).toBeNull()
    expect(within(sidebar).getAllByRole('link', { name: '회원·기업' })).toHaveLength(1)
    fireEvent.click(adminLink)
    expect(screen.getByRole('heading', { name: '계정 관리' })).toBeTruthy()
    expect(accountButton.getAttribute('aria-expanded')).toBe('false')
    expect(within(sidebar).queryByRole('link', { name: '회원·기업' })).toBeNull()

    fireEvent.click(accountButton)
    const activeAdminLink = within(sidebar).getByRole('link', { name: '회원·기업' })
    expect(activeAdminLink.getAttribute('aria-current')).toBe('page')
    expect(activeAdminLink.classList.contains('bg-[#e6f5ed]')).toBe(true)
  })

  it('관리자 계정 메뉴를 Escape나 바깥 클릭으로 닫으면 회원·기업 링크도 숨긴다', () => {
    renderApp('/app/chat', adminAccount)
    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    const accountButton = within(sidebar).getByRole('button', { name: `계정 메뉴 · ${adminAccount.email}` })

    fireEvent.click(accountButton)
    expect(within(sidebar).getByRole('link', { name: '회원·기업' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(accountButton.getAttribute('aria-expanded')).toBe('false')
    expect(within(sidebar).queryByRole('link', { name: '회원·기업' })).toBeNull()

    fireEvent.click(accountButton)
    expect(within(sidebar).getByRole('link', { name: '회원·기업' })).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(accountButton.getAttribute('aria-expanded')).toBe('false')
    expect(within(sidebar).queryByRole('link', { name: '회원·기업' })).toBeNull()
  })

  it('모든 메뉴가 화면을 가져 준비 중 표시가 없다', () => {
    renderApp('/app/chat')

    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    expect(within(sidebar).getByRole('link', { name: '관심 공고함' }).getAttribute('href')).toBe('/app/saved-programs')
    expect(within(sidebar).queryByText('준비 중')).toBeNull()
  })

  it('사이드바 지원사업 새검색은 작성 중 초안과 대화를 지우고 입력창으로 포커스를 옮긴다', () => {
    renderApp('/app/chat')
    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '수출 지원사업' } })
    fireEvent.submit(input.closest('form')!)
    expect(screen.queryByRole('button', { name: '새 검색' })).toBeNull()
    expect(within(sidebar).queryByRole('link', { name: '지원사업 검색' })).toBeNull()
    expect(within(sidebar).queryByRole('button', { name: '새 채팅' })).toBeNull()
    expect(within(sidebar).getAllByRole('button', { name: '지원사업 새검색' })).toHaveLength(1)
    fireEvent.click(within(sidebar).getByRole('button', { name: '지원사업 새검색' }))
    // 제출한 조건 해석이 진행 중이므로 검색 화면에서는 확인 대화상자를 거쳐 계속을 눌러야 지웁니다.
    fireEvent.click(within(screen.getByRole('dialog', { name: '검색이 진행 중입니다' })).getByRole('button', { name: '계속' }))
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    expect(within(screen.getByRole('region', { name: '대화 내역' })).queryByText('수출 지원사업')).toBeNull()
  })

  it('사이드바를 접고 펼쳐도 본문과 작성 중인 초안은 유지한다', () => {
    renderApp('/app/chat')
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '작성 중인 질문' } })
    fireEvent.click(screen.getByRole('button', { name: '사이드바 접기' }))
    expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
    const expand = screen.getByRole('button', { name: '사이드바 펼치기' })
    expect(document.activeElement).toBe(expand)
    expect(screen.getByRole('textbox', { name: '지원사업 검색어' })).toBe(input)
    expect(input.value).toBe('작성 중인 질문')
    fireEvent.click(expand)
    expect(screen.getByRole('complementary', { name: '작업 사이드바' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '사이드바 접기' }))
    expect(input.value).toBe('작성 중인 질문')
  })

  it.each([false, true])('필터 검색에서 지원사업 새검색은 AI 탭으로 돌아와 입력창에 포커스한다 (사이드바 접힘: %s)', (collapsed) => {
    renderApp('/app/chat?mode=filter')
    expect(screen.getByRole('tab', { name: '필터 검색' }).getAttribute('aria-selected')).toBe('true')
    if (collapsed) fireEvent.click(screen.getByRole('button', { name: '사이드바 접기' }))
    fireEvent.click(screen.getByRole('button', { name: '지원사업 새검색' }))
    expect(screen.getByRole('tab', { name: 'AI 대화 검색' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '지원사업 검색어' }))
  })

})

describe('기업 프로필 화면', () => {
  const registeredCompany = {
    businessNumber: '1248100998',
    companyName: '삼성전자(주)',
    businessStatus: '계속사업자',
    region: '서울특별시',
    industry: '정보통신업',
    foundedYear: 2020,
    homepageUrl: null,
    businessVerifiedAt: '2026-09-08T10:00:00',
    updatedAt: '2026-09-08T10:00:00',
  }

  it('사이드바에서 내 프로필로 이동하면 기업이 없을 때 등록 폼부터 보여 주고 나머지 섹션은 그대로 둔다', async () => {
    vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(null)
    renderApp('/app/chat')
    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    // 내 프로필은 사이드바 메뉴가 아니라 계정 카드를 눌러 여는 메뉴에 있습니다.
    expect(within(sidebar).queryByRole('link', { name: '내 프로필' })).toBeNull()
    fireEvent.click(within(sidebar).getByRole('button', { name: /계정 메뉴/ }))
    fireEvent.click(within(sidebar).getByRole('link', { name: '내 프로필' }))

    expect(screen.getByRole('heading', { name: '내 프로필' })).toBeTruthy()
    const form = await screen.findByRole('form', { name: '기업 등록' })
    expect(within(form).getByLabelText('사업자등록번호')).toBeTruthy()
    expect(within(form).getByLabelText(/홈페이지/)).toBeTruthy()
    expect(within(form).queryByLabelText(/휴대폰|직원 수|한 줄 소개/)).toBeNull()
    expect((within(form).getByRole('button', { name: '기업 등록' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('region', { name: '기업 기본정보' })).toBeNull()
    expect(screen.getByRole('region', { name: '협업·파트너 설정' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '우대·인증 자격' })).toBeNull()
    expect(screen.getByRole('region', { name: '계정과 알림' })).toBeTruthy()
    // 옆 칸의 안내 카드는 없고, 이 정보가 쓰이는 곳·공개 범위는 카드 제목 옆 ? 도움말로 들어갑니다.
    expect(screen.queryByRole('complementary', { name: '프로필 안내' })).toBeNull()
    expect(screen.queryByRole('region', { name: '공개 범위' })).toBeNull()
    expect(screen.getByRole('button', { name: '공개 범위 도움말' })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '기업 등록' })).getByRole('button', { name: '이 정보가 쓰이는 곳 도움말' })).toBeTruthy()
    expect(screen.getByText('기업 미등록')).toBeTruthy()
  })

  it('계정과 알림 카드의 알림 스위치는 화면 상태로 켜고 끈다', async () => {
    renderApp('/app/profile')
    const account = await screen.findByRole('region', { name: '계정과 알림' })
    const switches = within(account).getAllByRole('switch')
    expect(switches.map((node) => node.getAttribute('aria-label'))).toEqual([
      '관심 공고 마감 3일 전 알림',
      '파트너 제안·메시지 알림',
      '프로필 조건에 맞는 새 공고 알림',
    ])
    expect(switches.map((node) => node.getAttribute('aria-checked'))).toEqual(['true', 'true', 'false'])

    fireEvent.click(switches[2]!)
    expect(switches[2]!.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(switches[0]!)
    expect(switches[0]!.getAttribute('aria-checked')).toBe('false')
    expect(switches[1]!.getAttribute('aria-checked')).toBe('true')
  })

  it('조회 결과로 상호·상태를 채우고 소재지·업종·설립연도를 입력해 등록하면 기업 회원이 된다', async () => {
    vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(null)
    const lookup = vi.spyOn(appContainer.resolve('lookupBusinessUseCase'), 'execute').mockResolvedValue({
      outcome: 'found',
      business: { businessNumber: '1248100998', companyName: '삼성전자(주)', businessStatus: '계속사업자', isActive: true },
    })
    const register = vi.spyOn(appContainer.resolve('registerCompanyUseCase'), 'execute')
      .mockResolvedValue({ outcome: 'registered', company: registeredCompany })
    renderApp('/app/profile')
    const form = await screen.findByRole('form', { name: '기업 등록' })

    fireEvent.change(within(form).getByLabelText('사업자등록번호'), { target: { value: '124-81-00998' } })
    fireEvent.click(within(form).getByRole('button', { name: '조회' }))
    const result = await screen.findByRole('status', { name: '조회 결과' })
    expect(within(result).getByText('삼성전자(주)')).toBeTruthy()
    expect(within(result).getByText('계속사업자')).toBeTruthy()
    expect(within(result).queryByText(/법인등록번호|과세/)).toBeNull()
    expect(lookup).toHaveBeenCalledWith('124-81-00998')

    chooseOption(within(form).getByLabelText('소재지'), '서울특별시')
    chooseOption(within(form).getByLabelText('업종'), '정보통신업')
    fireEvent.click(within(form).getByRole('button', { name: '기업 등록' }))
    expect(screen.getByRole('alert').textContent).toContain('설립연도')
    expect(register).not.toHaveBeenCalled()

    chooseOption(within(form).getByLabelText('설립연도'), '2020')
    fireEvent.click(within(form).getByRole('button', { name: '기업 등록' }))

    const basics = await screen.findByRole('region', { name: '기업 기본정보' })
    expect(register).toHaveBeenCalledWith('1248100998', {
      region: '서울특별시', industry: '정보통신업', foundedYear: 2020, homepageUrl: null,
    })
    expect(within(basics).getByText('124-81-00998')).toBeTruthy()
    expect(screen.getByText(/기업을 등록했습니다/)).toBeTruthy()
    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    expect(within(sidebar).getByText('삼성전자(주) · 기업 회원')).toBeTruthy()
  })

  it('등록되지 않은 번호와 휴·폐업 사업자는 이유를 안내하고 등록하지 않는다', async () => {
    vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(null)
    vi.spyOn(appContainer.resolve('lookupBusinessUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'not-found' })
      .mockResolvedValueOnce({
        outcome: 'found',
        business: { businessNumber: '1112233334', companyName: '문 닫은 회사', businessStatus: '폐업자', isActive: false },
      })
    const register = vi.spyOn(appContainer.resolve('registerCompanyUseCase'), 'execute')
    renderApp('/app/profile')
    const form = await screen.findByRole('form', { name: '기업 등록' })

    // 10자리가 되기 전에는 조회할 수 없고, 입력 중 하이픈이 자동으로 붙습니다.
    const numberInput = within(form).getByLabelText('사업자등록번호') as HTMLInputElement
    fireEvent.change(numberInput, { target: { value: '12-34' } })
    expect(numberInput.value).toBe('123-4')
    expect((within(form).getByRole('button', { name: '조회' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(form).getByText(/하이픈이 자동으로/)).toBeTruthy()

    fireEvent.change(numberInput, { target: { value: '1234567890' } })
    expect(numberInput.value).toBe('123-45-67890')
    fireEvent.click(within(form).getByRole('button', { name: '조회' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('등록되지 않은'))

    fireEvent.change(within(form).getByLabelText('사업자등록번호'), { target: { value: '1112233334' } })
    fireEvent.click(within(form).getByRole('button', { name: '조회' }))
    await screen.findByText('계속사업자만 등록할 수 있습니다.')
    expect((within(form).getByRole('button', { name: '기업 등록' }) as HTMLButtonElement).disabled).toBe(true)
    expect(register).not.toHaveBeenCalled()
  })

  it('등록된 기업은 조회 값과 담당자 입력을 보여 주고 수정 폼은 입력 항목만 바꾼다', async () => {
    vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(registeredCompany)
    const update = vi.spyOn(appContainer.resolve('updateCompanyUseCase'), 'execute')
      .mockResolvedValue({ ...registeredCompany, region: '부산광역시', homepageUrl: 'https://example.co.kr' })
    renderApp('/app/profile')

    const basics = await screen.findByRole('region', { name: '기업 기본정보' })
    expect(within(basics).getByText('삼성전자(주)', { exact: false })).toBeTruthy()
    expect(within(basics).getByText('124-81-00998')).toBeTruthy()
    expect(within(basics).getByText('사업자 확인')).toBeTruthy()
    expect(within(basics).queryByText(/법인등록번호|과세유형/)).toBeNull()
    expect(within(basics).getAllByText('미입력').length).toBe(1)

    fireEvent.click(within(basics).getByRole('button', { name: '수정' }))
    const form = screen.getByRole('form', { name: '기업 기본정보 수정' })
    // 조회 값(기업명·사업자등록번호·사업자 상태)은 입력란 없이 그대로 보입니다.
    const readOnly = within(form).getByRole('group', { name: '조회 값' })
    expect(within(readOnly).getByText(registeredCompany.companyName)).toBeTruthy()
    expect(within(readOnly).getByText('사업자 확인')).toBeTruthy()
    expect(within(form).queryByLabelText(/기업명|사업자등록번호/)).toBeNull()
    expect(within(form).queryByLabelText('사업자등록번호')).toBeNull()
    expect(selectedValue(within(form).getByLabelText('설립연도'))).toBe('2020')
    chooseOption(within(form).getByLabelText('소재지'), '부산광역시')
    fireEvent.change(within(form).getByLabelText(/홈페이지/), { target: { value: ' https://example.co.kr ' } })
    fireEvent.click(within(form).getByRole('button', { name: '저장' }))

    // 저장하면 수정 폼이 닫힙니다.
    await waitFor(() => expect(screen.queryByRole('form', { name: '기업 기본정보 수정' })).toBeNull())
    expect(update).toHaveBeenCalledWith({
      region: '부산광역시', industry: '정보통신업', foundedYear: 2020, homepageUrl: 'https://example.co.kr',
    })
    const updated = screen.getByRole('region', { name: '기업 기본정보' })
    expect(within(updated).getByText('https://example.co.kr')).toBeTruthy()
    expect(within(updated).getByText('부산광역시')).toBeTruthy()
  })

  it('설립연도는 격자 선택기로 고르고 홈페이지는 https://를 붙여 저장하며 잘못된 주소는 필드 아래에 안내한다', async () => {
    vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue({ ...registeredCompany, foundedYear: 2016 })
    const update = vi.spyOn(appContainer.resolve('updateCompanyUseCase'), 'execute')
      .mockResolvedValue({ ...registeredCompany, foundedYear: 2020, homepageUrl: 'https://company.co.kr/about' })
    renderApp('/app/profile')
    const basics = await screen.findByRole('region', { name: '기업 기본정보' })
    fireEvent.click(within(basics).getByRole('button', { name: '수정' }))
    const form = screen.getByRole('form', { name: '기업 기본정보 수정' })

    // 격자 선택기: 저장된 2016년이 속한 최근 12년(올해로 끝나는 쪽)이 열리고, 올해 뒤로는 넘어가지 않습니다.
    const thisYear = new Date().getFullYear()
    fireEvent.click(within(form).getByRole('button', { name: '설립연도 2016' }))
    const picker = screen.getByRole('dialog', { name: '설립연도 선택' })
    expect(within(picker).getByText(`${thisYear - 11} – ${thisYear}`)).toBeTruthy()
    expect((within(picker).getByRole('button', { name: '다음 12년' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(picker).queryByRole('button', { name: String(thisYear + 1) })).toBeNull()
    fireEvent.click(within(picker).getByRole('button', { name: '이전 12년' }))
    expect(within(picker).getByText(`${thisYear - 23} – ${thisYear - 12}`)).toBeTruthy()
    fireEvent.click(within(picker).getByRole('button', { name: '다음 12년' }))
    // 선택기 안쪽의 글자·여백을 눌러도 닫히지 않고, 바깥을 누르면 닫힙니다.
    fireEvent.mouseDown(within(picker).getByText(`${thisYear - 11} – ${thisYear}`))
    fireEvent.blur(picker, { relatedTarget: null })
    expect(screen.getByRole('dialog', { name: '설립연도 선택' })).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', { name: '설립연도 선택' })).toBeNull()
    fireEvent.click(within(form).getByRole('button', { name: '설립연도 2016' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '설립연도 선택' })).getByRole('button', { name: '2020' }))
    expect(screen.queryByRole('dialog', { name: '설립연도 선택' })).toBeNull()
    expect(selectedValue(within(form).getByLabelText('설립연도'))).toBe('2020')

    // 스킴이 없는 주소는 미리보기로 알려 주고 저장 시 https://를 붙입니다. 다른 스킴은 필드 아래 오류입니다.
    const homepage = within(form).getByLabelText(/홈페이지/)
    fireEvent.change(homepage, { target: { value: 'ftp://company.co.kr' } })
    fireEvent.click(within(form).getByRole('button', { name: '저장' }))
    expect(within(form).getByRole('alert').textContent).toContain('https://로 시작')
    expect(update).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(homepage)

    fireEvent.change(homepage, { target: { value: ' company.co.kr/about ' } })
    expect(within(form).getByText('https://company.co.kr/about 로 저장됩니다.')).toBeTruthy()
    fireEvent.click(within(form).getByRole('button', { name: '저장' }))
    // 저장하면 수정 폼이 닫힙니다.
    await waitFor(() => expect(screen.queryByRole('form', { name: '기업 기본정보 수정' })).toBeNull())
    expect(update).toHaveBeenCalledWith({
      region: '서울특별시', industry: '정보통신업', foundedYear: 2020, homepageUrl: 'https://company.co.kr/about',
    })
  })

  it('완성도는 기업 정보·이메일 인증·협업 설정 세 항목으로 계산하고 선택 항목인 홈페이지는 넣지 않는다', async () => {
    vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(registeredCompany)
    const getProfile = vi.spyOn(appContainer.resolve('getCompanyPartnerProfileUseCase'), 'execute')
      .mockResolvedValue({ isSet: false, roles: [], interestAreas: [], introduction: '', capabilities: [], updatedAt: null })
    renderApp('/app/profile')
    await screen.findByRole('region', { name: '기업 기본정보' })
    await waitFor(() => expect(getProfile).toHaveBeenCalled())

    // 기업 등록·이메일 인증(회원 fixture)은 끝났고 협업 설정만 남았습니다.
    const completion = screen.getByRole('progressbar', { name: '프로필 완성도' })
    await waitFor(() => expect(completion.getAttribute('aria-valuenow')).toBe('67'))
    // 체크리스트는 옆 칸이 아니라 완성도 막대 아래 요약 카드 안에 있습니다.
    const summary = screen.getByRole('region', { name: '프로필 요약' })
    expect(within(summary).getByText('협업·파트너 설정', { selector: 'span' })).toBeTruthy()
    expect(within(summary).queryByText(/홈페이지/)).toBeNull()
    expect(screen.queryByRole('region', { name: '완성도 체크리스트' })).toBeNull()
  })

  it('협업·파트너 설정은 기업이 있을 때만 편집되고 역할·관심 분야·소개·역량을 저장한다', async () => {
    vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(registeredCompany)
    vi.spyOn(appContainer.resolve('getCompanyPartnerProfileUseCase'), 'execute')
      .mockResolvedValue({ isSet: false, roles: [], interestAreas: [], introduction: '', capabilities: [], updatedAt: null })
    const update = vi.spyOn(appContainer.resolve('updateCompanyPartnerProfileUseCase'), 'execute').mockResolvedValue({
      isSet: true, roles: ['LEAD'], interestAreas: ['기술'], introduction: 'AI 문서 분류 팀', capabilities: ['문서 분류 AI'], updatedAt: '2026-09-10T10:00:00',
    })
    renderApp('/app/profile')
    const settings = await screen.findByRole('region', { name: '협업·파트너 설정' })
    // 기업 기본정보처럼 평소에는 값만 보이고 수정을 눌러야 폼이 열립니다.
    expect(within(settings).getByText('미설정')).toBeTruthy()
    expect(within(settings).queryByRole('form')).toBeNull()
    fireEvent.click(await within(settings).findByRole('button', { name: '수정' }))
    const form = within(settings).getByRole('form', { name: '협업·파트너 설정' })

    // 역할 없이 저장하면 칸 아래에 안내하고 보내지 않습니다.
    fireEvent.submit(form)
    expect(within(form).getByRole('alert').textContent).toContain('역할')
    expect(update).not.toHaveBeenCalled()

    fireEvent.click(within(form).getByRole('button', { name: '주관기관' }))
    fireEvent.click(within(form).getByRole('button', { name: '기술' }))
    fireEvent.change(within(form).getByLabelText(/한 줄 소개/), { target: { value: ' AI 문서 분류 팀 ' } })
    const capability = within(form).getByLabelText(/보유 역량 태그/)
    fireEvent.change(capability, { target: { value: '문서 분류 AI' } })
    fireEvent.keyDown(capability, { key: 'Enter' })
    expect(within(form).getByRole('button', { name: '문서 분류 AI 삭제' })).toBeTruthy()
    fireEvent.click(within(form).getByRole('button', { name: '저장' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith({
      roles: ['LEAD'], interestAreas: ['기술'], introduction: ' AI 문서 분류 팀 ', capabilities: ['문서 분류 AI'],
    }))
    // 저장하면 폼이 닫히고 저장한 값이 보입니다.
    await waitFor(() => expect(within(settings).queryByRole('form')).toBeNull())
    expect(within(settings).getByText('저장됨')).toBeTruthy()
    expect(within(settings).getByText('주관기관')).toBeTruthy()
    expect(within(settings).getByText('AI 문서 분류 팀')).toBeTruthy()
    expect(within(settings).getByRole('button', { name: '수정' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '프로필 완성도' }).getAttribute('aria-valuenow')).toBe('100')
  })

  it('기업이 없으면 협업·파트너 설정은 등록 안내만 보여 준다', async () => {
    vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(null)
    const getProfile = vi.spyOn(appContainer.resolve('getCompanyPartnerProfileUseCase'), 'execute')
    renderApp('/app/profile')
    await screen.findByRole('form', { name: '기업 등록' })

    const settings = screen.getByRole('region', { name: '협업·파트너 설정' })
    expect(within(settings).getByText('기업을 등록하면 협업 조건을 설정할 수 있습니다.')).toBeTruthy()
    expect(within(settings).queryByRole('form')).toBeNull()
    expect(getProfile).not.toHaveBeenCalled()
  })

  it('담당자 이메일은 제안을 수락한 뒤에만 공개한다', async () => {
    vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(null)
    renderApp('/app/profile')
    await screen.findByRole('form', { name: '기업 등록' })

    // 공개 범위 표는 협업·파트너 설정 제목 옆 ? 도움말을 열어야 보입니다.
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.click(within(screen.getByRole('region', { name: '협업·파트너 설정' })).getByRole('button', { name: '공개 범위 도움말' }))
    const publicity = screen.getByRole('tooltip')
    const managerRow = within(publicity).getByText('담당자 이메일').closest('tr')!
    const cells = within(managerRow).getAllByRole('cell')

    expect(cells[1]!.textContent).toBe('비공개')
    expect(cells[2]!.textContent).toBe('공개')
    expect(within(publicity).queryByText(/우대·인증/)).toBeNull()
    expect(screen.queryByRole('region', { name: '우대·인증 자격' })).toBeNull()
  })

})

describe('계정 보안 모달', () => {
  beforeEach(() => {
    vi.spyOn(appContainer.resolve('getMyCompanyUseCase'), 'execute').mockResolvedValue(null)
  })

  it('비밀번호 변경 모달은 현재 비밀번호 없이 새 비밀번호·확인이 맞을 때만 보내고 규칙 충족과 일치를 바로 보여 준다', async () => {
    const change = vi.spyOn(appContainer.resolve('changePasswordUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'rate-limited', retryAfterSeconds: 30 })
      .mockResolvedValueOnce({ outcome: 'changed' })
    renderApp('/app/profile')
    const account = await screen.findByRole('region', { name: '계정과 알림' })

    // 브라우저처럼 누른 버튼에 포커스가 있는 상태에서 열어야 닫힌 뒤 그 버튼으로 돌아가는지 볼 수 있습니다.
    const opener = within(account).getByRole('button', { name: '변경' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: '비밀번호 변경' })
    expect(dialog.textContent).toContain('일부 기기의 경우 계정에서 로그아웃될 수 있습니다.')
    expect(within(dialog).queryByLabelText('현재 비밀번호')).toBeNull()
    expect(document.activeElement).toBe(within(dialog).getByLabelText('새 비밀번호'))
    const submit = within(dialog).getByRole('button', { name: '변경' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    // 규칙 한 줄은 8자를 넘기면 초록(ok)으로, 확인 칸은 입력하는 동안 일치·불일치를 바로 알립니다.
    const rule = within(dialog).getByText(new RegExp(accountSecurityMessages.newPasswordLength))
    expect(rule.getAttribute('data-state')).toBe('pending')
    fireEvent.change(within(dialog).getByLabelText('새 비밀번호'), { target: { value: 'new-password-2' } })
    expect(within(dialog).getByText(new RegExp(accountSecurityMessages.newPasswordLength)).getAttribute('data-state')).toBe('ok')
    fireEvent.change(within(dialog).getByLabelText('새 비밀번호 확인'), { target: { value: 'new-password-3' } })
    expect(within(dialog).getByText(new RegExp(accountSecurityMessages.confirmationMismatch)).getAttribute('data-state')).toBe('mismatch')
    expect(submit.disabled).toBe(true)
    fireEvent.submit(within(dialog).getByRole('form', { name: '비밀번호 변경' }))
    expect(within(dialog).getByRole('alert').textContent).toBe(accountSecurityMessages.confirmationMismatch)
    expect(change).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText('새 비밀번호 확인'), { target: { value: 'new-password-2' } })
    expect(within(dialog).getByText(new RegExp(accountSecurityMessages.confirmationMatch)).getAttribute('data-state')).toBe('match')
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe(accountSecurityMessages.rateLimited(30)))
    expect(change).toHaveBeenCalledWith('new-password-2')

    fireEvent.click(within(dialog).getByRole('button', { name: '변경' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '비밀번호 변경' })).toBeNull())
    expect(within(account).getByRole('status').textContent).toBe(accountSecurityMessages.passwordChanged)
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('모달은 Esc와 배경 클릭으로 닫히고 Tab이 안에서 돈다', async () => {
    renderApp('/app/profile')
    const account = await screen.findByRole('region', { name: '계정과 알림' })
    fireEvent.click(within(account).getByRole('button', { name: '변경' }))
    const dialog = screen.getByRole('dialog', { name: '비밀번호 변경' })

    // 변경 버튼은 입력 전이라 비활성이므로 마지막 초점 요소는 취소입니다. 끝에서 Tab은 처음(닫기)으로, 처음에서 Shift+Tab은 끝으로 갑니다.
    const close = within(dialog).getByRole('button', { name: '닫기' })
    const cancel = within(dialog).getByRole('button', { name: '취소' })
    cancel.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(cancel)

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '비밀번호 변경' })).toBeNull()

    fireEvent.click(within(account).getByRole('button', { name: '변경' }))
    fireEvent.mouseDown(screen.getByRole('dialog', { name: '비밀번호 변경' }).parentElement!)
    expect(screen.queryByRole('dialog', { name: '비밀번호 변경' })).toBeNull()
  })

  it('계정 삭제 모달은 지워지는 것을 먼저 보여 주고 비밀번호 확인 뒤 랜딩으로 보낸다', async () => {
    vi.spyOn(appContainer.resolve('getAccountDeletionPreviewUseCase'), 'execute').mockResolvedValue({
      hasCompany: true, openRecruitmentCount: 2, receivedPendingProposalCount: 3, sentPendingProposalCount: 1,
    })
    const remove = vi.spyOn(appContainer.resolve('deleteAccountUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'current-password-mismatch' })
      .mockResolvedValueOnce({ outcome: 'deleted' })
    renderApp('/app/profile')
    const account = await screen.findByRole('region', { name: '계정과 알림' })

    fireEvent.click(within(account).getByRole('button', { name: '계정 삭제' }))
    const dialog = screen.getByRole('dialog', { name: '계정을 삭제할까요?' })
    expect(dialog.textContent).toContain('member@govbiz.local')
    // "삭제되는 것" 목록은 문구 확정 전까지 화면에서 숨겨 두었습니다. 미리 보기 조회는 그대로 일어납니다.
    await waitFor(() => expect(appContainer.resolve('getAccountDeletionPreviewUseCase').execute).toHaveBeenCalled())
    expect(within(dialog).queryByRole('status', { name: '삭제되는 것' })).toBeNull()
    const submit = within(dialog).getByRole('button', { name: '계정 삭제' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText('확인을 위해 비밀번호를 입력하세요'), { target: { value: 'wrong' } })
    fireEvent.click(submit)
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe(accountSecurityMessages.currentPasswordMismatch))
    expect(screen.getByRole('dialog', { name: '계정을 삭제할까요?' })).toBeTruthy()

    fireEvent.change(within(dialog).getByLabelText('확인을 위해 비밀번호를 입력하세요'), { target: { value: 'password1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '계정 삭제' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('password1'))
    await waitFor(() => expect(screen.getByRole('banner', { name: '앱 헤더' })).toBeTruthy())
    expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull()
  })

  it('소셜 로그인으로만 가입한 계정은 비밀번호 항목이 없고 비밀번호 없이 계정을 삭제한다', async () => {
    vi.spyOn(appContainer.resolve('getAccountDeletionPreviewUseCase'), 'execute').mockResolvedValue({
      hasCompany: false, openRecruitmentCount: 0, receivedPendingProposalCount: 0, sentPendingProposalCount: 0,
    })
    const remove = vi.spyOn(appContainer.resolve('deleteAccountUseCase'), 'execute').mockResolvedValue({ outcome: 'deleted' })
    renderApp('/app/profile', { ...memberAccount, hasPassword: false })
    const account = await screen.findByRole('region', { name: '계정과 알림' })

    expect(within(account).queryByText('비밀번호')).toBeNull()
    expect(within(account).queryByRole('button', { name: '변경' })).toBeNull()

    fireEvent.click(within(account).getByRole('button', { name: '계정 삭제' }))
    const dialog = screen.getByRole('dialog', { name: '계정을 삭제할까요?' })
    expect(within(dialog).queryByLabelText('확인을 위해 비밀번호를 입력하세요')).toBeNull()
    const submit = within(dialog).getByRole('button', { name: '계정 삭제' }) as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(remove).toHaveBeenCalledWith(null))
    await waitFor(() => expect(screen.getByRole('banner', { name: '앱 헤더' })).toBeTruthy())
  })
})

describe('파트너 모집 화면', () => {
  beforeEach(() => {
    // 고정 공고의 접수 기간 안으로 날짜만 고정하고 검색 debounce 타이머는 실제로 실행한다.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T03:00:00Z'))
    vi.spyOn(appContainer.resolve('browsePartnerRecruitmentsUseCase'), 'execute').mockResolvedValue(partnerRecruitmentPage)
    vi.spyOn(appContainer.resolve('browsePartnerProposalsUseCase'), 'execute').mockResolvedValue({ box: 'received', proposals: [], pendingCount: 0 })
    vi.spyOn(appContainer.resolve('getPartnerRecruitmentDetailUseCase'), 'execute')
      .mockImplementation(async (id) => (id === partnerRecruitmentDetail.id ? partnerRecruitmentDetail : null))
    // 모집글 상세는 묶인 공고가 관심 공고함에 있는지 확인하므로 기본은 담기지 않은 상태로 둡니다.
    vi.spyOn(appContainer.resolve('checkSavedSupportProgramUseCase'), 'execute').mockResolvedValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('목록을 모집 API로 읽고 상세로 이동해 예시 매칭과 제안 폼을 보여준다', async () => {
    renderApp('/app/partners')

    expect(await screen.findByRole('article', { name: 'AI 실증 과제 데이터 구축·라벨링 참여기관 구합니다' })).toBeTruthy()
    expect(screen.getByText('4건 · 마감 임박순')).toBeTruthy()
    expect(appContainer.resolve('browsePartnerRecruitmentsUseCase').execute).toHaveBeenCalledWith(
      { keyword: '', seekingRoles: [], regions: [], mineOnly: false, sourceCode: '', sort: 'DEADLINE', page: 1 },
      expect.any(AbortSignal),
    )
    expect(fetch).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('link', { name: '자세히 보기' })[0]!)

    expect(await screen.findByRole('heading', { name: '모집글 상세' })).toBeTruthy()
    // 머리글의 상위 화면 이름(파트너 관리)을 누르면 목록으로 돌아갑니다.
    expect(within(screen.getByRole('navigation', { name: '상위 화면' })).getByRole('link', { name: '파트너 관리' }).getAttribute('href')).toBe('/app/partners')
    expect(screen.getByText('AI 실증 과제 데이터 구축·라벨링 참여기관 구합니다')).toBeTruthy()
    expect(screen.getByText('참여기관 1곳')).toBeTruthy()
    const proposal = screen.getByRole('form', { name: '참여 제안' })
    expect(within(proposal).getByLabelText('제안 메시지')).toBeTruthy()
    // 예시 매칭 카드는 없고, 제안 상태 흐름은 참여 제안 제목 옆 ? 도움말로 봅니다.
    expect(screen.queryByRole('region', { name: '우리 기업과의 매칭' })).toBeNull()
    expect(screen.queryByText(/예시 비교입니다/)).toBeNull()
    fireEvent.click(within(proposal).getByRole('button', { name: '제안 상태 흐름 도움말' }))
    expect(screen.getByRole('tooltip').textContent).toContain('수락 · 연락처 공개')
    expect(within(proposal).queryByLabelText(/서류 상태도 공개/)).toBeNull()
  })

  it('기업을 등록하지 않은 회원은 작성 대신 프로필 등록 안내를 본다', async () => {
    renderApp('/app/partners', memberAccount)
    expect(screen.getByRole('link', { name: '기업 등록 후 작성' }).getAttribute('href')).toBe('/app/profile')
    await screen.findByRole('article', { name: /AI 실증 과제/ })
    expect(screen.queryByText(/예시 일치/)).toBeNull()

    cleanup()
    renderApp('/app/partners/new', memberAccount)
    const guard = screen.getByRole('region', { name: '기업 등록 필요' })
    expect(within(guard).getByRole('link', { name: '프로필에서 기업 등록' }).getAttribute('href')).toBe('/app/profile')
    expect(screen.queryByRole('form', { name: '모집글 작성' })).toBeNull()

    cleanup()
    renderApp('/app/partners/detail?recruitmentId=101', memberAccount)
    const proposalForm = await screen.findByRole('form', { name: '참여 제안' })
    expect(within(proposalForm).getByRole('link', { name: '프로필에서 기업 등록' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '우리 기업과의 매칭' })).toBeNull()
  })

  it('검색어·찾는 역할·지역은 조회를 눌러야 조회 파라미터로 가고 내 글·정렬은 바로 적용되며 첫 페이지로 돌아간다', async () => {
    const browse = appContainer.resolve('browsePartnerRecruitmentsUseCase').execute as ReturnType<typeof vi.fn>
    renderApp('/app/partners')
    const panel = screen.getByRole('form', { name: '모집글 검색과 필터' })
    await screen.findByRole('article', { name: /AI 실증 과제/ })

    // 전국은 선택지에 없고 전체가 전국까지 뜻합니다. 역할·지역은 여러 개를 함께 고릅니다.
    expect(within(panel).queryByRole('checkbox', { name: '전국' })).toBeNull()
    fireEvent.change(within(panel).getByRole('searchbox', { name: '모집글 검색' }), { target: { value: '스마트' } })
    fireEvent.click(within(panel).getByRole('checkbox', { name: '주관기관' }))
    fireEvent.click(within(panel).getByRole('checkbox', { name: '서울' }))
    fireEvent.click(within(panel).getByRole('checkbox', { name: '부산' }))
    expect(within(panel).getByRole('checkbox', { name: '전체 지역' })).toHaveProperty('checked', false)
    expect(browse).not.toHaveBeenCalledWith(expect.objectContaining({ keyword: '스마트' }), expect.anything())

    fireEvent.click(within(panel).getByRole('button', { name: '조회' }))
    // 내 글만 보기는 칩이 아니라 "내 모집글" 탭이 맡습니다.
    expect(within(panel).queryByRole('button', { name: '내가 쓴 모집글만' })).toBeNull()
    fireEvent.click(within(panel).getByRole('radio', { name: '최근 등록순' }))

    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(
      { keyword: '스마트', seekingRoles: ['LEAD'], regions: ['서울', '부산'], mineOnly: false, sourceCode: '', sort: 'RECENT', page: 1 },
      expect.any(AbortSignal),
    ))
    expect(screen.getByText('4건 · 최근 등록순')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '검색·필터 초기화' }))
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(
      { keyword: '', seekingRoles: [], regions: [], mineOnly: false, sourceCode: '', sort: 'RECENT', page: 1 },
      expect.any(AbortSignal),
    ))
    expect(within(panel).getByRole('checkbox', { name: '전체 지역' })).toHaveProperty('checked', true)
    expect(within(panel).getByRole('searchbox', { name: '모집글 검색' })).toHaveProperty('value', '')
  })

  it('조건에 맞는 글이 없으면 초기화를 안내하고, 조회에 실패하면 다시 시도할 수 있다', async () => {
    const browse = appContainer.resolve('browsePartnerRecruitmentsUseCase').execute as ReturnType<typeof vi.fn>
    browse.mockResolvedValueOnce({ ...partnerRecruitmentPage, recruitments: [], total: 0, totalPages: 0 })
    renderApp('/app/partners')
    expect(await screen.findByText(/아직 모집 중인 글이 없습니다/)).toBeTruthy()

    browse.mockRejectedValueOnce(new Error('down'))
    fireEvent.change(screen.getByRole('searchbox', { name: '모집글 검색' }), { target: { value: '없는 글' } })
    fireEvent.click(screen.getByRole('button', { name: '조회' }))
    expect(await screen.findByRole('region', { name: '모집글 불러오기 실패' })).toBeTruthy()

    browse.mockResolvedValueOnce({ ...partnerRecruitmentPage, recruitments: [], total: 0, totalPages: 0 })
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findByRole('region', { name: '검색 결과 없음' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '검색·필터 초기화' }))
    expect(await screen.findAllByRole('article')).toHaveLength(4)
  })

  it('내가 쓴 모집글은 표시가 다르고 내 모집글 보기로 이어진다', async () => {
    renderApp('/app/partners')
    const mine = await screen.findByRole('article', { name: /문서 분류 AI 사업화 과제/ })
    expect(within(mine).getByText('내가 쓴 모집글')).toBeTruthy()
    expect(within(mine).getByRole('link', { name: '받은 제안 보기' }).getAttribute('href')).toBe('/app/partners/detail?recruitmentId=104')
  })

  it('링크 복사는 현재 주소를 클립보드에 쓰고, 쓸 수 없으면 안내만 한다', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderApp('/app/partners/detail?recruitmentId=101')
    fireEvent.click(await screen.findByRole('button', { name: '링크 복사' }))
    expect(await screen.findByRole('button', { name: '링크를 복사했습니다' })).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith(window.location.href)

    cleanup()
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    renderApp('/app/partners/detail?recruitmentId=101')
    fireEvent.click(await screen.findByRole('button', { name: '링크 복사' }))
    expect(await screen.findByRole('button', { name: /복사할 수 없습니다/ })).toBeTruthy()
  })

  it('제안 메시지 글자 수를 세어 보여준다', async () => {
    renderApp('/app/partners/detail?recruitmentId=101')

    const proposal = await screen.findByRole('form', { name: '참여 제안' })
    fireEvent.change(within(proposal).getByLabelText('제안 메시지'), {
      target: { value: '안녕하세요' },
    })

    expect(within(proposal).getByText('5 / 500')).toBeTruthy()
  })

  /** 관심 공고함 팝업을 열어 제목이 같은 공고를 고르고 선택 완료로 닫습니다. */
  async function pickSavedProgram(form: HTMLElement, title: string) {
    fireEvent.click(within(form).getByRole('button', { name: '관심 공고함에서 선택' }))
    const dialog = await screen.findByRole('dialog', { name: '관심 공고함에서 선택' })
    const results = await within(dialog).findByRole('list', { name: '모집글 관심 공고 목록' })
    fireEvent.click(within(results).getByRole('button', { name: `${title} 관심 공고 선택` }))
    fireEvent.click(within(dialog).getByRole('button', { name: '선택 완료' }))
  }

  it('모집글 작성에서 필요 역량을 추가하고 지운다', () => {
    renderApp('/app/partners/new')

    const form = screen.getByRole('form', { name: '모집글 작성' })
    const capabilityInput = within(form).getByLabelText('필요 역량')

    fireEvent.change(capabilityInput, { target: { value: '데이터 라벨링' } })
    fireEvent.keyDown(capabilityInput, { key: 'Enter' })
    expect(within(form).getByText('데이터 라벨링')).toBeTruthy()

    fireEvent.click(within(form).getByRole('button', { name: '데이터 라벨링 삭제' }))
    expect(within(form).queryByText('데이터 라벨링')).toBeNull()
  })

  it.each([{ isComposing: true }, { keyCode: 229 }])('한글 조합 Enter에서는 필요 역량 입력을 확정하거나 지우지 않는다: %o', (composition) => {
    renderApp('/app/partners/new')
    const input = screen.getByLabelText('필요 역량') as HTMLInputElement
    fireEvent.change(input, { target: { value: '데이터 구축' } })
    fireEvent.keyDown(input, { key: 'Enter', ...composition })
    expect(input.value).toBe('데이터 구축')
    expect(screen.queryByRole('button', { name: '데이터 구축 삭제' })).toBeNull()
  })

  it('관심 공고함 팝업에서 공고를 고르면 모집 마감일은 접수 마감 전날까지만 고를 수 있다', async () => {
    const browseSaved = vi.spyOn(appContainer.resolve('browseSavedSupportProgramsUseCase'), 'execute')
      .mockResolvedValue(supportPrograms.slice(0, 2).map((program) => ({ savedAt: '2026-09-01T09:00:00', program })))
    renderApp('/app/partners/new')
    const form = screen.getByRole('form', { name: '모집글 작성' })

    // 화면에 들어온 것만으로는 관심 공고를 조회하지 않고, 팝업을 열 때 불러옵니다.
    expect(browseSaved).not.toHaveBeenCalled()
    fireEvent.click(within(form).getByRole('button', { name: '관심 공고함에서 선택' }))
    const dialog = await screen.findByRole('dialog', { name: '관심 공고함에서 선택' })
    expect(browseSaved).toHaveBeenCalledTimes(1)
    const results = await within(dialog).findByRole('list', { name: '모집글 관심 공고 목록' })
    fireEvent.click(within(results).getByRole('button', { name: '2026 서울 AI 서비스 사업화 지원사업 관심 공고 선택' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '선택 완료' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(form).getByText('2026 서울 AI 서비스 사업화 지원사업')).toBeTruthy()
    expect(within(form).queryByRole('button', { name: '관심 공고함에서 선택' })).toBeNull()
    const deadline = within(form).getByLabelText('모집 마감일') as HTMLInputElement
    expect(deadline.max).toBe('2026-09-14')
    expect(within(form).getByText(/2026-09-14까지 고를 수 있으며/)).toBeTruthy()

    // 공고 변경은 선택을 풀고 팝업을 다시 엽니다.
    fireEvent.click(within(form).getByRole('button', { name: '공고 변경' }))
    expect(await screen.findByRole('dialog', { name: '관심 공고함에서 선택' })).toBeTruthy()
    // 팝업이 폼 안에 그려지므로 제목 대신 선택한 공고 카드가 사라졌는지 봅니다.
    expect(within(form).queryByLabelText('선택한 공고')).toBeNull()
  })

  it('관심 공고함이 비어 있으면 팝업이 안내하고, 폼에는 관심 공고함 링크가 있다', async () => {
    vi.spyOn(appContainer.resolve('browseSavedSupportProgramsUseCase'), 'execute').mockResolvedValue([])
    renderApp('/app/partners/new')
    const form = screen.getByRole('form', { name: '모집글 작성' })
    expect((within(form).getByRole('link', { name: '관심 공고함' }) as HTMLAnchorElement).getAttribute('href')).toBe('/app/saved-programs')

    fireEvent.click(within(form).getByRole('button', { name: '관심 공고함에서 선택' }))
    const dialog = await screen.findByRole('dialog', { name: '관심 공고함에서 선택' })
    expect(await within(dialog).findByText('관심 공고함에 담은 공고가 없습니다.')).toBeTruthy()
  })

  it('오늘 접수가 끝나는 공고와 접수 중이 아닌 공고는 관심 공고함에 있어도 고를 수 없다', async () => {
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
    vi.spyOn(appContainer.resolve('browseSavedSupportProgramsUseCase'), 'execute').mockResolvedValue([
      { savedAt: '2026-09-01T09:00:00', program: { ...supportPrograms[0]!, applicationEndDate: today } },
      { savedAt: '2026-09-01T09:00:00', program: supportPrograms[5]! },
    ])
    renderApp('/app/partners/new')
    const form = screen.getByRole('form', { name: '모집글 작성' })
    fireEvent.click(within(form).getByRole('button', { name: '관심 공고함에서 선택' }))
    const results = await screen.findByRole('list', { name: '모집글 관심 공고 목록' })
    const closingToday = within(results).getByRole('button', { name: `${supportPrograms[0]!.title} 관심 공고 오늘 접수 마감` }) as HTMLButtonElement
    const closed = within(results).getByRole('button', { name: `${supportPrograms[5]!.title} 관심 공고 접수 중 아님` }) as HTMLButtonElement
    expect(closingToday.disabled).toBe(true)
    expect(closed.disabled).toBe(true)
    expect(within(form).queryByRole('button', { name: '공고 변경' })).toBeNull()
  })

  it('공고 없이 제출하면 등록하지 않고 안내하며, 등록에 성공하면 새 모집글 상세로 이동한다', async () => {
    vi.spyOn(appContainer.resolve('browseSavedSupportProgramsUseCase'), 'execute')
      .mockResolvedValue([{ savedAt: '2026-09-01T09:00:00', program: supportPrograms[0]! }])
    const create = vi.spyOn(appContainer.resolve('createPartnerRecruitmentUseCase'), 'execute')
      .mockResolvedValue({ outcome: 'created', recruitment: partnerRecruitmentDetail })
    renderApp('/app/partners/new')
    const form = screen.getByRole('form', { name: '모집글 작성' })

    fireEvent.click(within(form).getByRole('button', { name: '모집글 등록' }))
    expect(screen.getByRole('alert').textContent).toContain('공고를 먼저 골라')
    expect(create).not.toHaveBeenCalled()

    await pickSavedProgram(form, supportPrograms[0]!.title)
    fireEvent.change(within(form).getByLabelText('모집 마감일'), { target: { value: '2026-09-15' } })
    fireEvent.click(within(form).getByRole('button', { name: '모집글 등록' }))
    expect(screen.getByRole('alert').textContent).toContain('2026-09-14까지')

    fireEvent.change(within(form).getByLabelText('모집 마감일'), { target: { value: '2026-09-14' } })
    chooseOption(within(form).getByLabelText('희망 지역'), '서울')
    fireEvent.change(within(form).getByLabelText('찾는 기업 수'), { target: { value: '2' } })
    fireEvent.change(within(form).getByLabelText(/희망 업력/), { target: { value: '3' } })
    fireEvent.change(within(form).getByLabelText('제목'), { target: { value: 'AI 실증 참여기관 구합니다' } })
    fireEvent.change(within(form).getByLabelText('본문'), { target: { value: '라벨링 운영을 맡아 주실 참여기관을 찾습니다.' } })
    fireEvent.click(within(form).getByRole('button', { name: '모집글 등록' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      sourceCode: 'BIZINFO',
      sourceProgramId: 'fixture-seoul-ai-business',
      title: 'AI 실증 참여기관 구합니다',
      body: '라벨링 운영을 맡아 주실 참여기관을 찾습니다.',
      ownRole: 'PARTICIPANT',
      seekingRole: 'LEAD',
      seekingCount: 2,
      region: '서울',
      minimumCompanyAgeYears: 3,
      capabilities: [],
      recruitmentDeadline: '2026-09-14',
    }))
    expect(await screen.findByRole('heading', { name: '모집글 상세' })).toBeTruthy()
    expect(screen.getByText('AI 실증 과제 데이터 구축·라벨링 참여기관 구합니다')).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('같은 공고에 이미 쓴 모집글이 있으면 서버 안내를 보여 주고 화면에 남는다', async () => {
    vi.spyOn(appContainer.resolve('browseSavedSupportProgramsUseCase'), 'execute')
      .mockResolvedValue([{ savedAt: '2026-09-01T09:00:00', program: supportPrograms[0]! }])
    vi.spyOn(appContainer.resolve('createPartnerRecruitmentUseCase'), 'execute').mockResolvedValue({ outcome: 'already-exists' })
    renderApp('/app/partners/new')
    const form = screen.getByRole('form', { name: '모집글 작성' })

    await pickSavedProgram(form, supportPrograms[0]!.title)
    fireEvent.change(within(form).getByLabelText('모집 마감일'), { target: { value: '2026-09-14' } })
    fireEvent.change(within(form).getByLabelText('제목'), { target: { value: '제목' } })
    fireEvent.change(within(form).getByLabelText('본문'), { target: { value: '본문' } })
    fireEvent.click(within(form).getByRole('button', { name: '모집글 등록' }))

    expect((await screen.findByRole('alert')).textContent).toContain('이미 내 모집글이 있습니다')
    expect(screen.getByRole('heading', { name: '모집글 작성', level: 1 })).toBeTruthy()
  })

  it('작성 화면은 세션 기업을 보여 주고 전국이 맨 앞인 지역 목록과 숫자 입력을 쓰며 제안 설정은 두지 않는다', () => {
    renderApp('/app/partners/new')
    // 우리 기업 정보는 ? 도움말 안에만 있고, 포커스가 오면 말풍선으로 보입니다.
    expect(screen.queryByText('테스트 기업 주식회사')).toBeNull()
    fireEvent.focus(screen.getByRole('button', { name: '모집글에 표시되는 우리 기업 도움말' }))
    const tooltip = screen.getByRole('tooltip')
    expect(within(tooltip).getByText('테스트 기업 주식회사')).toBeTruthy()
    expect(within(tooltip).getByText('사업자 확인')).toBeTruthy()
    expect(within(tooltip).queryByText(/이메일 인증/)).toBeNull()
    expect(within(tooltip).getByText(/참여 제안은 기업을 등록한 회원끼리/)).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()

    const region = screen.getByLabelText('희망 지역')
    expect(selectedValue(region)).toBe('전국')
    expect(optionLabels(region)[0]).toBe('전국')
    expect(optionLabels(region)).toContain('서울')
    chooseOption(region, '부산')
    expect(selectedValue(region)).toBe('부산')
    const seekingCount = screen.getByLabelText('찾는 기업 수') as HTMLInputElement
    expect(seekingCount.type).toBe('number')
    expect(seekingCount.value).toBe('1')
    expect(seekingCount.max).toBe('9')
    const companyAge = screen.getByLabelText(/희망 업력/) as HTMLInputElement
    expect(companyAge.type).toBe('number')
    expect(companyAge.value).toBe('')
    expect(companyAge.placeholder).toBe('무관')

    expect(screen.queryByText('이메일 인증을 마친 기업만 제안 가능')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    // 안내 문구는 ? 도움말 안에만 있고 폼 옆에는 두지 않습니다.
    expect(screen.queryByText(/참여 제안은 기업을 등록한 회원끼리/)).toBeNull()
  })

  it.each(['999', '', 'abc', '101&recruitmentId=999'])('없거나 잘못된 상세 식별자는 다른 글로 대체하지 않는다: %s', async (id) => {
    renderApp(`/app/partners/detail?recruitmentId=${id}`)
    expect(await screen.findByRole('heading', { name: '모집글을 찾을 수 없습니다' })).toBeTruthy()
    expect(screen.queryByRole('form', { name: '참여 제안' })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('참여 제안을 보내면 상태 카드로 바뀌고 제안함으로 이어진다', async () => {
    const send = vi.spyOn(appContainer.resolve('sendPartnerProposalUseCase'), 'execute')
      .mockResolvedValue({ outcome: 'sent', proposal: sentPendingProposal })
    renderApp('/app/partners/detail?recruitmentId=101')
    const proposal = await screen.findByRole('form', { name: '참여 제안' })

    fireEvent.click(within(proposal).getByRole('button', { name: '참여 제안 보내기' }))
    expect(screen.getByRole('alert').textContent).toContain('제안 메시지를 입력')
    expect(send).not.toHaveBeenCalled()

    fireEvent.change(within(proposal).getByLabelText('제안 메시지'), { target: { value: '데이터 구축을 맡겠습니다.' } })
    fireEvent.click(within(proposal).getByLabelText(/기업 기본정보 함께 보내기/))
    fireEvent.click(within(proposal).getByRole('button', { name: '참여 제안 보내기' }))

    await waitFor(() => expect(send).toHaveBeenCalledWith(101, { message: '데이터 구축을 맡겠습니다.', shareProfile: false }))
    const status = await screen.findByRole('region', { name: '내 제안 상태' })
    expect(within(status).getByText(/제안을 보냈습니다 · 응답 대기/)).toBeTruthy()
    expect(within(status).getByRole('link', { name: '제안함 열기' }).getAttribute('href')).toBe('/app/proposals')
    expect(screen.queryByRole('form', { name: '참여 제안' })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('이미 제안한 모집글과 마감된 모집글에는 새 제안을 받지 않는다', async () => {
    const detail = appContainer.resolve('getPartnerRecruitmentDetailUseCase').execute as ReturnType<typeof vi.fn>
    detail.mockResolvedValueOnce({ ...partnerRecruitmentDetail, myProposal: { id: 303, status: 'DECLINED' } })
    renderApp('/app/partners/detail?recruitmentId=101')
    const status = await screen.findByRole('region', { name: '내 제안 상태' })
    expect(within(status).getByText(/거절/)).toBeTruthy()
    expect(within(status).getByText(/다시 제안할 수 없습니다/)).toBeTruthy()

    cleanup()
    detail.mockResolvedValueOnce({ ...partnerRecruitmentDetail, status: 'CLOSED' })
    renderApp('/app/partners/detail?recruitmentId=101')
    const button = await screen.findByRole('button', { name: '모집이 마감됐습니다' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('기업 미등록 회원의 제안 폼은 등록 안내와 함께 잠긴다', async () => {
    renderApp('/app/partners/detail?recruitmentId=101', memberAccount)
    const proposal = await screen.findByRole('form', { name: '참여 제안' })
    expect(within(proposal).getByRole('link', { name: '프로필에서 기업 등록' })).toBeTruthy()
    expect((within(proposal).getByRole('button', { name: '참여 제안 보내기' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('내 모집글 상세는 이 글로 온 제안 요약과 제안함 링크를 보여준다', async () => {
    vi.spyOn(appContainer.resolve('getPartnerRecruitmentDetailUseCase'), 'execute')
      .mockResolvedValue({ ...partnerRecruitmentDetail, id: 104, isMine: true, proposalCount: 2 })
    vi.spyOn(appContainer.resolve('browsePartnerProposalsUseCase'), 'execute').mockResolvedValue(receivedProposalBox)
    renderApp('/app/partners/detail?recruitmentId=104')
    const received = await screen.findByRole('region', { name: '받은 제안' })
    expect(await within(received).findByText('데이터브릿지 주식회사')).toBeTruthy()
    expect(within(received).getByText('응답 대기')).toBeTruthy()
    expect(within(received).getByText('그린푸드랩')).toBeTruthy()
    expect(within(received).getByRole('link', { name: '제안함에서 수락·거절' }).getAttribute('href')).toBe('/app/proposals')
    expect(within(received).getByText('2건')).toBeTruthy()
    // 내 글은 오른쪽 칸 없이 받은 제안이 본문 칸에 있고, 제안 폼은 없습니다.
    expect(screen.queryByRole('form', { name: '참여 제안' })).toBeNull()
    expect(screen.queryByRole('complementary', { name: '참여 제안' })).toBeNull()
  })

  it('내 모집글은 상세의 수정으로 폼을 채워 열고, 수정 저장하면 상세로 돌아온다', async () => {
    vi.spyOn(appContainer.resolve('getPartnerRecruitmentDetailUseCase'), 'execute')
      .mockResolvedValue({ ...partnerRecruitmentDetail, id: 104, isMine: true })
    const update = vi.spyOn(appContainer.resolve('updatePartnerRecruitmentUseCase'), 'execute')
      .mockResolvedValue({ outcome: 'updated', recruitment: { ...partnerRecruitmentDetail, id: 104, isMine: true, title: '수정한 제목' } })
    renderApp('/app/partners/detail?recruitmentId=104')
    fireEvent.click(await screen.findByRole('link', { name: '수정' }))

    const form = await screen.findByRole('form', { name: '모집글 수정' })
    await waitFor(() => expect((within(form).getByLabelText('제목') as HTMLInputElement).value).toBe(partnerRecruitmentDetail.title))
    // 공고는 바꿀 수 없어 관심 공고함 선택 대신 묶인 공고만 보입니다.
    expect(within(form).queryByRole('button', { name: '관심 공고함에서 선택' })).toBeNull()
    expect(within(form).getByText(partnerRecruitmentDetail.program.title)).toBeTruthy()
    expect(within(form).getByRole('button', { name: '라벨링 삭제' })).toBeTruthy()

    fireEvent.change(within(form).getByLabelText('제목'), { target: { value: '수정한 제목' } })
    fireEvent.click(within(form).getByRole('button', { name: '수정 저장' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(104, {
      title: '수정한 제목',
      body: partnerRecruitmentDetail.body,
      ownRole: 'LEAD',
      seekingRole: 'PARTICIPANT',
      seekingCount: 1,
      region: '서울',
      minimumCompanyAgeYears: null,
      capabilities: ['데이터 구축', '라벨링'],
      recruitmentDeadline: '2026-09-20',
    }))
    expect(await screen.findByRole('heading', { name: '모집글 상세' })).toBeTruthy()
  })

  it('내 모집글 탭은 내 글만 최근 등록순으로 읽어 마감된 글을 뒤로 보내고 카드에서 마감한다', async () => {
    const mine = partnerRecruitmentPage.recruitments.find((item) => item.isMine)!
    const closedMine = { ...mine, id: 105, title: '이미 마감된 내 글', status: 'CLOSED' as const, proposalCount: 3 }
    const browse = vi.spyOn(appContainer.resolve('browsePartnerRecruitmentsUseCase'), 'execute')
      .mockResolvedValue({ ...partnerRecruitmentPage, recruitments: [closedMine, mine], total: 2 })
    const close = vi.spyOn(appContainer.resolve('closePartnerRecruitmentUseCase'), 'execute')
      .mockResolvedValue({ outcome: 'closed', recruitment: { ...partnerRecruitmentDetail, id: mine.id, isMine: true, status: 'CLOSED' } })
    renderApp('/app/partners')
    fireEvent.click(within(screen.getByRole('navigation', { name: '파트너 관리 탭' })).getByRole('link', { name: '내 모집글' }))

    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(
      { keyword: '', seekingRoles: [], regions: [], mineOnly: true, sourceCode: '', sort: 'RECENT', page: 1 },
      expect.any(AbortSignal),
    ))
    const cards = await screen.findAllByRole('article')
    expect(cards).toHaveLength(2)
    // 모집 중인 글이 앞, 마감된 글이 뒤입니다. 마감된 글에는 수정·마감이 없습니다.
    expect(cards[0]!.getAttribute('aria-label')).toBe(mine.title)
    expect(within(cards[1]!).getByText('모집 마감')).toBeTruthy()
    expect(within(cards[1]!).queryByRole('button', { name: '마감' })).toBeNull()
    expect(within(cards[1]!).getByText('받은 제안 3건')).toBeTruthy()
    expect(within(cards[0]!).getByRole('link', { name: '수정' }).getAttribute('href')).toBe(`/app/partners/edit?recruitmentId=${mine.id}`)
    expect(screen.queryByRole('searchbox', { name: '모집글 검색' })).toBeNull()

    fireEvent.click(within(cards[0]!).getByRole('button', { name: '마감' }))
    const dialog = screen.getByRole('dialog', { name: '모집을 마감할까요?' })
    fireEvent.click(within(dialog).getByRole('button', { name: '마감' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith(mine.id))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('button', { name: '마감' })).toBeNull()
    expect(screen.getAllByText('모집 마감')).toHaveLength(2)
  })

  it('모집글 상세의 관심 공고에 추가 버튼은 묶인 공고를 담고 빼며 결과를 안내한다', async () => {
    vi.spyOn(appContainer.resolve('checkSavedSupportProgramUseCase'), 'execute').mockResolvedValue(false)
    const save = vi.spyOn(appContainer.resolve('saveSupportProgramUseCase'), 'execute')
      .mockResolvedValue({ outcome: 'saved', saved: { savedAt: '2026-09-01T09:00:00', program: supportPrograms[0]! } })
    const remove = vi.spyOn(appContainer.resolve('removeSavedSupportProgramUseCase'), 'execute').mockResolvedValue(undefined)
    renderApp('/app/partners/detail?recruitmentId=101')

    const add = await screen.findByRole('button', { name: '관심 공고에 추가' })
    expect(add.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(add)
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      sourceCode: partnerRecruitmentDetail.program.sourceCode,
      sourceProgramId: partnerRecruitmentDetail.program.sourceProgramId,
    }))
    expect(await screen.findByText('관심 공고함에 담았습니다.')).toBeTruthy()
    const removeButton = await screen.findByRole('button', { name: '관심 공고에서 빼기' })
    expect(removeButton.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(removeButton)
    await waitFor(() => expect(remove).toHaveBeenCalledWith({
      sourceCode: partnerRecruitmentDetail.program.sourceCode,
      sourceProgramId: partnerRecruitmentDetail.program.sourceProgramId,
    }))
    expect(await screen.findByText('관심 공고함에서 뺐습니다.')).toBeTruthy()
    expect(await screen.findByRole('button', { name: '관심 공고에 추가' })).toBeTruthy()
  })

  it('남의 글이나 마감된 내 글은 수정 화면 대신 안내를 보여 준다', async () => {
    renderApp('/app/partners/detail?recruitmentId=101')
    expect(await screen.findByRole('button', { name: '모집글 저장 · 준비 중' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '수정' })).toBeNull()
    expect(screen.queryByRole('button', { name: '마감' })).toBeNull()

    cleanup()
    renderApp('/app/partners/edit?recruitmentId=101')
    expect(await screen.findByText('내가 쓴 모집글만 고칠 수 있습니다')).toBeTruthy()
    expect(screen.queryByRole('form', { name: '모집글 수정' })).toBeNull()
  })

  it('내 모집글은 마감 확인을 거쳐 마감되고 수정·마감 버튼이 사라진다', async () => {
    vi.spyOn(appContainer.resolve('getPartnerRecruitmentDetailUseCase'), 'execute')
      .mockResolvedValue({ ...partnerRecruitmentDetail, id: 104, isMine: true })
    const close = vi.spyOn(appContainer.resolve('closePartnerRecruitmentUseCase'), 'execute')
      .mockResolvedValue({ outcome: 'closed', recruitment: { ...partnerRecruitmentDetail, id: 104, isMine: true, status: 'CLOSED' } })
    renderApp('/app/partners/detail?recruitmentId=104')
    fireEvent.click(await screen.findByRole('button', { name: '마감' }))
    expect(close).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog', { name: '모집을 마감할까요?' })
    fireEvent.click(within(dialog).getByRole('button', { name: '마감' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith(104))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('button', { name: '마감' })).toBeNull()
    expect(screen.queryByRole('link', { name: '수정' })).toBeNull()
    expect(screen.getAllByText('모집 마감').length).toBeGreaterThan(0)
  })

  it('아직 화면이 없는 기업 프로필 보기는 링크로 만들지 않는다', async () => {
    renderApp('/app/partners/detail?recruitmentId=101')

    expect(await screen.findByText('기업 프로필 보기 · 준비 중')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /기업 프로필 보기/ })).toBeNull()
  })
})

describe('제안함 화면', () => {
  beforeEach(() => {
    vi.spyOn(appContainer.resolve('browsePartnerRecruitmentsUseCase'), 'execute').mockResolvedValue(partnerRecruitmentPage)
    vi.spyOn(appContainer.resolve('browsePartnerProposalsUseCase'), 'execute')
      .mockImplementation(async (box) => (box === 'sent' ? sentProposalBox : receivedProposalBox))
  })

  it('사이드바 제안함 배지는 받은 제안 대기 건수를 보여주고 받은 제안함으로 이동한다', async () => {
    renderApp('/app/partners', companyAccount)
    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    // 파트너 관리 메뉴가 대기 건수를 배지로 보여 주고, 제안함은 머리글 아래 탭으로 갑니다.
    const menu = await within(sidebar).findByRole('link', { name: /파트너 관리/ })
    expect(menu.textContent).toContain('1')
    expect(menu.getAttribute('href')).toBe('/app/partners')

    const proposalsTab = within(screen.getByRole('navigation', { name: '파트너 관리 탭' })).getByRole('link', { name: /제안함/ })
    expect(proposalsTab.textContent).toContain('1')
    fireEvent.click(proposalsTab)
    expect(screen.getByRole('tablist', { name: '제안함 종류' })).toBeTruthy()
    const panel = await screen.findByRole('tabpanel', { name: '받은 제안' })
    expect(within(panel).getAllByRole('article')).toHaveLength(2)
    expect(within(panel).getByRole('article', { name: '데이터브릿지 주식회사 제안' })).toBeTruthy()
    // 수락 전에는 담당자 연락처가 없고, 수락된 제안에만 이메일이 보입니다.
    const pending = within(panel).getByRole('article', { name: '데이터브릿지 주식회사 제안' })
    expect(within(pending).queryByText('수락됨 · 담당자 연락처')).toBeNull()
    expect(within(pending).queryByRole('link', { name: /@/ })).toBeNull()
    const accepted = within(panel).getByRole('article', { name: '그린푸드랩 제안' })
    expect(within(accepted).getByRole('link', { name: 'manager@greenfood.example' }).getAttribute('href')).toBe('mailto:manager@greenfood.example')
    expect(within(accepted).queryByRole('button', { name: '수락' })).toBeNull()
  })

  it('받은 제안은 확인을 거쳐 수락하고 결과로 카드가 바뀐다', async () => {
    const respond = vi.spyOn(appContainer.resolve('respondPartnerProposalUseCase'), 'execute')
      .mockResolvedValue({ outcome: 'updated', proposal: { ...receivedPendingProposal, ...receivedAcceptedProposal, id: 301, counterpart: { ...receivedAcceptedProposal.counterpart, companyName: '데이터브릿지 주식회사' } } })
    renderApp('/app/proposals', companyAccount)
    const pending = await screen.findByRole('article', { name: '데이터브릿지 주식회사 제안' })

    fireEvent.click(within(pending).getByRole('button', { name: '수락' }))
    const confirm = within(pending).getByRole('group', { name: '수락 확인' })
    expect(confirm.textContent).toContain('담당자 이메일과 기업 기본정보가 서로에게 공개')
    fireEvent.click(within(confirm).getByRole('button', { name: '취소' }))
    expect(within(pending).queryByRole('group', { name: '수락 확인' })).toBeNull()
    expect(respond).not.toHaveBeenCalled()

    fireEvent.click(within(pending).getByRole('button', { name: '거절' }))
    expect(within(pending).getByRole('group', { name: '거절 확인' })).toBeTruthy()
    fireEvent.click(within(pending).getByRole('button', { name: '취소' }))
    fireEvent.click(within(pending).getByRole('button', { name: '수락' }))
    fireEvent.click(within(pending).getByRole('button', { name: '수락 확정' }))

    await waitFor(() => expect(respond).toHaveBeenCalledWith(301, 'accept'))
    expect(await within(pending).findByText('수락')).toBeTruthy()
    expect(within(pending).getByRole('link', { name: 'manager@greenfood.example' })).toBeTruthy()
    expect(within(pending).queryByRole('button', { name: '거절' })).toBeNull()
    // 받은 제안함은 Redux에 있으므로 사이드바 배지도 다시 읽지 않고 함께 사라집니다.
    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    await waitFor(() => expect(within(sidebar).getByRole('link', { name: /파트너 관리/ }).textContent).not.toContain('1'))
    const browse = appContainer.resolve('browsePartnerProposalsUseCase').execute as ReturnType<typeof vi.fn>
    expect(browse.mock.calls.filter(([box]) => box === 'received')).toHaveLength(1)
  })

  it('받은 제안함은 사이드바·제안함·모집글 상세가 같은 상자를 공유해 한 번만 조회한다', async () => {
    vi.spyOn(appContainer.resolve('getPartnerRecruitmentDetailUseCase'), 'execute')
      .mockResolvedValue({ ...partnerRecruitmentDetail, id: 104, isMine: true, proposalCount: 2 })
    const browse = appContainer.resolve('browsePartnerProposalsUseCase').execute as ReturnType<typeof vi.fn>
    renderApp('/app/proposals', companyAccount)
    await screen.findByRole('tabpanel', { name: '받은 제안' })

    const pending = screen.getByRole('article', { name: '데이터브릿지 주식회사 제안' })
    fireEvent.click(within(pending).getByRole('link', { name: receivedPendingProposal.recruitment.title }))
    const received = await screen.findByRole('region', { name: '받은 제안' })
    expect(await within(received).findByText('데이터브릿지 주식회사')).toBeTruthy()
    expect(browse.mock.calls.filter(([box]) => box === 'received')).toHaveLength(1)
  })

  it('보낸 제안은 철회할 수 있고 이미 처리된 제안이면 안내하고 다시 읽는다', async () => {
    const browse = appContainer.resolve('browsePartnerProposalsUseCase').execute as ReturnType<typeof vi.fn>
    const respond = vi.spyOn(appContainer.resolve('respondPartnerProposalUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'not-pending' })
    renderApp('/app/proposals', companyAccount)
    await screen.findByRole('tabpanel', { name: '받은 제안' })

    fireEvent.click(screen.getByRole('tab', { name: '보낸 제안' }))
    const panel = await screen.findByRole('tabpanel', { name: '보낸 제안' })
    const pending = within(panel).getByRole('article', { name: '데이터브릿지 주식회사 제안' })
    const declined = within(panel).getByRole('article', { name: '비전솔루션 제안' })
    expect(within(declined).queryByRole('button')).toBeNull()
    expect(within(declined).getByText('거절')).toBeTruthy()

    fireEvent.click(within(pending).getByRole('button', { name: '철회' }))
    fireEvent.click(within(pending).getByRole('button', { name: '철회 확정' }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith(303, 'withdraw'))
    expect((await screen.findByRole('alert')).textContent).toContain('이미 처리됐거나 만료된')
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith('sent', expect.any(AbortSignal)))
  })

  it('보낸 제안 탭을 봐도 받은 제안 배지는 받은 제안함의 대기 건수만 보여 준다', async () => {
    const browse = appContainer.resolve('browsePartnerProposalsUseCase').execute as ReturnType<typeof vi.fn>
    // 받은 제안은 없고 내가 보낸 대기 제안만 하나 있는 상태입니다.
    browse.mockImplementation(async (box) => (box === 'sent' ? sentProposalBox : { box: 'received', proposals: [], pendingCount: 0 }))
    renderApp('/app/proposals', companyAccount)
    await screen.findByText(/아직 받은 제안이 없습니다/)
    expect(screen.getByRole('tab', { name: '받은 제안' })).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '보낸 제안' }))
    await screen.findByRole('tabpanel', { name: '보낸 제안' })
    expect(screen.getByRole('tab', { name: '받은 제안' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /받은 제안 · 대기/ })).toBeNull()
  })

  it('기업을 등록하지 않은 회원은 제안함에서 등록 안내를 보고 조회하지 않는다', () => {
    const browse = appContainer.resolve('browsePartnerProposalsUseCase').execute as ReturnType<typeof vi.fn>
    renderApp('/app/proposals', memberAccount)
    expect(screen.getByRole('region', { name: '기업 등록 필요' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '제안 없음' })).toBeTruthy()
    expect(browse).not.toHaveBeenCalled()
  })
})

/** 로그인 전 화면은 비로그인으로, 작업 화면은 회원으로 시작합니다. `account`를 넘기면 그 계정으로 고정합니다. */
/** 회원가입 폼의 이메일을 채우고 인증번호 발송·확인 대역으로 인증을 마칩니다. 이후 비밀번호만 넣으면 가입할 수 있습니다. */
async function verifySignupEmail(form: HTMLElement, email: string) {
  vi.spyOn(appContainer.resolve('sendSignupEmailCodeUseCase'), 'execute').mockResolvedValue({ outcome: 'sent' })
  vi.spyOn(appContainer.resolve('verifySignupEmailCodeUseCase'), 'execute').mockResolvedValue({ outcome: 'verified', passToken: 'b'.repeat(43) })
  fireEvent.change(within(form).getByLabelText('이메일'), { target: { value: email } })
  fireEvent.click(within(form).getByRole('button', { name: '인증번호 받기' }))
  fireEvent.change(await within(form).findByLabelText('인증번호'), { target: { value: '482137' } })
  fireEvent.click(within(form).getByRole('button', { name: '확인' }))
  await within(form).findByText('인증됨')
}

function renderApp(initialEntry: string, account: Account | null = defaultAccountFor(initialEntry)) {
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

function defaultAccountFor(initialEntry: string): Account | null {
  if (['/login', '/signup', '/forgot-password', '/reset-password'].some((path) => initialEntry.startsWith(path))) return null
  if (initialEntry.startsWith('/app/admin')) return adminAccount
  // 파트너 모집 화면은 기업을 등록한 회원 기준으로 확인하고, 미등록 회원은 각 테스트가 따로 넘깁니다.
  return initialEntry.startsWith('/app/partners') || initialEntry.startsWith('/app/proposals') ? companyAccount : memberAccount
}
