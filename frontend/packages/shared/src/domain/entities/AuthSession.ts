import type { Account } from './Account'

/** 로그인 성공 시 Core API가 알려 준 세션 정보입니다. 토큰 자체는 HttpOnly 쿠키에 있어 앱이 다루지 않습니다. */
export type AuthSession = {
  expiresAt: string
  account: Account
}
