import { Navigate, Outlet, useLocation } from 'react-router'

import { useAppSelector } from '../../../app/hooks'
import { meetsTier, type AccountTier } from '../../../domain/entities/Account'
import { appPaths, toAppPath } from '../routes/appPaths'
import { useDelayedFlag } from '../workspace/useDelayedFlag'
import { workspacePageStyles } from '../workspace/WorkspacePage.styles'
import { authPageStyles } from './AuthPage.styles'
import { loginPathFor } from './returnPath'
import { readReturnPath } from './returnPath'
import { selectAuthStatus, selectCurrentAccount } from './state/authSlice'

/**
 * 세션 복원이 끝나기 전(`unknown`)에 빈 화면 대신 두는 자리입니다. 낭독기에는 바로 알리고, 스피너와 문구는 300ms가 지나야
 * 보여 금방 끝나는 복원에서 깜빡이지 않게 합니다. 리다이렉트는 하지 않으므로 새로고침 때 로그인 화면이 스치지 않습니다.
 */
function SessionCheckingStatus() {
  const visible = useDelayedFlag(true)
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-4 py-10" role="status" aria-live="polite">
      <span className={`${authPageStyles.statusSpinner} ${visible ? '' : 'invisible'}`} aria-hidden="true" />
      <p className={`${workspacePageStyles.emptyNote} ${visible ? '' : 'sr-only'}`}>로그인 상태를 확인하고 있어요.</p>
    </div>
  )
}

/**
 * 로그인이 필요한 화면 묶음입니다. 세션 복원이 끝나기 전(`unknown`)에는 리다이렉트하지 않고 확인 중 표시만 둬
 * 새로고침 때 로그인 화면이 깜빡이지 않게 합니다. 단계가 모자라면 작업 채팅으로 보내고 관리자 화면의 존재는
 * 드러내지 않습니다. 서버는 이 판단을 믿지 않고 모든 쓰기 API에서 같은 단계를 다시 검사합니다.
 */
export function RequireAuth({ minimumTier = 'MEMBER' }: { minimumTier?: AccountTier }) {
  const status = useAppSelector(selectAuthStatus)
  const account = useAppSelector(selectCurrentAccount)
  const location = useLocation()

  if (status === 'unknown') return <SessionCheckingStatus />
  if (status !== 'authenticated' || account === null) {
    return <Navigate replace to={loginPathFor(`${location.pathname}${location.search}`)} />
  }
  if (!meetsTier(account, minimumTier)) return <Navigate replace to={appPaths.chat} />
  // 환영 화면을 아직 마치지 않은 계정은 어떤 작업 화면을 열어도 먼저 환영 화면을 봅니다. 마치면 원래 가려던 곳으로 갑니다.
  if (!account.onboarded && location.pathname !== appPaths.welcome) return <Navigate replace to={appPaths.welcome} />
  return <Outlet />
}

/** 로그인·회원가입처럼 비로그인 상태에서만 의미 있는 화면입니다. 이미 로그인했으면 작업 화면으로 보냅니다. */
export function GuestOnly() {
  const status = useAppSelector(selectAuthStatus)
  const location = useLocation()

  if (status === 'unknown') return <SessionCheckingStatus />
  if (status === 'authenticated') return <Navigate replace to={readReturnPath(location.search)} />
  return <Outlet />
}

/**
 * 헤더 아래 공개 화면 묶음입니다. 로그인한 사용자는 사이드바 안에서만 화면을 보므로, 같은 내용의 내부 경로로
 * 보내고 검색 복귀 정보 같은 이동 상태는 그대로 넘깁니다.
 */
export function PublicOnly() {
  const status = useAppSelector(selectAuthStatus)
  const location = useLocation()

  if (status === 'unknown') return <SessionCheckingStatus />
  if (status === 'authenticated') {
    return <Navigate replace to={toAppPath(location.pathname, location.search)} state={location.state} />
  }
  return <Outlet />
}
