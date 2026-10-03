import { apiRequest } from './client'
import { sendSignupEmailCode, verifySignupEmailCode } from './account'

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
