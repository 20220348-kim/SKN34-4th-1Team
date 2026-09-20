import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch } from '../../../../app/hooks'
import type { SendSignupEmailCodeUseCase } from '../../../../domain/usecases/SendSignupEmailCodeUseCase'
import { isValidSignUpPassword, type SignUpUseCase, signUpPasswordLength } from '../../../../domain/usecases/SignUpUseCase'
import { isValidSignupEmailCode, type VerifySignupEmailCodeUseCase } from '../../../../domain/usecases/VerifySignupEmailCodeUseCase'
import { signedIn } from '../../../shared/auth/state/authSlice'
import { loginPathFor, readReturnPath } from '../../../shared/auth/returnPath'
import { useOAuthSignInOptions } from './useOAuthSignInOptions'

type AccountSignUpUseCase = Pick<SignUpUseCase, 'execute'>
type EmailCodeSendUseCase = Pick<SendSignupEmailCodeUseCase, 'execute'>
type EmailCodeVerifyUseCase = Pick<VerifySignupEmailCodeUseCase, 'execute'>

export const signupMessages = {
  emailRequired: '이메일 형식으로 입력해 주세요.',
  emailNotVerified: '이메일 인증을 먼저 해 주세요.',
  codeSent: '인증번호를 보냈습니다. 10분 안에 메일의 6자리 번호를 입력해 주세요.',
  codeRequired: '메일로 받은 6자리 인증번호를 입력해 주세요.',
  codeInvalid: '인증번호가 맞지 않습니다. 다시 확인해 주세요.',
  codeExpired: '인증번호가 만료됐거나 입력 횟수를 넘겼습니다. 인증번호를 다시 받아 주세요.',
  codeVerified: '이메일 인증을 마쳤습니다.',
  mailUnavailable: '지금은 인증 메일을 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.',
  passwordLength: `비밀번호는 ${signUpPasswordLength.min}자 이상 ${signUpPasswordLength.max}자 이하로 입력해 주세요.`,
  passwordMismatch: '비밀번호 확인이 일치하지 않습니다.',
  emailTaken: '이미 가입된 이메일입니다. 로그인하거나 다른 이메일을 사용해 주세요.',
  rateLimited: (retryAfterSeconds: number | null) =>
    retryAfterSeconds === null
      ? '요청이 많아 잠시 막혔습니다. 잠시 후 다시 시도해 주세요.'
      : `요청이 많아 잠시 막혔습니다. ${retryAfterSeconds}초 뒤에 다시 시도해 주세요.`,
  requestFailed: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
} as const

type SignupError = { field: 'email' | 'code' | 'password' | 'passwordConfirmation' | null; message: string }

/** 이메일 인증 단계입니다. 인증번호를 맞히면 `verified`가 되고 이메일을 고치면 다시 `idle`로 돌아갑니다. */
export type EmailVerificationStep = 'idle' | 'sent' | 'verified'

/**
 * 회원가입 화면의 대표 ViewModel입니다. 이메일을 인증번호로 확인한 뒤에만 비밀번호와 함께 가입합니다.
 * 가입에 성공하면 서버가 세션 쿠키를 발급하므로 계정을 Store에 올리고 선택한 복귀 경로 또는 작업 채팅으로 이동합니다.
 */
