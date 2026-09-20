import { Link } from 'react-router'

import { forgotPasswordMessages, useForgotPasswordViewModel } from '../viewmodel/useForgotPasswordViewModel'
import { AuthLogo } from './AuthLogo'
import { authPageStyles } from './AuthPage.styles'

/** 비밀번호 찾기 화면입니다. 로그인 화면의 "비밀번호 찾기" 링크가 이 화면으로 옵니다. */
export function ForgotPasswordPage() {
  const { email, isSent, error, isSubmitting, updateEmail, submit } = useForgotPasswordViewModel()

  return (
    <main className={authPageStyles.page}>
      <section className={authPageStyles.formPanel}>
        <form className={authPageStyles.card} onSubmit={submit} aria-label="비밀번호 찾기" noValidate>
          <AuthLogo />
          <div className={authPageStyles.cardHeader}>
            <p className={authPageStyles.cardEyebrow}>비밀번호 찾기</p>
            <h1 className={authPageStyles.cardTitle}>비밀번호를 잊으셨나요?</h1>
            <p className={authPageStyles.cardDescription}>
              가입한 이메일을 입력하면 비밀번호를 다시 정할 수 있는 링크를 보내 드립니다.
            </p>
          </div>

          {isSent ? (
            <p className={authPageStyles.notice} role="status">{forgotPasswordMessages.sent}</p>
          ) : (
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
                  aria-describedby={error ? 'forgot-password-error' : undefined}
                  placeholder="가입한 이메일을 입력해 주세요."
                  value={email}
                  onChange={(event) => updateEmail(event.target.value)}
                />
              </label>
            </div>
          )}

          {error ? <p id="forgot-password-error" className={authPageStyles.fieldError} role="alert">{error.message}</p> : null}
          {isSent ? null : (
            <button className={authPageStyles.submitButton} type="submit" disabled={isSubmitting}>
              {isSubmitting ? '보내는 중…' : '재설정 링크 보내기'}
            </button>
          )}

          <p className={authPageStyles.linksRow}>
            <Link className={authPageStyles.footerLink} to="/login">로그인으로 돌아가기</Link>
            <span className={authPageStyles.linkSeparator} aria-hidden="true" />
            <Link className={authPageStyles.footerLink} to="/signup">회원가입</Link>
          </p>
        </form>
      </section>
    </main>
  )
}
