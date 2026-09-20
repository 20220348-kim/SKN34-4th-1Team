import { afterEach, describe, expect, it, vi } from 'vitest'

import { AccountRepositoryImpl } from '../../repositories/AccountRepositoryImpl'
import { createMemorySessionHintStorage } from '../../storage/sessionHintStorage'
import {
  AccountApiError,
  changePasswordApi,
  deleteAccountApi,
  devLogInApi,
  getAccountDeletionPreviewApi,
  getCurrentAccountApi,
  logInApi,
  logOutApi,
  requestPasswordResetApi,
  resetPasswordApi,
  sendSignupEmailCodeApi,
  signUpApi,
  verifySignupEmailCodeApi,
} from '../accountApi'

afterEach(() => {
  vi.unstubAllGlobals()
})

const account = { email: 'manager@company.co.kr', role: 'USER' as const, tier: 'MEMBER' as const, emailVerified: false, hasPassword: true, company: null }
const sessionResponse = { expiresAt: '2026-10-06T12:00:00+09:00', account }
const logInCommand = { email: 'manager@company.co.kr', password: 'password1', rememberMe: true }

describe('signUpApi', () => {
  it('posts the signup command as JSON with cookies and accepts the created session response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse, 201))
    vi.stubGlobal('fetch', fetchMock)

    await expect(signUpApi({ email: 'manager@company.co.kr', password: 'password1', emailPassToken: 'a'.repeat(43) })).resolves.toEqual(sessionResponse)

    const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new URL(requestUrl).pathname).toBe('/api/v1/auth/signup')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(String(init.body))).toEqual({ email: 'manager@company.co.kr', password: 'password1', emailPassToken: 'a'.repeat(43) })
  })

  it('returns the conflict code of a duplicate email', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problemResponse(409, 'EMAIL_ALREADY_REGISTERED')))

    await expect(signUpApi({ email: 'manager@company.co.kr', password: 'password1', emailPassToken: 'a'.repeat(43) }))
      .rejects.toMatchObject({ name: 'AccountApiError', status: 409, code: 'EMAIL_ALREADY_REGISTERED' })
  })
})

describe('logInApi and devLogInApi', () => {
  it('posts the login command as JSON with cookies and validates the session response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse))
    vi.stubGlobal('fetch', fetchMock)

    await expect(logInApi(logInCommand)).resolves.toEqual(sessionResponse)

    const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new URL(requestUrl).pathname).toBe('/api/v1/auth/login')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual(logInCommand)
  })

  it('posts the developer login with the requested seed role', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse))
    vi.stubGlobal('fetch', fetchMock)

    await expect(devLogInApi('USER')).resolves.toEqual(sessionResponse)

    const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new URL(requestUrl).pathname).toBe('/api/v1/auth/dev-login')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(String(init.body))).toEqual({ role: 'USER' })
  })

  it('rejects a session response without an expiry, tier, or with an unknown role', async () => {
    const { tier: _tier, ...accountWithoutTier } = account
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ account }))
      .mockResolvedValueOnce(jsonResponse({ ...sessionResponse, account: accountWithoutTier }))
      .mockResolvedValueOnce(jsonResponse({ ...sessionResponse, account: { ...account, role: 'ROOT' } })))

    await expect(logInApi(logInCommand)).rejects.toThrow()
    await expect(logInApi(logInCommand)).rejects.toThrow()
    await expect(logInApi(logInCommand)).rejects.toThrow()
  })

  it('returns the status, problem code, and retry hint of a failed login', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('gateway', { status: 502 }))
      .mockResolvedValueOnce(problemResponse(429, 'LOGIN_RATE_LIMITED', { retryAfterSeconds: 30 })))

    await expect(logInApi(logInCommand))
      .rejects.toMatchObject({ status: 502, code: null, retryAfterSeconds: null })
    await expect(logInApi(logInCommand))
      .rejects.toMatchObject({ status: 429, code: 'LOGIN_RATE_LIMITED', retryAfterSeconds: 30 })
  })
})

