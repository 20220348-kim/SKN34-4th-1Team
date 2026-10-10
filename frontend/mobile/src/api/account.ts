import { accountDeletionPreviewDtoSchema, oauthProvidersDtoSchema, passwordResetPassDtoSchema, signupEmailPassDtoSchema, toAccountDeletionPreview } from '@govbiz/shared/data/models/AccountDto'
import type { PasswordResetVerification, SignupEmailVerification } from '@govbiz/shared/domain/entities/Account'
import type { AccountDeletionPreview } from '@govbiz/shared/domain/entities/AccountDeletionPreview'
import type { OAuthProviderId } from '@govbiz/shared/domain/entities/OAuthProvider'
import { apiRequest } from './client'

export async function sendSignupEmailCode(email: string, signal?: AbortSignal): Promise<void> {
  await apiRequest('/api/v1/auth/signup/email-code', { method: 'POST', body: { email }, signal })
}

export async function verifySignupEmailCode(email: string, code: string, signal?: AbortSignal): Promise<SignupEmailVerification> {
  const payload = await apiRequest('/api/v1/auth/signup/email-code/verify', { method: 'POST', body: { email, code }, signal })
  const result = signupEmailPassDtoSchema.parse(payload)
  return { passToken: result.passToken, expiresAt: result.expiresAt }
}

export async function readOAuthProviders(signal?: AbortSignal): Promise<OAuthProviderId[]> {
  const result = oauthProvidersDtoSchema.parse(await apiRequest('/api/v1/auth/oauth/providers', { signal }))
  return result.providers.map(item => item.provider)
}

export async function requestPasswordReset(email: string, signal?: AbortSignal): Promise<void> {
  await apiRequest('/api/v1/auth/password-reset', { method: 'POST', body: { email }, signal })
}

export async function verifyPasswordResetCode(email: string, code: string, signal?: AbortSignal): Promise<PasswordResetVerification> {
  const result = passwordResetPassDtoSchema.parse(await apiRequest('/api/v1/auth/password-reset/verify', { method: 'POST', body: { email, code }, signal }))
  return { passToken: result.passToken, expiresAt: result.expiresAt }
}

export async function resetPassword(token: string, newPassword: string, signal?: AbortSignal): Promise<void> {
  await apiRequest('/api/v1/auth/password-reset/confirm', { method: 'POST', body: { token, newPassword }, signal })
}

export async function getDeletionPreview(accessToken: string, signal?: AbortSignal): Promise<AccountDeletionPreview> {
  return toAccountDeletionPreview(accountDeletionPreviewDtoSchema.parse(await apiRequest('/api/v1/me/deletion-preview', { accessToken, signal })))
}

export async function changePassword(accessToken: string, newPassword: string, signal?: AbortSignal): Promise<void> {
  await apiRequest('/api/v1/me/password', { method: 'PUT', body: { newPassword }, accessToken, signal })
}

export async function deleteAccount(accessToken: string, password: string | null, signal?: AbortSignal): Promise<void> {
  await apiRequest('/api/v1/me', { method: 'DELETE', body: password === null ? {} : { password }, accessToken, signal })
}
