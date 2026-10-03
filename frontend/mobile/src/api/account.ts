import { signupEmailPassDtoSchema } from '@govbiz/shared/data/models/AccountDto'
import type { SignupEmailVerification } from '@govbiz/shared/domain/entities/Account'
import { apiRequest } from './client'

export async function sendSignupEmailCode(email: string, signal?: AbortSignal): Promise<void> {
  await apiRequest('/api/v1/auth/signup/email-code', { method: 'POST', body: { email }, signal })
}

export async function verifySignupEmailCode(email: string, code: string, signal?: AbortSignal): Promise<SignupEmailVerification> {
  const payload = await apiRequest('/api/v1/auth/signup/email-code/verify', { method: 'POST', body: { email, code }, signal })
  const result = signupEmailPassDtoSchema.parse(payload)
  return { passToken: result.passToken, expiresAt: result.expiresAt }
}
