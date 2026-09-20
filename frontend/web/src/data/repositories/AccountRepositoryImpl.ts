import type { AppCradle } from '../../app/di/types'
import type { Account, AccountRole } from '../../domain/entities/Account'
import type { AccountDeletionPreview } from '../../domain/entities/AccountDeletionPreview'
import type { AuthSession } from '../../domain/entities/AuthSession'
import type { OAuthProviderId } from '../../domain/entities/OAuthProvider'
import type {
  AccountLogIn,
  AccountRepository,
  AccountSignUp,
  ChangePasswordResult,
  DeleteAccountResult,
  LogInResult,
  RequestPasswordResetResult,
  ResetPasswordResult,
  SendSignupEmailCodeResult,
  SignUpResult,
  VerifySignupEmailCodeResult,
} from '../../domain/repositories/AccountRepository'
import {
  AccountApiError,
  changePasswordApi,
  deleteAccountApi,
  devLogInApi,
  getAccountDeletionPreviewApi,
  getCurrentAccountApi,
  logInApi,
  logOutApi,
  requestPasswordResetApi,
  resetPasswordApi,
  sendSignupEmailCodeApi,
  verifySignupEmailCodeApi,
  oauthStartUrl,
  signUpApi,
} from '../api/accountApi'
import { toAccount, toAccountDeletionPreview, toAuthSession, type AuthSessionResponseDto } from '../models/AccountDto'
import type { SessionHintStorage } from '../storage/sessionHintStorage'

/**
 * Core API 계정 DTO를 Domain 값으로 바꾸는 Repository adapter입니다. 세션 토큰은 브라우저가 HttpOnly 쿠키로
 * 관리하므로 앱은 "세션이 있을 수 있다"는 힌트만 저장·삭제합니다.
 */
export class AccountRepositoryImpl implements AccountRepository {
  private readonly sessionHintStorage: SessionHintStorage

  constructor({ sessionHintStorage }: Pick<AppCradle, 'sessionHintStorage'>) {
    this.sessionHintStorage = sessionHintStorage
  }

