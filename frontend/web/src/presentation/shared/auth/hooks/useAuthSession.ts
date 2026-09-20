import { useEffect, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch, useAppSelector } from '../../../../app/hooks'
import type { AccountRole } from '../../../../domain/entities/Account'
import type { DevLogInUseCase } from '../../../../domain/usecases/DevLogInUseCase'
import type { GetCurrentAccountUseCase } from '../../../../domain/usecases/GetCurrentAccountUseCase'
import type { LogOutUseCase } from '../../../../domain/usecases/LogOutUseCase'
import {
  selectAuthStatus,
  selectCurrentAccount,
  selectIsAuthenticated,
  sessionRestored,
  signedIn,
  signedOut,
} from '../state/authSlice'

type CurrentAccountUseCase = Pick<GetCurrentAccountUseCase, 'execute'>
type SignOutUseCase = Pick<LogOutUseCase, 'execute'>
type DeveloperLogInUseCase = Pick<DevLogInUseCase, 'execute'>

/** 앱 진입 시 한 번, 브라우저에 저장된 세션 힌트로 로그인 상태를 복원합니다. */
export function useRestoreAuthSession(
  getCurrentAccountUseCase: CurrentAccountUseCase = appContainer.resolve('getCurrentAccountUseCase'),
) {
  const dispatchToStore = useAppDispatch()
  const status = useAppSelector(selectAuthStatus)

  useEffect(() => {
    if (status !== 'unknown') return

    const controller = new AbortController()
    getCurrentAccountUseCase.execute(controller.signal)
      .then((account) => {
        if (controller.signal.aborted) return
        dispatchToStore(sessionRestored(account))
      })
      .catch(() => {
        // 복원 실패(네트워크·서버 오류)는 비로그인으로 시작하고, 저장된 힌트는 다음 시작에 다시 시도합니다.
        if (controller.signal.aborted) return
        dispatchToStore(sessionRestored(null))
      })

    return () => controller.abort()
  }, [dispatchToStore, getCurrentAccountUseCase, status])
}

/**
 * 헤더·사이드바처럼 여러 화면이 함께 쓰는 로그인 상태와 로그아웃·개발 로그인 동작입니다.
 * 특정 페이지의 ViewModel이 아니므로 shared에 두고 이름에 ViewModel을 붙이지 않습니다.
 */
export function useAuthSession(
  logOutUseCase: SignOutUseCase = appContainer.resolve('logOutUseCase'),
  devLogInUseCase: DeveloperLogInUseCase = appContainer.resolve('devLogInUseCase'),
) {
  const dispatchToStore = useAppDispatch()
  const status = useAppSelector(selectAuthStatus)
  const account = useAppSelector(selectCurrentAccount)
  const isAuthenticated = useAppSelector(selectIsAuthenticated)
  const [isDevLoggingIn, setIsDevLoggingIn] = useState(false)
  const [devLogInError, setDevLogInError] = useState<string | null>(null)

  /** 화면은 먼저 로그아웃 상태로 바꾸고 서버 세션 삭제는 뒤따릅니다. 부르는 쪽이 같은 틱에 메인으로 이동합니다. */
  async function logOut() {
    dispatchToStore(signedOut())
    try {
      await logOutUseCase.execute()
    } catch {
      // 서버 세션 삭제에 실패해도 브라우저 힌트는 이미 지워졌으므로 화면은 로그아웃 상태로 남습니다
    }
  }

  /** 개발 환경 전용입니다. 성공하면 시드 계정으로 로그인되고, 실패하면 이유를 짧게 알립니다. */
  async function logInAsDeveloper(role: AccountRole): Promise<boolean> {
    if (isDevLoggingIn) return false

    setIsDevLoggingIn(true)
    setDevLogInError(null)
    try {
      const session = await devLogInUseCase.execute(role)
      dispatchToStore(signedIn(session.account))
      return true
    } catch {
      setDevLogInError(authSessionMessages.devLogInFailed)
      return false
    } finally {
      setIsDevLoggingIn(false)
    }
  }

  return {
    account,
    devLogInError,
    /** 프로필에서 기업을 등록했는지입니다. 모집글 작성·프로필 일치 표시가 같은 기준을 씁니다. */
    hasCompany: account?.company !== null && account?.company !== undefined,
    isAuthenticated,
    isDevLoggingIn,
    logInAsDeveloper,
    logOut,
    status,
  }
}

export const authSessionMessages = {
  devLogInFailed: '개발 로그인에 실패했습니다. Core API의 ACCOUNT_DEV_LOGIN_ENABLED 설정을 확인해 주세요.',
} as const
