import { useState } from 'react'
import { useNavigate } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch } from '../../../../app/hooks'
import type { AccountType } from '../../../../domain/entities/Account'
import type { CompleteOnboardingUseCase } from '../../../../domain/usecases/AccountProfileUseCases'
import { useAuthSession } from '../../../shared/auth/hooks/useAuthSession'
import { signedIn } from '../../../shared/auth/state/authSlice'
import { appPaths } from '../../../shared/routes/appPaths'

export const welcomeMessages = {
  saveFailed: '답을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.',
} as const

/**
 * 최초 로그인 환영 화면(1단계)입니다. 회원 유형(개인/기업) 하나만 묻고, 건너뛸 수 없습니다(앱 구조가 갈리는 답).
 * 답은 서버에 저장되고 세션 계정에 바로 반영되어 다시 이 화면으로 오지 않습니다. 저장이 먼저이므로 2단계에서
 * 나가거나 새로고침해도 1단계로 돌아오지 않습니다. 개인은 검색 화면으로, 기업은 2단계(기업 등록)로 갑니다.
 */
export function useWelcomeViewModel(
  completeOnboardingUseCase: Pick<CompleteOnboardingUseCase, 'execute'> = appContainer.resolve('completeOnboardingUseCase'),
) {
  const { account } = useAuthSession()
  const navigate = useNavigate()
  const dispatchToStore = useAppDispatch()
  // 기본은 진입 장벽이 낮은 개인입니다.
  const [type, setType] = useState<AccountType>(account?.accountType ?? 'INDIVIDUAL')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setIsSaving(true)
    setError(null)
    try {
      const updated = await completeOnboardingUseCase.execute({ accountType: type })
      dispatchToStore(signedIn(updated))
      // 이미 기업이 등록된 계정이 기업을 고르면 2단계에 갈 일이 없습니다.
      const next = type === 'BUSINESS' && updated.company === null ? appPaths.welcomeCompany : appPaths.chat
      navigate(next, { replace: true })
    } catch {
      setError(welcomeMessages.saveFailed)
      setIsSaving(false)
    }
  }

  return {
    type,
    isSaving,
    error,
    /** 개인은 바로 시작하고, 기업은 다음 단계가 있다는 것을 버튼이 말합니다. */
    buttonLabel: type === 'BUSINESS' ? '다음' : '시작하기',
    chooseType: setType,
    start: () => void start(),
  }
}
