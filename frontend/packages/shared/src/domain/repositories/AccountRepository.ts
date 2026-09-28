import type { AccountType } from '../entities/Account'
import type { Account, AccountRole } from '../entities/Account'
import type { AccountDeletionPreview } from '../entities/AccountDeletionPreview'
import type { AuthSession } from '../entities/AuthSession'
import type { OAuthProviderId } from '../entities/OAuthProvider'

export type AccountLogIn = {
  email: string
  password: string
  /** "로그인 상태 유지". 켜면 브라우저를 닫아도 세션 쿠키가 남습니다. */
  rememberMe: boolean
}

export type AccountSignUp = {
  email: string
  password: string
  /** 인증번호 확인이 돌려준 43자 통행 토큰입니다. 같은 이메일로 인증한 것이어야 합니다. */
  emailPassToken: string
}

/** 가입 실패 사유도 화면이 다른 안내를 보여야 하므로 결과로 구분합니다. 성공하면 서버가 바로 세션을 발급합니다. */
export type SignUpResult =
  | { outcome: 'session'; session: AuthSession }
  | { outcome: 'email-taken' }
  /** 통행 토큰이 없거나 만료됐거나 다른 이메일로 인증한 것입니다. 인증부터 다시 합니다. */
  | { outcome: 'verification-required' }
  | { outcome: 'rate-limited'; retryAfterSeconds: number | null }

/** 로그인 실패 사유는 화면이 다른 안내를 보여야 하므로 예외가 아닌 결과로 구분합니다. */
export type LogInResult =
  | { outcome: 'session'; session: AuthSession }
  | { outcome: 'invalid-credentials' }
  | { outcome: 'suspended' }
  | { outcome: 'rate-limited'; retryAfterSeconds: number | null }

/** 현재 비밀번호 불일치는 화면이 칸 아래에 안내하는 업무 결과입니다. */
export type ChangePasswordResult =
  | { outcome: 'changed' }
  | { outcome: 'rate-limited'; retryAfterSeconds: number | null }

export type DeleteAccountResult =
  | { outcome: 'deleted' }
  | { outcome: 'current-password-mismatch' }
  | { outcome: 'rate-limited'; retryAfterSeconds: number | null }
  /** 활성 관리자가 이 계정 하나뿐이라 삭제할 수 없습니다. */
  | { outcome: 'last-admin' }

/**
 * 재설정 인증번호 요청 결과입니다. 가입하지 않은 이메일, 소셜로만 가입해 비밀번호가 없는 계정, 메일을 보낼 수 없는 서버 상태,
 * 재전송 대기·한도 초과를 화면이 구분해 안내합니다.
 */
export type RequestPasswordResetResult =
  | { outcome: 'requested' }
  | { outcome: 'not-registered' }
  | { outcome: 'social-account' }
  | { outcome: 'mail-unavailable' }
  | { outcome: 'rate-limited'; retryAfterSeconds: number | null }

/** 재설정 인증번호 확인 결과입니다. 맞으면 새 비밀번호 저장에 쓸 통행 토큰을 받습니다. */
export type VerifyPasswordResetCodeResult =
  | { outcome: 'verified'; passToken: string }
  | { outcome: 'code-invalid' }
  | { outcome: 'code-expired' }
  | { outcome: 'not-registered' }
  | { outcome: 'social-account' }
  | { outcome: 'rate-limited'; retryAfterSeconds: number | null }

/** 없거나 만료·사용된 통행 토큰은 화면이 인증번호를 다시 받도록 안내하는 업무 결과입니다. */
export type ResetPasswordResult =
  | { outcome: 'reset' }
  | { outcome: 'token-invalid' }
  | { outcome: 'social-account' }
  | { outcome: 'rate-limited'; retryAfterSeconds: number | null }

/** 인증번호 발송 결과입니다. 이미 가입된 이메일, 메일 불가, 재전송 대기·발송 한도는 화면이 다르게 안내합니다. */
export type SendSignupEmailCodeResult =
  | { outcome: 'sent' }
  | { outcome: 'email-taken' }
  | { outcome: 'mail-unavailable' }
  | { outcome: 'rate-limited'; retryAfterSeconds: number | null }

