import { Link } from 'react-router'

import { useLoginViewModel } from '../viewmodel/useLoginViewModel'
import { AuthLogo } from './AuthLogo'
import { authPageStyles } from './AuthPage.styles'
import { EmailIcon } from './EmailIcon'
import { OAuthSignInButtons } from './OAuthSignInButtons'

/**
 * 로그인 화면입니다. 공용 헤더의 로그인 버튼이 이 화면으로 옵니다. 테두리 없는 가운데 열에 로고, 소셜 로그인 버튼,
 * 수평선, 이메일 입력과 "이메일로 로그인" 버튼, 회원가입·비밀번호 찾기 링크 순으로 놓습니다.
 */
export function LoginPage() {
  const {
    signupPath,
    oauthOptions,
    email,
    password,
    rememberMe,
    error,
    isSubmitting,
    updateEmail,
    updatePassword,
    toggleRememberMe,
    submit,
  } = useLoginViewModel()

  return (
    <main className={authPageStyles.page}>
      <section className={authPageStyles.formPanel}>
        <form className={authPageStyles.card} onSubmit={submit} aria-label="로그인" noValidate>
          <AuthLogo />
          <h1 className="sr-only">로그인</h1>

          <OAuthSignInButtons mode="login" options={oauthOptions} />

          <hr className={authPageStyles.sectionRule} />

          <div className={authPageStyles.fields}>
            <label className={authPageStyles.field}>
              <span className={authPageStyles.fieldName}>이메일</span>
              <input
                className={authPageStyles.fieldControl}
                type="email"
                name="email"
                autoComplete="email"
                required
                aria-invalid={error?.field === 'email'}
                aria-describedby={error ? 'login-error' : undefined}
                placeholder="이메일을 입력해 주세요."
                value={email}
                onChange={(event) => updateEmail(event.target.value)}
              />
            </label>

            <label className={authPageStyles.field}>
              <span className={authPageStyles.fieldName}>비밀번호</span>
              <input
                className={authPageStyles.fieldControl}
                type="password"
                name="password"
                autoComplete="current-password"
                required
                aria-invalid={error?.field === 'password'}
                aria-describedby={error ? 'login-error' : undefined}
                placeholder="비밀번호를 입력해 주세요."
                value={password}
                onChange={(event) => updatePassword(event.target.value)}
              />
            </label>

            <div className={authPageStyles.optionsRow}>
              <label className={authPageStyles.checkboxLabel}>
                <input
                  className={authPageStyles.checkbox}
                  type="checkbox"
                  name="rememberMe"
                  checked={rememberMe}
                  onChange={toggleRememberMe}
                />
                로그인 상태 유지
              </label>
            </div>
          </div>

          {error ? <p id="login-error" className={authPageStyles.fieldError} role="alert">{error.message}</p> : null}
          <button className={authPageStyles.submitButton} type="submit" disabled={isSubmitting}>
            <EmailIcon className={authPageStyles.buttonIcon} />
            {isSubmitting ? '로그인 중…' : '이메일로 로그인'}
          </button>

          <p className={authPageStyles.linksRow}>
            <Link className={authPageStyles.footerLink} to={signupPath}>회원가입</Link>
            <span className={authPageStyles.linkSeparator} aria-hidden="true" />
            <Link className={authPageStyles.footerLink} to="/forgot-password">비밀번호 찾기</Link>
          </p>
        </form>
      </section>
    </main>
  )
}
