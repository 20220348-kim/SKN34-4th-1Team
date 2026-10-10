import { apiRequest } from './client'
import { changePassword, deleteAccount, getDeletionPreview, readOAuthProviders, requestPasswordReset, resetPassword, sendSignupEmailCode, verifyPasswordResetCode, verifySignupEmailCode } from './account'

jest.mock('./client', () => ({ apiRequest: jest.fn() }))
beforeEach(() => jest.mocked(apiRequest).mockReset())

test('signup email verification returns only a validated token and expiry', async () => {
  const signal = new AbortController().signal
  const verified = { passToken: 'p'.repeat(43), expiresAt: '2026-10-04T10:00:00+09:00' }
  jest.mocked(apiRequest).mockResolvedValue({ ...verified, ignored: 'external field' })
  await expect(verifySignupEmailCode('owner@example.com', '123456', signal)).resolves.toEqual(verified)
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/auth/signup/email-code/verify', { method: 'POST', body: { email: 'owner@example.com', code: '123456' }, signal })
  jest.mocked(apiRequest).mockResolvedValue({ ...verified, expiresAt: 'invalid' })
  await expect(verifySignupEmailCode('owner@example.com', '123456')).rejects.toThrow()
  jest.mocked(apiRequest).mockResolvedValue({ ...verified, passToken: 'invalid' })
  await expect(verifySignupEmailCode('owner@example.com', '123456')).rejects.toThrow()
})

test('requesting a code forwards cancellation and does not hide send failures', async () => {
  const failure = new Error('send unavailable'), signal = new AbortController().signal
  jest.mocked(apiRequest).mockRejectedValue(failure)
  await expect(sendSignupEmailCode('owner@example.com', signal)).rejects.toBe(failure)
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/auth/signup/email-code', { method: 'POST', body: { email: 'owner@example.com' }, signal })
})

test('OAuth discovery exposes only supported provider identities, never supplied start URLs', async () => {
  jest.mocked(apiRequest).mockResolvedValue({ providers: [{ provider: 'kakao', startUrl: 'https://untrusted.test' }] })
  await expect(readOAuthProviders()).resolves.toEqual(['kakao'])
  jest.mocked(apiRequest).mockResolvedValue({ providers: [{ provider: 'unknown' }] })
  await expect(readOAuthProviders()).rejects.toThrow()
  jest.mocked(apiRequest).mockResolvedValue({ providers: [{ provider: 'google' }, { provider: 'google' }] })
  await expect(readOAuthProviders()).rejects.toThrow()
})

test('profile requests retain Bearer ownership and omit a nonexistent social password', async () => {
  const signal = new AbortController().signal
  jest.mocked(apiRequest).mockResolvedValue({ hasCompany: true, openRecruitmentCount: 2, receivedPendingProposalCount: 3, sentPendingProposalCount: 1, ignored: true })
  await expect(getDeletionPreview('owner', signal)).resolves.toEqual({ hasCompany: true, openRecruitmentCount: 2, receivedPendingProposalCount: 3, sentPendingProposalCount: 1 })
  jest.mocked(apiRequest).mockResolvedValue({ hasCompany: false, openRecruitmentCount: -1, receivedPendingProposalCount: 0, sentPendingProposalCount: 0 })
  await expect(getDeletionPreview('owner')).rejects.toThrow()
  jest.mocked(apiRequest).mockResolvedValue(undefined)
  await changePassword('owner', 'newPassword123', signal)
  expect(apiRequest).toHaveBeenLastCalledWith('/api/v1/me/password', { method: 'PUT', body: { newPassword: 'newPassword123' }, accessToken: 'owner', signal })
  await deleteAccount('owner', null, signal)
  expect(apiRequest).toHaveBeenLastCalledWith('/api/v1/me', { method: 'DELETE', body: {}, accessToken: 'owner', signal })
  await deleteAccount('owner', 'current', signal)
  expect(apiRequest).toHaveBeenLastCalledWith('/api/v1/me', { method: 'DELETE', body: { password: 'current' }, accessToken: 'owner', signal })
})

test('password reset uses its three existing public endpoints and validates its expiring pass', async () => {
  const signal = new AbortController().signal
  jest.mocked(apiRequest).mockResolvedValue(undefined)
  await requestPasswordReset('owner@example.com', signal)
  expect(apiRequest).toHaveBeenLastCalledWith('/api/v1/auth/password-reset', { method: 'POST', body: { email: 'owner@example.com' }, signal })
  const pass = { passToken: 'r'.repeat(43), expiresAt: '2026-10-09T12:00:00+09:00' }
  jest.mocked(apiRequest).mockResolvedValue(pass)
  await expect(verifyPasswordResetCode('owner@example.com', '123456', signal)).resolves.toEqual(pass)
  jest.mocked(apiRequest).mockResolvedValue({ ...pass, expiresAt: 'invalid' })
  await expect(verifyPasswordResetCode('owner@example.com', '123456')).rejects.toThrow()
  jest.mocked(apiRequest).mockResolvedValue(undefined)
  await resetPassword(pass.passToken, 'newPassword123', signal)
  expect(apiRequest).toHaveBeenLastCalledWith('/api/v1/auth/password-reset/confirm', { method: 'POST', body: { token: pass.passToken, newPassword: 'newPassword123' }, signal })
})
