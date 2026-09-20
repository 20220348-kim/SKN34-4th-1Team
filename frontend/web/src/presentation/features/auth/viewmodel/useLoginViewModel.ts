import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch } from '../../../../app/hooks'
import { isOAuthErrorCode, type OAuthErrorCode } from '../../../../domain/entities/OAuthProvider'
import type { LogInUseCase } from '../../../../domain/usecases/LogInUseCase'
import { readReturnPath, signupPathFor } from '../../../shared/auth/returnPath'
import { signedIn } from '../../../shared/auth/state/authSlice'
import { useOAuthSignInOptions } from './useOAuthSignInOptions'

type AccountLogInUseCase = Pick<LogInUseCase, 'execute'>

export const loginMessages = {
  emailRequired: '이메일 형식으로 입력해 주세요.',
  passwordRequired: '비밀번호를 입력해 주세요.',
  invalidCredentials: '이메일 또는 비밀번호를 확인해 주세요.',
  suspended: '정지된 계정입니다. 운영자에게 문의해 주세요.',
  rateLimited: (retryAfterSeconds: number | null) =>
    retryAfterSeconds === null
      ? '로그인 시도가 많아 잠시 막혔습니다. 잠시 후 다시 시도해 주세요.'
      : `로그인 시도가 많아 잠시 막혔습니다. ${retryAfterSeconds}초 뒤에 다시 시도해 주세요.`,
  requestFailed: '로그인 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  /** 소셜 로그인이 실패해 서버가 `?oauthError=`로 돌려보냈을 때의 안내입니다. */
  oauth: {
    cancelled: '소셜 로그인을 취소했습니다.',
    expired: '로그인 요청이 만료됐습니다. 다시 시도해 주세요.',
    unavailable: '이 소셜 로그인은 키가 설정되지 않아 사용할 수 없습니다.',
    failed: '소셜 로그인을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    'email-required': '인증된 이메일을 받지 못해 가입할 수 없습니다. 이메일 제공에 동의했는지 확인해 주세요.',
    'account-exists': '이미 이 이메일로 가입된 계정이 있습니다. 처음 가입한 방법으로 로그인해 주세요.',
    'unlink-pending': '이전 탈퇴의 카카오 연결 해제가 아직 확인되지 않아 재가입할 수 없습니다. 잠시 후 다시 시도하고, 계속되면 관리자에게 문의해 주세요.',
    suspended: '정지된 계정입니다. 운영자에게 문의해 주세요.',
    'rate-limited': '로그인 시도가 많아 잠시 막혔습니다. 잠시 후 다시 시도해 주세요.',
  } satisfies Record<OAuthErrorCode, string>,
} as const

type LoginError = { field: 'email' | 'password' | null; message: string }

/**
 * 로그인 화면의 대표 ViewModel입니다. 입력 상태, 제출 중 표시, 실패 안내와 로그인 뒤 이동을 소유합니다.
 * 세션 쿠키는 브라우저가 받으므로 성공하면 계정을 Store에 올리고 `?next=` 또는 작업 채팅으로 이동합니다.
 * 소셜 로그인 버튼은 같은 복귀 경로와 로그인 상태 유지 선택을 서버 시작 주소에 실어 보냅니다.
 */
export function useLoginViewModel(
  logInUseCase: AccountLogInUseCase = appContainer.resolve('logInUseCase'),
) {
  const dispatchToStore = useAppDispatch()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [error, setError] = useState<LoginError | null>(() => oauthErrorFrom(location.search))
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isMounted = useRef(true)
  const oauthOptions = useOAuthSignInOptions({ returnPath: readReturnPath(location.search, ''), rememberMe })

  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return

    const emailInput = event.currentTarget.elements.namedItem('email') as HTMLInputElement
    if (!email.trim() || emailInput.validity.typeMismatch) {
      setError({ field: 'email', message: loginMessages.emailRequired })
      emailInput.focus()
      return
    }
    if (!password) {
      setError({ field: 'password', message: loginMessages.passwordRequired })
      const passwordInput = event.currentTarget.elements.namedItem('password') as HTMLInputElement
      passwordInput.focus()
      return
    }

    setIsSubmitting(true)
    setError(null)
    try {
      const result = await logInUseCase.execute({ email, password, rememberMe })
      if (!isMounted.current) return
      if (result.outcome === 'invalid-credentials') {
        setError({ field: null, message: loginMessages.invalidCredentials })
        return
      }
      if (result.outcome === 'suspended') {
        setError({ field: null, message: loginMessages.suspended })
        return
      }
      if (result.outcome === 'rate-limited') {
        setError({ field: null, message: loginMessages.rateLimited(result.retryAfterSeconds) })
        return
      }
      dispatchToStore(signedIn(result.session.account))
      navigate(readReturnPath(location.search), { replace: true })
    } catch {
      if (!isMounted.current) return
      setError({ field: null, message: loginMessages.requestFailed })
    } finally {
      if (isMounted.current) setIsSubmitting(false)
    }
  }

  return {
    signupPath: signupPathFor(readReturnPath(location.search, '')),
    oauthOptions,
    email,
    password,
    rememberMe,
    error,
    isSubmitting,
    updateEmail: (value: string) => { setEmail(value); setError(null) },
    updatePassword: (value: string) => { setPassword(value); setError(null) },
    toggleRememberMe: () => setRememberMe((value) => !value),
    submit,
  }
}

/** 서버가 소셜 로그인 실패 사유를 `?oauthError=`로 돌려보냈으면 첫 안내로 보여 줍니다. 모르는 값은 무시합니다. */
function oauthErrorFrom(search: string): LoginError | null {
  const code = new URLSearchParams(search).get('oauthError')
  return isOAuthErrorCode(code) ? { field: null, message: loginMessages.oauth[code] } : null
}
