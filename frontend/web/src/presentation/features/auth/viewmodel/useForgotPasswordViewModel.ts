import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import { MAX_EMAIL_LENGTH, checkEmailAddress, isEmailAddress, type EmailAddressProblem } from '../../../../domain/entities/EmailAddress'
import type { RequestPasswordResetUseCase } from '../../../../domain/usecases/RequestPasswordResetUseCase'
import { isValidSignupEmailCode } from '../../../../domain/usecases/VerifySignupEmailCodeUseCase'
import type { VerifyPasswordResetCodeUseCase } from '../../../../domain/usecases/VerifyPasswordResetCodeUseCase'
import { publicPaths } from '../../../shared/routes/appPaths'

type PasswordResetRequestUseCase = Pick<RequestPasswordResetUseCase, 'execute'>
type PasswordResetVerifyUseCase = Pick<VerifyPasswordResetCodeUseCase, 'execute'>

export const forgotPasswordMessages = {
  emailRequired: '가입한 이메일을 입력해 주세요.',
  emailInvalid: '이메일 형식으로 입력해 주세요. 예: name@example.com',
  emailTooLong: `이메일은 ${MAX_EMAIL_LENGTH}자 이내로 입력해 주세요.`,
  emailNotRegistered: '가입되지 않은 이메일입니다. 주소를 다시 확인하거나 아래에서 회원가입해 주세요.',
  socialAccount: '카카오·Google로 가입한 계정이라 비밀번호가 없습니다. 로그인 화면에서 소셜 로그인으로 들어와 주세요.',
  codeSent: '인증번호를 보냈습니다. 10분 안에 메일의 6자리 번호를 입력해 주세요.',
  codeRequired: '메일로 받은 6자리 인증번호를 입력해 주세요.',
  codeInvalid: '인증번호가 맞지 않습니다. 다시 확인해 주세요.',
  codeExpired: '인증번호가 만료됐거나 입력 횟수를 넘겼습니다. 인증번호를 다시 받아 주세요.',
  mailUnavailable: '지금은 인증 메일을 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.',
  rateLimited: (retryAfterSeconds: number | null) =>
    retryAfterSeconds === null
      ? '요청이 많아 잠시 막혔습니다. 잠시 후 다시 시도해 주세요.'
      : `요청이 많아 잠시 막혔습니다. ${retryAfterSeconds}초 뒤에 다시 시도해 주세요.`,
  requestFailed: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
} as const

type ForgotPasswordError = { field: 'email' | 'code' | null; message: string }

/** 이메일을 받는 단계와 메일로 온 인증번호를 맞히는 단계입니다. 맞히면 새 비밀번호 화면으로 넘어갑니다. */
export type ForgotPasswordStep = 'email' | 'code'

const emailProblemMessages: Record<EmailAddressProblem, string> = {
  empty: forgotPasswordMessages.emailRequired,
  'too-long': forgotPasswordMessages.emailTooLong,
  invalid: forgotPasswordMessages.emailInvalid,
}

/**
 * 비밀번호 찾기 화면의 대표 ViewModel입니다. 이메일 형식이 맞을 때만 인증번호를 요청할 수 있고, 미가입 이메일과
 * 소셜 전용 계정은 그 자리에서 안내합니다. 6자리 인증번호를 맞히면 통행 토큰을 받아 새 비밀번호 화면(`/reset-password#token=`)으로 갑니다.
 */
export function useForgotPasswordViewModel(
  requestUseCase: PasswordResetRequestUseCase = appContainer.resolve('requestPasswordResetUseCase'),
  verifyUseCase: PasswordResetVerifyUseCase = appContainer.resolve('verifyPasswordResetCodeUseCase'),
) {
  const navigate = useNavigate()
  const [step, setStep] = useState<ForgotPasswordStep>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<ForgotPasswordError | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const isMounted = useRef(true)

  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  const canSend = isEmailAddress(email) && !isSending
  const canVerify = isValidSignupEmailCode(code) && !isVerifying && !isSending

  async function sendCode() {
    if (!canSend) return
    setIsSending(true)
    setError(null)
    setNotice(null)
    try {
      const result = await requestUseCase.execute(email)
      if (!isMounted.current) return
      if (result.outcome === 'not-registered') {
        setError({ field: 'email', message: forgotPasswordMessages.emailNotRegistered })
        return
      }
      if (result.outcome === 'social-account') {
        setError({ field: 'email', message: forgotPasswordMessages.socialAccount })
        return
      }
      if (result.outcome === 'rate-limited') {
        setError({ field: null, message: forgotPasswordMessages.rateLimited(result.retryAfterSeconds) })
        return
      }
      if (result.outcome === 'mail-unavailable') {
        setError({ field: null, message: forgotPasswordMessages.mailUnavailable })
        return
      }
      setStep('code')
      setCode('')
      setNotice(forgotPasswordMessages.codeSent)
    } catch {
      if (!isMounted.current) return
      setError({ field: null, message: forgotPasswordMessages.requestFailed })
    } finally {
      if (isMounted.current) setIsSending(false)
    }
  }

  async function verifyCode() {
    if (!canVerify) return
    setIsVerifying(true)
    setError(null)
    try {
      const result = await verifyUseCase.execute(email, code)
      if (!isMounted.current) return
      if (result.outcome === 'code-invalid') {
        setError({ field: 'code', message: forgotPasswordMessages.codeInvalid })
        return
      }
      if (result.outcome === 'code-expired') {
        setError({ field: 'code', message: forgotPasswordMessages.codeExpired })
        return
      }
      if (result.outcome === 'not-registered') {
        setError({ field: null, message: forgotPasswordMessages.emailNotRegistered })
        return
      }
      if (result.outcome === 'social-account') {
        setError({ field: null, message: forgotPasswordMessages.socialAccount })
        return
      }
      if (result.outcome === 'rate-limited') {
        setError({ field: null, message: forgotPasswordMessages.rateLimited(result.retryAfterSeconds) })
        return
      }
      // 통행 토큰은 fragment에 실어 HTTP 요청·접속 로그·Referer로 나가지 않게 합니다.
      navigate(`${publicPaths.resetPassword}#token=${result.passToken}`)
    } catch {
      if (!isMounted.current) return
      setError({ field: null, message: forgotPasswordMessages.requestFailed })
    } finally {
      if (isMounted.current) setIsVerifying(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (step === 'email') void sendCode()
    else void verifyCode()
  }

  /** 입력 칸을 벗어날 때 형식을 미리 알립니다. 아직 아무것도 안 썼을 때는 재촉하지 않습니다. */
  function checkEmail() {
    if (!email.trim() || isSending) return
    const problem = checkEmailAddress(email)
    setError(problem === null ? null : { field: 'email', message: emailProblemMessages[problem] })
  }

  /** 인증번호 단계에서 이메일을 고치러 돌아갑니다. 보낸 인증번호는 새 요청이 덮어씁니다. */
  function changeEmail() {
    setStep('email')
    setCode('')
    setNotice(null)
    setError(null)
  }

  return {
    step,
    email,
    code,
    notice,
    error,
    isSending,
    isVerifying,
    canSend,
    canVerify,
    updateEmail: (value: string) => { setEmail(value); setError(null) },
    /** 숫자만 6자리까지 받습니다. */
    updateCode: (value: string) => { setCode(value.replace(/\D/g, '').slice(0, 6)); setError(null) },
    checkEmail,
    changeEmail,
    resendCode: () => void sendCode(),
    submit,
  }
}
