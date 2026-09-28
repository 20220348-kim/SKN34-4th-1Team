import type { AccountRole } from '../../domain/entities/Account'
import type { OAuthProviderId } from '../../domain/entities/OAuthProvider'
import { z } from 'zod'

import type { AccountLogIn, AccountSignUp } from '../../domain/repositories/AccountRepository'
import { getCoreApiBaseUrl } from './coreApiConfig'
import {
  accountDeletionPreviewDtoSchema,
  accountDtoSchema,
  authSessionResponseDtoSchema,
  currentAccountResponseDtoSchema,
  type AccountDto,
  type AuthSessionResponseDto,
} from '../models/AccountDto'

const SIGNUP_PATH = '/api/v1/auth/signup'
const OAUTH_PATH = '/api/v1/auth/oauth'
const LOGIN_PATH = '/api/v1/auth/login'
const DEV_LOGIN_PATH = '/api/v1/auth/dev-login'
const PASSWORD_RESET_PATH = '/api/v1/auth/password-reset'
const PASSWORD_RESET_VERIFY_PATH = '/api/v1/auth/password-reset/verify'
const PASSWORD_RESET_CONFIRM_PATH = '/api/v1/auth/password-reset/confirm'
const SIGNUP_EMAIL_CODE_PATH = '/api/v1/auth/signup/email-code'
const SIGNUP_EMAIL_CODE_VERIFY_PATH = '/api/v1/auth/signup/email-code/verify'
const LOGOUT_PATH = '/api/v1/auth/logout'
const CURRENT_ACCOUNT_PATH = '/api/v1/auth/me'
const ACCOUNT_PATH = '/api/v1/me'
const PASSWORD_PATH = '/api/v1/me/password'
const ONBOARDING_PATH = '/api/v1/me/onboarding'
const DELETION_PREVIEW_PATH = '/api/v1/me/deletion-preview'

/** 계정 endpoint의 HTTP 상태와 ProblemDetail `code`를 Repository가 업무 결과로 바꿀 수 있게 합니다. */
export class AccountApiError extends Error {
  readonly status: number
  readonly code: string | null
  /** 429 응답의 `retryAfterSeconds`. 없거나 정수가 아니면 null입니다. */
  readonly retryAfterSeconds: number | null

  constructor(status: number, code: string | null, retryAfterSeconds: number | null = null) {
    super(`Core API returned HTTP ${status} for the account request.`)
    this.name = 'AccountApiError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** 세션은 HttpOnly 쿠키로 오가므로 모든 계정 요청은 쿠키를 함께 보냅니다. Core API의 CORS가 자격 증명을 허용합니다. */
const withSessionCookie: RequestCredentials = 'include'

/** 가입 성공(201)도 로그인과 같은 세션 응답을 돌려주고 세션 쿠키를 함께 내려줍니다. */
export async function signUpApi(
  command: AccountSignUp,
  signal?: AbortSignal,
): Promise<AuthSessionResponseDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${SIGNUP_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)

  return authSessionResponseDtoSchema.parse(await response.json())
}

export async function logInApi(
  command: AccountLogIn,
  signal?: AbortSignal,
): Promise<AuthSessionResponseDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)

  return authSessionResponseDtoSchema.parse(await response.json())
}

/** Core API가 개발용 로그인을 켰을 때만 존재하는 endpoint입니다. 꺼져 있으면 404입니다. */
export async function devLogInApi(role: AccountRole, signal?: AbortSignal): Promise<AuthSessionResponseDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${DEV_LOGIN_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)

  return authSessionResponseDtoSchema.parse(await response.json())
}

export async function logOutApi(signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${getCoreApiBaseUrl()}${LOGOUT_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)
}

