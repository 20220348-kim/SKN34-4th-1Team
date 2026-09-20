import { useOAuthCompleteViewModel } from '../viewmodel/useOAuthCompleteViewModel'
import { AuthLogo } from './AuthLogo'
import { authPageStyles } from './AuthPage.styles'

/** 소셜 로그인 뒤 서버가 보내는 화면입니다. 세션을 확인하는 잠깐 동안만 보이고 곧 원래 가려던 화면으로 이동합니다. */
export function OAuthCompletePage() {
  const { message } = useOAuthCompleteViewModel()

  return (
    <main className={authPageStyles.page}>
      <section className={authPageStyles.formPanel}>
        <div className={authPageStyles.card}>
          <AuthLogo />
          <p className={authPageStyles.notice} role="status">{message}</p>
        </div>
      </section>
    </main>
  )
}
