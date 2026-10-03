import { AccountApiError } from '../../../../data/api/accountApi'

/** 관리자 API가 일반 실패가 아니라 세션이나 권한 때문에 거절한 경우의 안내입니다. */
export const adminAccessMessages = {
  forbidden: '관리자 권한이 필요해요. 관리자 계정으로 로그인했는지 확인해 주세요.',
} as const

/**
 * 관리자 API 실패가 세션 끝(401)인지 관리자 권한 없음(403)인지 가립니다. 그 밖의 실패는 null이라 기존처럼 다시 시도를 안내합니다.
 * 관리자 계정 계약에는 이 구분을 담는 Domain 오류가 없어, 관리자 API가 던지는 `AccountApiError`의 HTTP 상태로 판단합니다.
 */
export function adminAccessFailure(error: unknown): 'signed-out' | 'forbidden' | null {
  if (!(error instanceof AccountApiError)) return null
  if (error.status === 401) return 'signed-out'
  if (error.status === 403) return 'forbidden'
  return null
}
