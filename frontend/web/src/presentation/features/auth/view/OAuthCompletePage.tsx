import { Link } from 'react-router'

import { oauthCompleteMessages, useOAuthCompleteViewModel } from '../viewmodel/useOAuthCompleteViewModel'
import { AuthLogo } from './AuthLogo'
import { authPageStyles } from './AuthPage.styles'

/**
 * 소셜 로그인 뒤 서버가 보내는 화면입니다. 세션을 확인하는 잠깐 동안만 보이고 곧 원래 가려던 화면으로 이동합니다.
 * 로그인 카드와 같은 자리에 스피너 + 제목 + 설명 한 줄을 두고, 10초가 지나도 넘어가지 않으면 로그인으로 돌아가는 링크를 보여 줍니다.
 */
export function OAuthCompletePage() {
  const { message, description, stuck, loginPath } = useOAuthCompleteViewModel()

  return (
    <main className={authPageStyles.page}>
      <section className={authPageStyles.formPanel}>
        <div className={authPageStyles.card}>
          <AuthLogo />
          <div className={authPageStyles.statusBlock} role="status" aria-live="polite">
            <span className={authPageStyles.statusSpinner} aria-hidden="true" />
            <h1 className={authPageStyles.statusTitle}>{message}</h1>
            <p className={authPageStyles.statusDescription}>{description}</p>
          </div>
          {stuck ? (
            <p className={authPageStyles.statusFallback}>
              <span>{oauthCompleteMessages.stuck}</span>
              <Link className={authPageStyles.footerLink} to={loginPath}>{oauthCompleteMessages.backToLogin}</Link>
            </p>
          ) : null}
        </div>
      </section>
    </main>
  )
}
