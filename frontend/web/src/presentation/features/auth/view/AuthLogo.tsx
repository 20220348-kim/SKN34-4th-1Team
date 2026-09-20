import { Link } from 'react-router'

import { authPageStyles } from './AuthPage.styles'

/** 로그인·회원가입·비밀번호 찾기 카드 맨 위에 놓는 로고입니다. 누르면 로그인 없이 쓰는 검색 화면으로 돌아갑니다. */
export function AuthLogo() {
  return (
    <Link className={authPageStyles.logo} to="/" aria-label="GovBiz 홈으로">
      <span className={authPageStyles.logoMark} aria-hidden="true">G</span>
      <strong className={authPageStyles.logoTitle}>GovBiz</strong>
    </Link>
  )
}