describe('account profile apis', () => {
  it('sends the password change, reads the deletion preview, and deletes with the session cookie', async () => {
    const preview = { hasCompany: true, openRecruitmentCount: 2, receivedPendingProposalCount: 3, sentPendingProposalCount: 1 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(preview))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(changePasswordApi('new-password-2')).resolves.toBeUndefined()
    await expect(getAccountDeletionPreviewApi()).resolves.toEqual(preview)
    await expect(deleteAccountApi('password1')).resolves.toBeUndefined()

    const calls = fetchMock.mock.calls as [string, RequestInit][]
    expect(new URL(calls[0]![0]).pathname).toBe('/api/v1/me/password')
    expect(calls[0]![1].method).toBe('PUT')
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ newPassword: 'new-password-2' })
    expect(new URL(calls[1]![0]).pathname).toBe('/api/v1/me/deletion-preview')
    expect(calls[1]![1].cache).toBe('no-store')
    expect(new URL(calls[2]![0]).pathname).toBe('/api/v1/me')
    expect(calls[2]![1].method).toBe('DELETE')
    expect(calls[2]![1].credentials).toBe('include')
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ password: 'password1' })

    // 비밀번호가 없는 소셜 가입 계정은 password 없이 보냅니다.
    await expect(deleteAccountApi(null)).resolves.toBeUndefined()
    expect(JSON.parse(String(calls[3]![1].body))).toEqual({})
  })

  it('maps rate limits and a wrong deletion password to outcomes and clears the hint only after deletion', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(problemResponse(401, 'AUTHENTICATION_REQUIRED'))
      .mockResolvedValueOnce(problemResponse(429, 'LOGIN_RATE_LIMITED', { retryAfterSeconds: 30 }))
      .mockResolvedValueOnce(problemResponse(422, 'CURRENT_PASSWORD_MISMATCH'))
      .mockResolvedValueOnce(problemResponse(500, null))
      .mockResolvedValueOnce(new Response(null, { status: 204 })))
    const storage = createMemorySessionHintStorage(true)
    const repository = new AccountRepositoryImpl({ sessionHintStorage: storage })

    // 비밀번호 변경은 현재 비밀번호를 받지 않으므로 401 같은 실패는 결과가 아니라 예외입니다.
    await expect(repository.changePassword('new-password-2')).rejects.toMatchObject({ status: 401 })
    await expect(repository.changePassword('new-password-2')).resolves.toEqual({ outcome: 'rate-limited', retryAfterSeconds: 30 })
    await expect(repository.deleteAccount('wrong')).resolves.toEqual({ outcome: 'current-password-mismatch' })
    await expect(repository.deleteAccount('password1')).rejects.toBeInstanceOf(AccountApiError)
    expect(storage.hasSession()).toBe(true)
    await expect(repository.deleteAccount('password1')).resolves.toEqual({ outcome: 'deleted' })
    expect(storage.hasSession()).toBe(false)
  })
})

describe('logOutApi and getCurrentAccountApi', () => {
  it('sends the session cookie instead of a bearer header and unwraps the current account', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ account }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getCurrentAccountApi()).resolves.toEqual(account)
    await expect(logOutApi()).resolves.toBeUndefined()

    const [, meInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    const [logoutUrl, logoutInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(meInit.headers).toEqual({ Accept: 'application/json' })
    expect(meInit.credentials).toBe('include')
    expect(meInit.cache).toBe('no-store')
    expect(new URL(logoutUrl).pathname).toBe('/api/v1/auth/logout')
    expect(logoutInit.method).toBe('POST')
    expect(logoutInit.credentials).toBe('include')
  })
})

