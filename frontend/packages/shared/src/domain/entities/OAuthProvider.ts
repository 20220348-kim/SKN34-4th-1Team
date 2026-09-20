/** 소셜 로그인 공급자입니다. 로그인·회원가입 화면에 이 순서로 버튼을 놓습니다. */
export const oauthProviderIds = ['kakao', 'google'] as const

export type OAuthProviderId = (typeof oauthProviderIds)[number]

/** 소셜 로그인이 실패해 로그인 화면으로 돌아올 때 `?oauthError=`에 담기는 사유입니다. */
export const oauthErrorCodes = [
  'cancelled',
  'expired',
  'unavailable',
  'failed',
  'email-required',
  'account-exists',
  'unlink-pending',
  'suspended',
  'rate-limited',
] as const

export type OAuthErrorCode = (typeof oauthErrorCodes)[number]

export function isOAuthErrorCode(value: string | null): value is OAuthErrorCode {
  return value !== null && (oauthErrorCodes as readonly string[]).includes(value)
}
