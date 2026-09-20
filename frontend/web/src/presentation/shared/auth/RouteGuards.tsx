import { Navigate, Outlet, useLocation } from 'react-router'

import { useAppSelector } from '../../../app/hooks'
import { meetsTier, type AccountTier } from '../../../domain/entities/Account'
import { appPaths, toAppPath } from '../routes/appPaths'
import { loginPathFor } from './returnPath'
import { readReturnPath } from './returnPath'
import { selectAuthStatus, selectCurrentAccount } from './state/authSlice'

/**
 * 로그인이 필요한 화면 묶음입니다. 세션 복원이 끝나기 전(`unknown`)에는 리다이렉트하지 않고 빈 화면을 유지해
 * 새로고침 때 로그인 화면이 깜빡이지 않게 합니다. 단계가 모자라면 작업 채팅으로 보내고 관리자 화면의 존재는
 * 드러내지 않습니다. 서버는 이 판단을 믿지 않고 모든 쓰기 API에서 같은 단계를 다시 검사합니다.
 */
export function RequireAuth({ minimumTier = 'MEMBER' }: { minimumTier?: AccountTier }) {
  const status = useAppSelector(selectAuthStatus)
  const account = useAppSelector(selectCurrentAccount)
  const location = useLocation()

  if (status === 'unknown') return null
  if (status !== 'authenticated' || account === null) {
    return <Navigate replace to={loginPathFor(`${location.pathname}${location.search}`)} />
  }
  if (!meetsTier(account, minimumTier)) return <Navigate replace to={appPaths.chat} />
  return <Outlet />
}

/** 로그인·회원가입처럼 비로그인 상태에서만 의미 있는 화면입니다. 이미 로그인했으면 작업 화면으로 보냅니다. */
export function GuestOnly() {
  const status = useAppSelector(selectAuthStatus)
  const location = useLocation()

  if (status === 'unknown') return null
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

  if (status === 'unknown') return null
  if (status === 'authenticated') {
    return <Navigate replace to={toAppPath(location.pathname, location.search)} state={location.state} />
  }
  return <Outlet />
}
