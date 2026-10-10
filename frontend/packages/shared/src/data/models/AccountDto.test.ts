import { describe, expect, it } from 'vitest'
import { oauthProvidersDtoSchema, passwordResetPassDtoSchema } from './AccountDto'

describe('OAuth provider discovery', () => {
  it('keeps only supported identities and strips supplied navigation URLs', () => {
    expect(oauthProvidersDtoSchema.parse({ providers: [
      { provider: 'kakao', startUrl: 'https://untrusted.test/login' }, { provider: 'google' },
    ] })).toEqual({ providers: [{ provider: 'kakao' }, { provider: 'google' }] })
    expect(oauthProvidersDtoSchema.parse({ providers: [] })).toEqual({ providers: [] })
  })

  it('rejects unknown providers, duplicate identities, and malformed lists', () => {
    for (const payload of [
      { providers: [{ provider: 'unknown' }] },
      { providers: [{ provider: 'kakao' }, { provider: 'kakao' }] },
      { providers: ['google'] }, { providers: null }, {},
    ]) expect(oauthProvidersDtoSchema.safeParse(payload).success).toBe(false)
  })
})

describe('password reset verification pass', () => {
  it('accepts the existing token and offset timestamp contract', () => {
    const payload = { passToken: 'r'.repeat(43), expiresAt: '2026-10-10T12:00:00+09:00' }
    expect(passwordResetPassDtoSchema.parse(payload)).toEqual(payload)
  })

  it('rejects malformed tokens and timestamps at the HTTP boundary', () => {
    const payload = { passToken: 'r'.repeat(43), expiresAt: '2026-10-10T12:00:00Z' }
    for (const invalid of [
      { ...payload, passToken: 'short' }, { ...payload, passToken: '+'.repeat(43) },
      { ...payload, expiresAt: '2026-10-10T12:00:00' }, { ...payload, expiresAt: 'invalid' },
    ]) expect(passwordResetPassDtoSchema.safeParse(invalid).success).toBe(false)
  })
})