/** 인증번호 확인 결과입니다. 맞으면 가입에 실을 통행 토큰을 받습니다. */
export type VerifySignupEmailCodeResult =
  | { outcome: 'verified'; passToken: string }
  | { outcome: 'code-invalid' }
  | { outcome: 'code-expired' }
  | { outcome: 'rate-limited'; retryAfterSeconds: number | null }

/** 계정 기능이 Data Layer의 HTTP·저장소 세부사항과 분리되도록 하는 Domain 포트입니다. */
export type CompleteOnboarding = { accountType: AccountType }

export interface AccountRepository {
  signUp(command: AccountSignUp, signal?: AbortSignal): Promise<SignUpResult>
  logIn(command: AccountLogIn, signal?: AbortSignal): Promise<LogInResult>
  /** 개발 환경 전용. Core API가 개발용 로그인을 켰을 때만 성공하며, 역할별 시드 계정으로 들어갑니다. */
  logInAsDeveloper(role: AccountRole, signal?: AbortSignal): Promise<AuthSession>
  logOut(signal?: AbortSignal): Promise<void>
  /** 저장된 세션이 없거나 만료됐으면 null입니다. */
  getCurrentAccount(signal?: AbortSignal): Promise<Account | null>
  /** 로그인 세션으로 본인을 확인하고 새 비밀번호로 바꿉니다. 성공하면 서버가 다른 기기의 세션을 끝냅니다. */
  changePassword(newPassword: string, signal?: AbortSignal): Promise<ChangePasswordResult>
  /** 환영 화면의 답(회원 유형)을 저장하고 갱신된 계정을 받습니다. 다시 부르면 덮어씁니다. */
  completeOnboarding(command: CompleteOnboarding, signal?: AbortSignal): Promise<Account>
  /** 삭제 확인 모달에 보여 줄, 함께 사라지는 것들의 수입니다. */
  getDeletionPreview(signal?: AbortSignal): Promise<AccountDeletionPreview>
  /** 현재 비밀번호를 확인하고 계정을 삭제합니다. 성공하면 세션 힌트를 지웁니다. */
  /** 비밀번호가 없는 소셜 가입 계정은 `null`로 부르며 세션만으로 삭제합니다. */
  deleteAccount(password: string | null, signal?: AbortSignal): Promise<DeleteAccountResult>
  /** 가입 이메일로 비밀번호 재설정 6자리 인증번호를 요청합니다. 로그인 없이 부릅니다. */
  requestPasswordReset(email: string, signal?: AbortSignal): Promise<RequestPasswordResetResult>
  /** 재설정 인증번호를 확인하고 새 비밀번호 저장에 쓸 통행 토큰을 받습니다. */
  verifyPasswordResetCode(email: string, code: string, signal?: AbortSignal): Promise<VerifyPasswordResetCodeResult>
  /** 인증번호 확인이 돌려준 통행 토큰으로 새 비밀번호를 저장합니다. 성공하면 서버가 모든 세션을 끝냅니다. */
  resetPassword(token: string, newPassword: string, signal?: AbortSignal): Promise<ResetPasswordResult>
  /** 가입할 이메일로 6자리 인증번호를 요청합니다. 로그인 없이 부릅니다. */
  sendSignupEmailCode(email: string, signal?: AbortSignal): Promise<SendSignupEmailCodeResult>
  /** 인증번호를 확인하고 가입 요청에 실을 통행 토큰을 받습니다. */
  verifySignupEmailCode(email: string, code: string, signal?: AbortSignal): Promise<VerifySignupEmailCodeResult>
  /** 소셜 로그인을 시작하는 Core API 주소입니다. 화면이 바로 링크로 그리도록 요청 없이 계산합니다. */
  oauthStartUrl(provider: OAuthProviderId): string
  /** 소셜 로그인 콜백이 세션 쿠키를 심은 뒤 부릅니다. 세션 힌트를 남기고 계정을 읽으며, 세션이 없으면 null입니다. */
  completeOAuthSignIn(signal?: AbortSignal): Promise<Account | null>
}
