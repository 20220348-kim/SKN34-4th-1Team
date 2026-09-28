import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch } from '../../../../app/hooks'
import type { CompleteOAuthSignInUseCase } from '../../../../domain/usecases/OAuthSignInUseCases'
import { loginPathFor, readReturnPath } from '../../../shared/auth/returnPath'
import { signedIn } from '../../../shared/auth/state/authSlice'
import { publicPaths } from '../../../shared/routes/appPaths'

type OAuthCompleteUseCase = Pick<CompleteOAuthSignInUseCase, 'execute'>

export const oauthCompleteMessages = {
  signingIn: '로그인하는 중이에요…',
  description: '계정 확인이 끝나면 보던 화면으로 이동해요.',
  stuck: '화면이 넘어가지 않나요?',
  backToLogin: '로그인으로 돌아가기',
} as const

/** 이 시간이 지나도 넘어가지 않으면 로그인으로 돌아가는 길을 보여 줍니다. */
export const oauthCompleteStuckAfterMs = 10_000

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
  const [stuck, setStuck] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setStuck(true), oauthCompleteStuckAfterMs)
    return () => clearTimeout(timer)
  }, [])

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

  return {
    message: oauthCompleteMessages.signingIn,
    description: oauthCompleteMessages.description,
    /** 10초가 지나도 넘어가지 않을 때만 true입니다. */
    stuck,
    /** 실패 안내 없이 로그인으로 돌아가되 원래 가려던 화면(next)은 유지합니다. */
    loginPath: loginPathFor(readReturnPath(search, '')),
  }
}

/** 실패해도 복귀 경로를 남겨 다시 로그인하면 원래 가려던 화면으로 갑니다. */
function loginFailurePath(returnPath: string): string {
  const params = new URLSearchParams({ oauthError: 'failed' })
  if (returnPath) params.set('next', returnPath)
  return `${publicPaths.login}?${params.toString()}`
}