  /** 409(이미 가입된 이메일)·429는 화면이 구분해 안내하는 업무 결과이고, 그 외 실패는 예외로 둡니다. */
  async signUp(command: AccountSignUp, signal?: AbortSignal): Promise<SignUpResult> {
    try {
      return { outcome: 'session', session: this.rememberSession(await signUpApi(command, signal)) }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.status === 409) return { outcome: 'email-taken' }
        if (error.status === 422 && error.code === 'EMAIL_VERIFICATION_REQUIRED') return { outcome: 'verification-required' }
        if (error.status === 429) return { outcome: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds }
      }
      throw error
    }
  }

  /** 401·403·429는 화면이 구분해 안내하는 업무 결과이고, 그 외 실패는 예외로 둡니다. */
  async logIn(command: AccountLogIn, signal?: AbortSignal): Promise<LogInResult> {
    try {
      return { outcome: 'session', session: this.rememberSession(await logInApi(command, signal)) }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.status === 401) return { outcome: 'invalid-credentials' }
        if (error.status === 403 && error.code === 'ACCOUNT_SUSPENDED') return { outcome: 'suspended' }
        if (error.status === 429) return { outcome: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds }
      }
      throw error
    }
  }

  async logInAsDeveloper(role: AccountRole, signal?: AbortSignal): Promise<AuthSession> {
    return this.rememberSession(await devLogInApi(role, signal))
  }

  /** 서버 삭제가 실패하더라도 힌트는 지워 다음 시작에 복원을 시도하지 않게 합니다. 이미 없는 세션(401)은 성공으로 봅니다. */
  async logOut(signal?: AbortSignal): Promise<void> {
    const hadSession = this.sessionHintStorage.hasSession()
    this.sessionHintStorage.clear()
    if (!hadSession) return

    try {
      await logOutApi(signal)
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 401) return
      throw error
    }
  }

  /** 세션이 끝났거나(401) 정지된 계정(403)이면 힌트를 지우고 비로그인으로 돌아갑니다. */
  async getCurrentAccount(signal?: AbortSignal): Promise<Account | null> {
    if (!this.sessionHintStorage.hasSession()) return null

    try {
      return toAccount(await getCurrentAccountApi(signal))
    } catch (error) {
      if (error instanceof AccountApiError && (error.status === 401 || error.status === 403)) {
        this.sessionHintStorage.clear()
        return null
      }
      throw error
    }
  }

  /** 429는 화면이 안내하는 업무 결과이고, 그 외 실패는 예외로 둡니다. */
  async changePassword(newPassword: string, signal?: AbortSignal): Promise<ChangePasswordResult> {
    try {
      await changePasswordApi(newPassword, signal)
      return { outcome: 'changed' }
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 429) {
        return { outcome: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds }
      }
      throw error
    }
  }

  async getDeletionPreview(signal?: AbortSignal): Promise<AccountDeletionPreview> {
    return toAccountDeletionPreview(await getAccountDeletionPreviewApi(signal))
  }

  /** 서버가 세션 쿠키를 만료시키므로 성공하면 힌트도 지워 다음 시작에 복원을 시도하지 않게 합니다. */
  async deleteAccount(password: string | null, signal?: AbortSignal): Promise<DeleteAccountResult> {
    try {
      await deleteAccountApi(password, signal)
      this.sessionHintStorage.clear()
      return { outcome: 'deleted' }
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 422 && error.code === 'LAST_ADMIN_DELETION') return { outcome: 'last-admin' }
      const outcome = toPasswordFailure(error)
      if (outcome !== null) return outcome
      throw error
    }
  }

  /** 503(메일 불가)·429는 화면이 안내하는 업무 결과이고, 그 외 실패는 예외로 둡니다. 가입 여부는 응답에 없습니다. */
  async requestPasswordReset(email: string, signal?: AbortSignal): Promise<RequestPasswordResetResult> {
    try {
      await requestPasswordResetApi(email, signal)
      return { outcome: 'requested' }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.status === 503) return { outcome: 'mail-unavailable' }
        if (error.status === 429) return { outcome: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds }
      }
      throw error
    }
  }

  /** 422(토큰 없음·만료·사용됨)·429는 화면이 안내하는 업무 결과입니다. 성공해도 세션은 생기지 않습니다. */
  async resetPassword(token: string, newPassword: string, signal?: AbortSignal): Promise<ResetPasswordResult> {
    try {
      await resetPasswordApi(token, newPassword, signal)
      return { outcome: 'reset' }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.status === 422) return { outcome: 'token-invalid' }
        if (error.status === 429) return { outcome: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds }
      }
      throw error
    }
  }

  /** 409(가입됨)·503(메일 불가)·429는 화면이 안내하는 업무 결과이고, 그 외 실패는 예외로 둡니다. */
  async sendSignupEmailCode(email: string, signal?: AbortSignal): Promise<SendSignupEmailCodeResult> {
    try {
      await sendSignupEmailCodeApi(email, signal)
      return { outcome: 'sent' }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.status === 409) return { outcome: 'email-taken' }
        if (error.status === 503) return { outcome: 'mail-unavailable' }
        if (error.status === 429) return { outcome: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds }
      }
      throw error
    }
  }

  /** 422는 코드로 불일치와 만료를 구분해 화면이 다르게 안내합니다. */
  async verifySignupEmailCode(email: string, code: string, signal?: AbortSignal): Promise<VerifySignupEmailCodeResult> {
    try {
      const pass = await verifySignupEmailCodeApi(email, code, signal)
      return { outcome: 'verified', passToken: pass.passToken }
    } catch (error) {
      if (error instanceof AccountApiError) {
        if (error.status === 422 && error.code === 'EMAIL_CODE_INVALID') return { outcome: 'code-invalid' }
        if (error.status === 422) return { outcome: 'code-expired' }
        if (error.status === 429) return { outcome: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds }
      }
      throw error
    }
  }

  /** 브라우저가 최상위로 이동하는 링크라 요청 없이 주소만 만듭니다. 키가 없는 공급자는 서버가 로그인 화면으로 돌려보냅니다. */
  oauthStartUrl(provider: OAuthProviderId): string {
    return oauthStartUrl(provider)
  }

  /** 서버 콜백이 세션 쿠키를 심었으므로 힌트를 남기고 계정을 확인합니다. 세션이 없으면 힌트를 다시 지우고 null입니다. */
  async completeOAuthSignIn(signal?: AbortSignal): Promise<Account | null> {
    this.sessionHintStorage.markSignedIn()
    return this.getCurrentAccount(signal)
  }

  private rememberSession(dto: AuthSessionResponseDto): AuthSession {
    this.sessionHintStorage.markSignedIn()
    return toAuthSession(dto)
  }
}

function toPasswordFailure(error: unknown): { outcome: 'current-password-mismatch' } | { outcome: 'rate-limited'; retryAfterSeconds: number | null } | null {
  if (!(error instanceof AccountApiError)) return null
  if (error.status === 422 && error.code === 'CURRENT_PASSWORD_MISMATCH') return { outcome: 'current-password-mismatch' }
  if (error.status === 429) return { outcome: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds }
  return null
}
