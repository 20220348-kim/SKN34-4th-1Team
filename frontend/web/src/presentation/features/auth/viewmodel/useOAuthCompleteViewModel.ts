import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch } from '../../../../app/hooks'
import type { CompleteOAuthSignInUseCase } from '../../../../domain/usecases/OAuthSignInUseCases'
import { readReturnPath } from '../../../shared/auth/returnPath'
import { signedIn } from '../../../shared/auth/state/authSlice'
import { publicPaths } from '../../../shared/routes/appPaths'

type OAuthCompleteUseCase = Pick<CompleteOAuthSignInUseCase, 'execute'>

export const oauthCompleteMessages = {
  signingIn: '로그인하는 중입니다…',
} as const

/**
 * 소셜 로그인 완료 화면의 대표 ViewModel입니다. 서버 콜백이 세션 쿠키를 심고 이 화면으로 보내므로, 세션으로 계정을 읽어
 * Store에 올리고 `?next=` 또는 작업 채팅으로 이동합니다. 세션이 없거나 읽지 못하면 로그인 화면에 실패를 알립니다.
 */
export function useOAuthCompleteViewModel(
  completeOAuthSignInUseCase: OAuthCompleteUseCase = appContainer.resolve('completeOAuthSignInUseCase'),
) {
  const dispatchToStore = useAppDispatch()
  const navigate = useNavigate()
  const { search } = useLocation()

  useEffect(() => {
    const controller = new AbortController()
    const returnPath = readReturnPath(search)
    const failToLogin = () => navigate(loginFailurePath(readReturnPath(search, '')), { replace: true })

    completeOAuthSignInUseCase.execute(controller.signal)
      .then((account) => {
        if (controller.signal.aborted) return
        if (account === null) {
          failToLogin()
          return
        }
        dispatchToStore(signedIn(account))
        navigate(returnPath, { replace: true })
      })
      .catch(() => {
        if (!controller.signal.aborted) failToLogin()
      })
    return () => controller.abort()
  }, [completeOAuthSignInUseCase, dispatchToStore, navigate, search])

  return { message: oauthCompleteMessages.signingIn }
}

/** 실패해도 복귀 경로를 남겨 다시 로그인하면 원래 가려던 화면으로 갑니다. */
function loginFailurePath(returnPath: string): string {
  const params = new URLSearchParams({ oauthError: 'failed' })
  if (returnPath) params.set('next', returnPath)
  return `${publicPaths.login}?${params.toString()}`
}
