import { ApiError } from '../api/client'

export function authErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'MOBILE_OAUTH_EXCHANGE_INVALID') return '소셜 로그인 요청이 만료되었거나 확인되지 않았습니다. 소셜 로그인을 다시 시작해 주세요.'
    if (error.status === 429) return error.retryAfterSeconds ? `${error.retryAfterSeconds}초 뒤 다시 시도해 주세요.` : '요청이 많습니다. 잠시 뒤 다시 시도해 주세요.'
    if (error.code === 'EMAIL_CODE_INVALID') return '인증번호가 맞지 않습니다. 메일의 6자리 번호를 확인해 주세요.'
    if (error.code === 'EMAIL_CODE_EXPIRED' || error.code === 'EMAIL_VERIFICATION_REQUIRED') return '이메일 인증이 만료되었습니다. 인증번호를 다시 받아 주세요.'
    if (error.status === 409) return '이미 가입된 이메일입니다. 로그인해 주세요.'
    if (error.status === 401) return '이메일 또는 비밀번호를 확인해 주세요.'
    if (error.status === 403) return '이 계정은 현재 로그인할 수 없습니다. 계정 상태를 확인해 주세요.'
    if (error.status === 503) return '현재 인증 서비스를 이용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.'
  }
  return error instanceof Error ? error.message : '요청을 완료하지 못했습니다. 다시 시도해 주세요.'
}