export function useSignupViewModel(
  signUpUseCase: AccountSignUpUseCase = appContainer.resolve('signUpUseCase'),
  sendCodeUseCase: EmailCodeSendUseCase = appContainer.resolve('sendSignupEmailCodeUseCase'),
  verifyCodeUseCase: EmailCodeVerifyUseCase = appContainer.resolve('verifySignupEmailCodeUseCase'),
) {
  const dispatchToStore = useAppDispatch()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [emailStep, setEmailStep] = useState<EmailVerificationStep>('idle')
  const [emailPassToken, setEmailPassToken] = useState<string | null>(null)
  const [codeNotice, setCodeNotice] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [error, setError] = useState<SignupError | null>(null)
  const [isSendingCode, setIsSendingCode] = useState(false)
  const [isVerifyingCode, setIsVerifyingCode] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isMounted = useRef(true)
  // 가입 화면에는 로그인 상태 유지 선택이 없어 이메일 가입과 같은 브라우저 세션으로 시작합니다.
  const oauthOptions = useOAuthSignInOptions({ returnPath: readReturnPath(location.search, ''), rememberMe: false })

  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  function isEmailShapeValid(): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  }

  async function sendCode() {
    if (isSendingCode) return
    if (!isEmailShapeValid()) {
      setError({ field: 'email', message: signupMessages.emailRequired })
      return
    }
    setIsSendingCode(true)
    setError(null)
    setCodeNotice(null)
    try {
      const result = await sendCodeUseCase.execute(email)
      if (!isMounted.current) return
      if (result.outcome === 'email-taken') {
        setError({ field: 'email', message: signupMessages.emailTaken })
        return
      }
      if (result.outcome === 'mail-unavailable') {
        setError({ field: 'email', message: signupMessages.mailUnavailable })
        return
      }
      if (result.outcome === 'rate-limited') {
        setError({ field: 'email', message: signupMessages.rateLimited(result.retryAfterSeconds) })
        return
      }
      setEmailStep('sent')
      setCode('')
      setCodeNotice(signupMessages.codeSent)
    } catch {
      if (!isMounted.current) return
      setError({ field: 'email', message: signupMessages.requestFailed })
    } finally {
      if (isMounted.current) setIsSendingCode(false)
    }
  }

  async function verifyCode() {
    if (isVerifyingCode) return
    if (!isValidSignupEmailCode(code.trim())) {
      setError({ field: 'code', message: signupMessages.codeRequired })
      return
    }
    setIsVerifyingCode(true)
    setError(null)
    try {
      const result = await verifyCodeUseCase.execute(email, code)
      if (!isMounted.current) return
      if (result.outcome === 'code-invalid') {
        setError({ field: 'code', message: signupMessages.codeInvalid })
        return
      }
      if (result.outcome === 'code-expired') {
        setError({ field: 'code', message: signupMessages.codeExpired })
        return
      }
      if (result.outcome === 'rate-limited') {
        setError({ field: 'code', message: signupMessages.rateLimited(result.retryAfterSeconds) })
        return
      }
      setEmailPassToken(result.passToken)
      setEmailStep('verified')
      setCodeNotice(signupMessages.codeVerified)
    } catch {
      if (!isMounted.current) return
      setError({ field: 'code', message: signupMessages.requestFailed })
    } finally {
      if (isMounted.current) setIsVerifyingCode(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return

    const elements = event.currentTarget.elements
    if (emailStep !== 'verified' || emailPassToken === null) {
      setError({ field: 'email', message: signupMessages.emailNotVerified })
      return
    }
    if (!isValidSignUpPassword(password)) {
      setError({ field: 'password', message: signupMessages.passwordLength })
      ;(elements.namedItem('password') as HTMLInputElement).focus()
      return
    }
    if (password !== passwordConfirmation) {
      setError({ field: 'passwordConfirmation', message: signupMessages.passwordMismatch })
      ;(elements.namedItem('passwordConfirmation') as HTMLInputElement).focus()
      return
    }

    setIsSubmitting(true)
    setError(null)
    try {
      const result = await signUpUseCase.execute({ email, password, emailPassToken })
      if (!isMounted.current) return
      if (result.outcome === 'email-taken') {
        setError({ field: 'email', message: signupMessages.emailTaken })
        return
      }
      if (result.outcome === 'verification-required') {
        // 통행 토큰이 만료됐으면 인증부터 다시 합니다.
        setEmailStep('idle')
        setEmailPassToken(null)
        setCodeNotice(null)
        setError({ field: 'email', message: signupMessages.codeExpired })
        return
      }
      if (result.outcome === 'rate-limited') {
        setError({ field: null, message: signupMessages.rateLimited(result.retryAfterSeconds) })
        return
      }
      dispatchToStore(signedIn(result.session.account))
      navigate(readReturnPath(location.search), { replace: true })
    } catch {
      if (!isMounted.current) return
      setError({ field: null, message: signupMessages.requestFailed })
    } finally {
      if (isMounted.current) setIsSubmitting(false)
    }
  }

  return {
    loginPath: loginPathFor(readReturnPath(location.search, '')),
    oauthOptions,
    email,
    code,
    emailStep,
    codeNotice,
    password,
    passwordConfirmation,
    error,
    isSendingCode,
    isVerifyingCode,
    isSubmitting,
    /** 이메일을 고치면 인증이 풀립니다. 인증한 주소와 다른 주소로 가입하지 않게 하기 위해서입니다. */
    updateEmail: (value: string) => {
      setEmail(value)
      setError(null)
      if (emailStep !== 'idle') {
        setEmailStep('idle')
        setEmailPassToken(null)
        setCode('')
        setCodeNotice(null)
      }
    },
    updateCode: (value: string) => { setCode(value.replace(/[^0-9]/g, '').slice(0, 6)); setError(null) },
    updatePassword: (value: string) => { setPassword(value); setError(null) },
    updatePasswordConfirmation: (value: string) => { setPasswordConfirmation(value); setError(null) },
    sendCode,
    verifyCode,
    submit,
  }
}
