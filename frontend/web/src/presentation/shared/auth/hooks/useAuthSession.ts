import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import { onCoreSessionEnded } from '../../../../data/api/coreFetch'
import { sessionHintStorageKey } from '../../../../data/storage/sessionHintStorage'
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

/** 마지막으로 서버에 로그인 상태를 확인한 뒤 이만큼 지나면, 화면을 옮기거나 탭으로 돌아올 때 `/me`로 다시 확인합니다. */
export const sessionRecheckIntervalMs = 5 * 60_000

/**
 * 앱 시작 때 세션을 복원한 뒤에도 서버의 로그인 상태를 따라갑니다. 세션 만료 판단은 서버가 하고 화면 타이머로 정하지 않습니다.
 * 1) Core API가 401을 주면(만료·강제 로그아웃·정지로 세션 삭제) 바로 로그아웃시켜 `RequireAuth`가 로그인 화면으로 보내게 하고,
 * 2) 화면을 옮기거나 탭으로 돌아왔을 때 마지막 확인 뒤 5분이 지났으면 `/me`로 다시 확인하며,
 * 3) 다른 창에서 로그아웃·로그인하면 브라우저의 세션 힌트(localStorage) 변경으로 따라갑니다.
 * 로그아웃은 기존 `signedOut` 액션으로 해 대화·작업 폴링·도우미 같은 회원 데이터 정리를 그대로 탑니다.
 */
export function useWatchAuthSession(
  getCurrentAccountUseCase: CurrentAccountUseCase = appContainer.resolve('getCurrentAccountUseCase'),
  logOutUseCase: SignOutUseCase = appContainer.resolve('logOutUseCase'),
) {
  const dispatchToStore = useAppDispatch()
  const status = useAppSelector(selectAuthStatus)
  const { pathname } = useLocation()
  const statusRef = useRef(status)
  const lastCheckedAt = useRef(0)

  useEffect(() => {
    statusRef.current = status
    // 로그인·복원 직후는 서버가 방금 확인해 준 상태이므로 다음 확인은 5분 뒤부터 합니다.
    if (status === 'authenticated') lastCheckedAt.current = Date.now()
  }, [status])

  const endSession = useCallback((reason: 'expired' | 'elsewhere') => {
    if (statusRef.current !== 'authenticated') return
    // 같은 순간 여러 요청이 401을 받아도 한 번만 로그아웃합니다.
    statusRef.current = 'anonymous'
    dispatchToStore(signedOut(reason))
    // 브라우저 힌트를 지워 다른 창도 따라오게 하고, 남은 서버 세션이 있으면 끝냅니다(없으면 401도 성공으로 봄).
    if (reason === 'expired') void logOutUseCase.execute().catch(() => undefined)
  }, [dispatchToStore, logOutUseCase])

  useEffect(() => onCoreSessionEnded(() => endSession('expired')), [endSession])

  const recheck = useCallback(() => {
    if (statusRef.current !== 'authenticated' || Date.now() - lastCheckedAt.current < sessionRecheckIntervalMs) return
    lastCheckedAt.current = Date.now()
    getCurrentAccountUseCase.execute()
      .then((account) => { if (account === null) endSession('expired') })
      // 네트워크·서버 오류는 세션이 끝났다는 뜻이 아니므로 로그인 상태를 그대로 둡니다.
      .catch(() => undefined)
  }, [endSession, getCurrentAccountUseCase])

  useEffect(() => { recheck() }, [pathname, recheck])

  useEffect(() => {
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') recheck() }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [recheck])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      // key가 null이면 저장소 전체를 지운 경우입니다.
      if (event.key !== null && event.key !== sessionHintStorageKey) return
      if (event.newValue === null) {
        endSession('elsewhere')
      } else if (statusRef.current === 'anonymous') {
        getCurrentAccountUseCase.execute()
          .then((account) => { if (account !== null && statusRef.current === 'anonymous') dispatchToStore(sessionRestored(account)) })
          .catch(() => undefined)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [dispatchToStore, endSession, getCurrentAccountUseCase])
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
