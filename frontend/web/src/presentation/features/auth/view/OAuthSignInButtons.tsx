import type { OAuthSignInOption } from '../viewmodel/useOAuthSignInOptions'
import { authPageStyles } from './AuthPage.styles'

/** 두 공급자가 같은 형식을 쓰도록 "{공급자} 계정으로 로그인 / 시작하기"로 맞춥니다. 카카오는 공식 표기 "카카오계정"을 씁니다. */
const labels = {
  login: { kakao: '카카오계정으로 로그인', google: 'Google 계정으로 로그인' },
  signup: { kakao: '카카오계정으로 시작하기', google: 'Google 계정으로 시작하기' },
} as const

/**
 * 카카오·Google 로그인 버튼입니다. 두 공급자의 버튼 디자인 가이드를 따라 카카오는 #FEE500 바탕에 검은 말풍선 심볼,
 * Google은 흰 바탕·회색 테두리에 공식 G 로고를 쓰고 두 버튼을 같은 크기로 둡니다. 링크라 누르면 브라우저가 서버의
 * 로그인 시작 주소로 이동하며, 처음 온 계정은 그대로 가입됩니다.
 */
export function OAuthSignInButtons({ mode, options }: { mode: 'login' | 'signup'; options: OAuthSignInOption[] }) {
  return (
    <div className={authPageStyles.socialButtons}>
      {options.map((option) => (
        <a
          key={option.id}
          className={option.id === 'kakao' ? authPageStyles.kakaoButton : authPageStyles.googleButton}
          href={option.href}
        >
          {option.id === 'kakao' ? <KakaoSymbol /> : <GoogleLogo />}
          {labels[mode][option.id]}
        </a>
      ))}
    </div>
  )
}

/** 카카오 말풍선 심볼입니다. 가이드대로 검정(#000000)만 씁니다. */
function KakaoSymbol() {
  return (
    <svg className={authPageStyles.buttonIcon} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#000000"
        d="M12 3C6.48 3 2 6.48 2 10.8c0 2.78 1.86 5.22 4.66 6.6l-.95 3.48c-.08.3.26.54.52.37l4.15-2.74c.53.06 1.07.09 1.62.09 5.52 0 10-3.48 10-7.8S17.52 3 12 3z"
      />
    </svg>
  )
}

/** Google의 표준 G 로고입니다. 네 색을 바꾸거나 늘리지 않습니다. */
function GoogleLogo() {
  return (
    <svg className={authPageStyles.buttonIcon} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}
