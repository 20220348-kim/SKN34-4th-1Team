import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import type { ResetPasswordUseCase } from '../../../../domain/usecases/ResetPasswordUseCase'
import { isValidSignUpPassword, signUpPasswordLength } from '../../../../domain/usecases/SignUpUseCase'

type PasswordResetUseCase = Pick<ResetPasswordUseCase, 'execute'>

export const resetPasswordMessages = {
  missingToken: '재설정 링크가 올바르지 않습니다. 메일의 링크를 그대로 열거나 다시 요청해 주세요.',
  passwordLength: `비밀번호는 ${signUpPasswordLength.min}자 이상 ${signUpPasswordLength.max}자 이하로 입력해 주세요.`,
  passwordMismatch: '비밀번호 확인이 일치하지 않습니다.',
  tokenInvalid: '재설정 링크가 만료됐거나 이미 사용됐습니다. 비밀번호 찾기에서 다시 요청해 주세요.',
  done: '비밀번호를 변경했습니다. 새 비밀번호로 다시 로그인해 주세요.',
  rateLimited: (retryAfterSeconds: number | null) =>
    retryAfterSeconds === null
      ? '요청이 많아 잠시 막혔습니다. 잠시 후 다시 시도해 주세요.'
      : `요청이 많아 잠시 막혔습니다. ${retryAfterSeconds}초 뒤에 다시 시도해 주세요.`,
  requestFailed: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
} as const

type ResetPasswordError = { field: 'password' | 'passwordConfirmation' | null; message: string }

/** 메일 링크는 토큰을 `#token=` fragment에 싣습니다. fragment는 서버 요청·접속 로그·Referer로 나가지 않습니다. */
export function readResetToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token')?.trim() ?? ''
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
}

/**
 * 비밀번호 재설정 화면의 대표 ViewModel입니다. 주소의 토큰과 새 비밀번호로 변경을 요청하고, 성공하면 로그인으로
 * 안내합니다. 토큰이 없거나 만료된 링크는 다시 요청하도록 안내합니다.
 */
export function useResetPasswordViewModel(
  resetUseCase: PasswordResetUseCase = appContainer.resolve('resetPasswordUseCase'),
) {
  const location = useLocation()
  const token = readResetToken(location.hash)
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [isDone, setIsDone] = useState(false)
  const [isTokenRejected, setIsTokenRejected] = useState(false)
  const [error, setError] = useState<ResetPasswordError | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isMounted = useRef(true)

  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting || token === null) return

    if (!isValidSignUpPassword(password)) {
      setError({ field: 'password', message: resetPasswordMessages.passwordLength })
      ;(event.currentTarget.elements.namedItem('password') as HTMLInputElement).focus()
      return
    }
    if (password !== passwordConfirmation) {
      setError({ field: 'passwordConfirmation', message: resetPasswordMessages.passwordMismatch })
      ;(event.currentTarget.elements.namedItem('passwordConfirmation') as HTMLInputElement).focus()
      return
    }

    setIsSubmitting(true)
    setError(null)
    try {
      const result = await resetUseCase.execute({ token, newPassword: password })
      if (!isMounted.current) return
      if (result.outcome === 'token-invalid') {
        setIsTokenRejected(true)
        return
      }
      if (result.outcome === 'rate-limited') {
        setError({ field: null, message: resetPasswordMessages.rateLimited(result.retryAfterSeconds) })
        return
      }
      setIsDone(true)
    } catch {
      if (!isMounted.current) return
      setError({ field: null, message: resetPasswordMessages.requestFailed })
    } finally {
      if (isMounted.current) setIsSubmitting(false)
    }
  }

  return {
    hasToken: token !== null,
    isTokenRejected,
    password,
    passwordConfirmation,
    isDone,
    error,
    isSubmitting,
    updatePassword: (value: string) => { setPassword(value); setError(null) },
    updatePasswordConfirmation: (value: string) => { setPasswordConfirmation(value); setError(null) },
    submit,
  }
}