export async function getCurrentAccountApi(signal?: AbortSignal): Promise<AccountDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${CURRENT_ACCOUNT_PATH}`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    signal,
    // 세션 복원 응답은 로그아웃 뒤에도 재사용되면 안 됩니다.
    cache: 'no-store',
  })
  await rejectFailedResponse(response)

  return accountDtoSchema.parse(currentAccountResponseDtoSchema.parse(await response.json()).account)
}

/** 로그인 세션이 본인 확인이므로 새 비밀번호만 보냅니다. */
/** 환영 화면의 답을 저장하고 갱신된 계정을 받습니다. */
export async function completeOnboardingApi(body: { accountType: string }, signal?: AbortSignal): Promise<AccountDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${ONBOARDING_PATH}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)
  return currentAccountResponseDtoSchema.parse(await response.json()).account
}

export async function changePasswordApi(newPassword: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${getCoreApiBaseUrl()}${PASSWORD_PATH}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword }),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)
}

export async function getAccountDeletionPreviewApi(signal?: AbortSignal) {
  const response = await fetch(`${getCoreApiBaseUrl()}${DELETION_PREVIEW_PATH}`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    cache: 'no-store',
    signal,
  })
  await rejectFailedResponse(response)

  return accountDeletionPreviewDtoSchema.parse(await response.json())
}

/** 비밀번호가 없는 소셜 가입 계정은 `password` 없이 빈 본문 객체를 보냅니다. */
export async function deleteAccountApi(password: string | null, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${getCoreApiBaseUrl()}${ACCOUNT_PATH}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(password === null ? {} : { password }),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)
}

/** 가입 이메일로 재설정 인증번호를 요청합니다. 성공은 204, 미가입 이메일은 404, 소셜 전용 계정은 409, 메일 불가는 503, 재전송 대기·한도는 429입니다. */
export async function requestPasswordResetApi(email: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${getCoreApiBaseUrl()}${PASSWORD_RESET_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
    signal,
  })
  await rejectFailedResponse(response)
}

/** 재설정 인증번호를 확인하고 새 비밀번호 저장에 쓸 통행 토큰을 받습니다. 틀리면 422 `EMAIL_CODE_INVALID`, 만료·시도 초과면 422 `EMAIL_CODE_EXPIRED`입니다. */
export async function verifyPasswordResetCodeApi(email: string, code: string, signal?: AbortSignal): Promise<SignupEmailPassDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${PASSWORD_RESET_VERIFY_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
    signal,
  })
  if (response.ok) return signupEmailPassDtoSchema.parse(await response.json())
  const problem = await readProblem(response)
  throw new AccountApiError(response.status, problem.code, problem.retryAfterSeconds)
}

/** 통행 토큰으로 새 비밀번호를 저장합니다. 성공은 204이고 토큰이 없거나 만료·사용됐으면 422, 소셜 전용 계정은 409입니다. */
export async function resetPasswordApi(token: string, newPassword: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${getCoreApiBaseUrl()}${PASSWORD_RESET_CONFIRM_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, newPassword }),
    signal,
  })
  await rejectFailedResponse(response)
}

/** 가입할 이메일로 6자리 인증번호를 보냅니다. 성공은 204, 이미 가입된 이메일은 409, 재전송 대기·발송 한도는 429입니다. */
export async function sendSignupEmailCodeApi(email: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${getCoreApiBaseUrl()}${SIGNUP_EMAIL_CODE_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
    signal,
  })
  await rejectFailedResponse(response)
}

export type SignupEmailPassDto = { passToken: string; expiresAt: string }

const signupEmailPassDtoSchema = z.object({ passToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.string() })

/** 인증번호를 확인하고 가입 요청에 실을 통행 토큰을 받습니다. 틀리면 422 `EMAIL_CODE_INVALID`, 만료·시도 초과면 422 `EMAIL_CODE_EXPIRED`입니다. */
export async function verifySignupEmailCodeApi(email: string, code: string, signal?: AbortSignal): Promise<SignupEmailPassDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${SIGNUP_EMAIL_CODE_VERIFY_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
    signal,
  })
  await rejectFailedResponse(response)

  return signupEmailPassDtoSchema.parse(await response.json())
}

async function rejectFailedResponse(response: Response): Promise<void> {
  if (response.ok) return

  const problem = await readProblem(response)
  throw new AccountApiError(response.status, problem.code, problem.retryAfterSeconds)
}

/** Core API의 application/problem+json 본문에서 `code`와 `retryAfterSeconds`만 읽습니다. 본문이 없거나 형식이 다르면 null입니다. */
async function readProblem(response: Response): Promise<{ code: string | null; retryAfterSeconds: number | null }> {
  try {
    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null) return { code: null, retryAfterSeconds: null }
    const record = payload as { code?: unknown; retryAfterSeconds?: unknown }
    return {
      code: typeof record.code === 'string' ? record.code : null,
      retryAfterSeconds: Number.isInteger(record.retryAfterSeconds) ? (record.retryAfterSeconds as number) : null,
    }
  } catch {
    return { code: null, retryAfterSeconds: null }
  }
}

/** 소셜 로그인 시작 주소입니다. 브라우저가 최상위로 이동하는 링크라 요청하지 않고 주소만 만듭니다. */
export function oauthStartUrl(provider: OAuthProviderId): string {
  return `${getCoreApiBaseUrl()}${OAUTH_PATH}/${provider}/authorize`
}