describe('AccountRepositoryImpl', () => {
  it('marks the session hint after a successful login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(sessionResponse)))
    const storage = createMemorySessionHintStorage()
    const repository = new AccountRepositoryImpl({ sessionHintStorage: storage })

    const result = await repository.logIn(logInCommand)

    expect(result).toEqual({ outcome: 'session', session: sessionResponse })
    expect(storage.hasSession()).toBe(true)
  })

  it('marks the hint after the developer login and surfaces a disabled endpoint as an error', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(sessionResponse))
      .mockResolvedValueOnce(new Response(null, { status: 404 })))
    const storage = createMemorySessionHintStorage()
    const repository = new AccountRepositoryImpl({ sessionHintStorage: storage })

    await expect(repository.logInAsDeveloper('ADMIN')).resolves.toEqual(sessionResponse)
    expect(storage.hasSession()).toBe(true)
    await expect(repository.logInAsDeveloper('ADMIN')).rejects.toMatchObject({ name: 'AccountApiError', status: 404 })
  })

  it('maps a duplicate email and rate limits to signup outcomes, marks the hint only on success', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(problemResponse(409, 'EMAIL_ALREADY_REGISTERED'))
      .mockResolvedValueOnce(problemResponse(429, 'LOGIN_RATE_LIMITED', { retryAfterSeconds: 30 }))
      .mockResolvedValueOnce(problemResponse(400, 'VALIDATION_FAILED'))
      .mockResolvedValueOnce(jsonResponse(sessionResponse, 201)))
    const storage = createMemorySessionHintStorage()
    const repository = new AccountRepositoryImpl({ sessionHintStorage: storage })
    const command = { email: 'manager@company.co.kr', password: 'password1', emailPassToken: 'a'.repeat(43) }

    await expect(repository.signUp(command)).resolves.toEqual({ outcome: 'email-taken' })
    await expect(repository.signUp(command)).resolves.toEqual({ outcome: 'rate-limited', retryAfterSeconds: 30 })
    await expect(repository.signUp(command)).rejects.toBeInstanceOf(AccountApiError)
    expect(storage.hasSession()).toBe(false)
    await expect(repository.signUp(command)).resolves.toEqual({ outcome: 'session', session: sessionResponse })
    expect(storage.hasSession()).toBe(true)
  })

  it('maps 401, suspension, and rate limits to login outcomes and rethrows other failures', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(problemResponse(401, 'INVALID_CREDENTIALS'))
      .mockResolvedValueOnce(problemResponse(403, 'ACCOUNT_SUSPENDED'))
      .mockResolvedValueOnce(problemResponse(429, 'LOGIN_RATE_LIMITED', { retryAfterSeconds: 60 }))
      .mockResolvedValueOnce(problemResponse(403, 'SESSION_ORIGIN_REJECTED'))
      .mockResolvedValueOnce(problemResponse(500, null)))
    const storage = createMemorySessionHintStorage()
    const repository = new AccountRepositoryImpl({ sessionHintStorage: storage })

    await expect(repository.logIn(logInCommand)).resolves.toEqual({ outcome: 'invalid-credentials' })
    await expect(repository.logIn(logInCommand)).resolves.toEqual({ outcome: 'suspended' })
    await expect(repository.logIn(logInCommand)).resolves.toEqual({ outcome: 'rate-limited', retryAfterSeconds: 60 })
    await expect(repository.logIn(logInCommand)).rejects.toBeInstanceOf(AccountApiError)
    await expect(repository.logIn(logInCommand)).rejects.toBeInstanceOf(AccountApiError)
    expect(storage.hasSession()).toBe(false)
  })

  it('restores the account when the hint is set and clears the hint when the session is gone or suspended', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ account }))
      .mockResolvedValueOnce(problemResponse(401, 'AUTHENTICATION_REQUIRED'))
      .mockResolvedValueOnce(problemResponse(403, 'ACCOUNT_SUSPENDED')))
    const storage = createMemorySessionHintStorage(true)
    const repository = new AccountRepositoryImpl({ sessionHintStorage: storage })

    await expect(repository.getCurrentAccount()).resolves.toEqual(account)
    await expect(repository.getCurrentAccount()).resolves.toBeNull()
    expect(storage.hasSession()).toBe(false)

    storage.markSignedIn()
    await expect(repository.getCurrentAccount()).resolves.toBeNull()
    expect(storage.hasSession()).toBe(false)
  })

  it('does not call the API without a session hint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const repository = new AccountRepositoryImpl({ sessionHintStorage: createMemorySessionHintStorage() })

    await expect(repository.getCurrentAccount()).resolves.toBeNull()
    await expect(repository.logOut()).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clears the hint on logout even if the server session is already gone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problemResponse(401, 'AUTHENTICATION_REQUIRED')))
    const storage = createMemorySessionHintStorage(true)
    const repository = new AccountRepositoryImpl({ sessionHintStorage: storage })

    await expect(repository.logOut()).resolves.toBeUndefined()
    expect(storage.hasSession()).toBe(false)
  })
})

describe('social login apis', () => {
  it('builds the provider start url for a top-level navigation without calling the API', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const repository = new AccountRepositoryImpl({ sessionHintStorage: createMemorySessionHintStorage() })

    expect(repository.oauthStartUrl('kakao')).toMatch(/\/api\/v1\/auth\/oauth\/kakao\/authorize$/)
    expect(repository.oauthStartUrl('google')).toMatch(/\/api\/v1\/auth\/oauth\/google\/authorize$/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('marks the session hint before reading the account after the server callback and clears it without a session', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ account }))
      .mockResolvedValueOnce(problemResponse(401, 'AUTHENTICATION_REQUIRED')))
    const storage = createMemorySessionHintStorage()
    const repository = new AccountRepositoryImpl({ sessionHintStorage: storage })

    await expect(repository.completeOAuthSignIn()).resolves.toEqual(account)
    expect(storage.hasSession()).toBe(true)
    await expect(repository.completeOAuthSignIn()).resolves.toBeNull()
    expect(storage.hasSession()).toBe(false)
  })
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function problemResponse(status: number, code: string | null, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ status, code, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })
}

