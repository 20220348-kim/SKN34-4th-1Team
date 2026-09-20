import { type FormEvent, useEffect, useRef, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import type { RequestPasswordResetUseCase } from '../../../../domain/usecases/RequestPasswordResetUseCase'

type PasswordResetRequestUseCase = Pick<RequestPasswordResetUseCase, 'execute'>

export const forgotPasswordMessages = {
  emailRequired: '이메일 형식으로 입력해 주세요.',
  sent: '입력한 주소가 가입돼 있으면 비밀번호 재설정 링크를 보냈습니다. 30분 안에 메일의 링크를 열어 주세요.',
  mailUnavailable: '지금은 재설정 메일을 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.',
  rateLimited: (retryAfterSeconds: number | null) =>
    retryAfterSeconds === null
      ? '요청이 많아 잠시 막혔습니다. 잠시 후 다시 시도해 주세요.'
      : `요청이 많아 잠시 막혔습니다. ${retryAfterSeconds}초 뒤에 다시 시도해 주세요.`,
  requestFailed: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
} as const

type ForgotPasswordError = { field: 'email' | null; message: string }

/**
 * 비밀번호 찾기 화면의 대표 ViewModel입니다. 이메일 하나를 받아 재설정 링크를 요청하고, 성공하면 같은 안내만 보여
 * 가입 여부가 드러나지 않게 합니다.
 */
export function useForgotPasswordViewModel(
  requestUseCase: PasswordResetRequestUseCase = appContainer.resolve('requestPasswordResetUseCase'),
) {
  const [email, setEmail] = useState('')
  const [isSent, setIsSent] = useState(false)
  const [error, setError] = useState<ForgotPasswordError | null>(null)
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
    if (isSubmitting) return

    const emailInput = event.currentTarget.elements.namedItem('email') as HTMLInputElement
    if (!email.trim() || emailInput.validity.typeMismatch) {
      setError({ field: 'email', message: forgotPasswordMessages.emailRequired })
      emailInput.focus()
      return
    }

    setIsSubmitting(true)
    setError(null)
    try {
      const result = await requestUseCase.execute(email)
      if (!isMounted.current) return
      if (result.outcome === 'rate-limited') {
        setError({ field: null, message: forgotPasswordMessages.rateLimited(result.retryAfterSeconds) })
        return
      }
      if (result.outcome === 'mail-unavailable') {
        setError({ field: null, message: forgotPasswordMessages.mailUnavailable })
        return
      }
      setIsSent(true)
    } catch {
      if (!isMounted.current) return
      setError({ field: null, message: forgotPasswordMessages.requestFailed })
    } finally {
      if (isMounted.current) setIsSubmitting(false)
    }
  }

  return {
    email,
    isSent,
    error,
    isSubmitting,
    updateEmail: (value: string) => { setEmail(value); setError(null) },
    submit,
  }
}