describe('password reset apis', () => {
  it('posts the reset request and the confirmation without a session and accepts empty 204 responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestPasswordResetApi('manager@company.co.kr')).resolves.toBeUndefined()
    await expect(resetPasswordApi('a'.repeat(43), 'new-password-2')).resolves.toBeUndefined()

    const calls = fetchMock.mock.calls as [string, RequestInit][]
    expect(new URL(calls[0]![0]).pathname).toBe('/api/v1/auth/password-reset')
    expect(calls[0]![1].method).toBe('POST')
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ email: 'manager@company.co.kr' })
    expect(new URL(calls[1]![0]).pathname).toBe('/api/v1/auth/password-reset/confirm')
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ token: 'a'.repeat(43), newPassword: 'new-password-2' })
  })

  it('maps the unavailable mail server and the rejected token to results in the repository', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(problemResponse(503, 'PASSWORD_RESET_MAIL_UNAVAILABLE'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(problemResponse(422, 'PASSWORD_RESET_TOKEN_INVALID')))
    const repository = new AccountRepositoryImpl({ sessionHintStorage: createMemorySessionHintStorage() })

    await expect(repository.requestPasswordReset('manager@company.co.kr')).resolves.toEqual({ outcome: 'mail-unavailable' })
    await expect(repository.requestPasswordReset('manager@company.co.kr')).resolves.toEqual({ outcome: 'requested' })
    await expect(repository.resetPassword('a'.repeat(43), 'new-password-2')).resolves.toEqual({ outcome: 'token-invalid' })
  })
})

describe('signup email code apis', () => {
  it('posts the send and verify requests without a session and parses the pass token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ passToken: 'b'.repeat(43), expiresAt: '2026-09-13T18:00:00+09:00' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendSignupEmailCodeApi('manager@company.co.kr')).resolves.toBeUndefined()
    await expect(verifySignupEmailCodeApi('manager@company.co.kr', '482137')).resolves.toEqual({ passToken: 'b'.repeat(43), expiresAt: '2026-09-13T18:00:00+09:00' })

    const calls = fetchMock.mock.calls as [string, RequestInit][]
    expect(new URL(calls[0]![0]).pathname).toBe('/api/v1/auth/signup/email-code')
    expect(calls[0]![1].method).toBe('POST')
    expect(calls[0]![1].credentials).toBeUndefined()
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ email: 'manager@company.co.kr' })
    expect(new URL(calls[1]![0]).pathname).toBe('/api/v1/auth/signup/email-code/verify')
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ email: 'manager@company.co.kr', code: '482137' })
  })

  it('maps taken emails, unavailable mail, wrong or expired codes and a stale pass to results in the repository', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(problemResponse(409, 'EMAIL_ALREADY_REGISTERED'))
      .mockResolvedValueOnce(problemResponse(503, 'EMAIL_VERIFICATION_MAIL_UNAVAILABLE'))
      .mockResolvedValueOnce(problemResponse(429, 'EMAIL_CODE_RATE_LIMITED', { retryAfterSeconds: 40 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(problemResponse(422, 'EMAIL_CODE_INVALID'))
      .mockResolvedValueOnce(problemResponse(422, 'EMAIL_CODE_EXPIRED'))
      .mockResolvedValueOnce(jsonResponse({ passToken: 'b'.repeat(43), expiresAt: '2026-09-13T18:00:00+09:00' }))
      .mockResolvedValueOnce(problemResponse(422, 'EMAIL_VERIFICATION_REQUIRED')))
    const repository = new AccountRepositoryImpl({ sessionHintStorage: createMemorySessionHintStorage() })

    await expect(repository.sendSignupEmailCode('manager@company.co.kr')).resolves.toEqual({ outcome: 'email-taken' })
    await expect(repository.sendSignupEmailCode('manager@company.co.kr')).resolves.toEqual({ outcome: 'mail-unavailable' })
    await expect(repository.sendSignupEmailCode('manager@company.co.kr')).resolves.toEqual({ outcome: 'rate-limited', retryAfterSeconds: 40 })
    await expect(repository.sendSignupEmailCode('manager@company.co.kr')).resolves.toEqual({ outcome: 'sent' })
    await expect(repository.verifySignupEmailCode('manager@company.co.kr', '000000')).resolves.toEqual({ outcome: 'code-invalid' })
    await expect(repository.verifySignupEmailCode('manager@company.co.kr', '000000')).resolves.toEqual({ outcome: 'code-expired' })
    await expect(repository.verifySignupEmailCode('manager@company.co.kr', '482137')).resolves.toEqual({ outcome: 'verified', passToken: 'b'.repeat(43) })
    await expect(repository.signUp({ email: 'manager@company.co.kr', password: 'password1', emailPassToken: 'b'.repeat(43) }))
      .resolves.toEqual({ outcome: 'verification-required' })
  })
})
