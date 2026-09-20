import { Link } from 'react-router'

import { resetPasswordMessages, useResetPasswordViewModel } from '../viewmodel/useResetPasswordViewModel'
import { AuthLogo } from './AuthLogo'
import { authPageStyles } from './AuthPage.styles'

/** 메일 링크로 여는 비밀번호 재설정 화면입니다. 토큰은 주소의 `#token=`에서 읽습니다. */
export function ResetPasswordPage() {
  const {
    hasToken,
    isTokenRejected,
    password,
    passwordConfirmation,
    isDone,
    error,
    isSubmitting,
    updatePassword,
    updatePasswordConfirmation,
    submit,
  } = useResetPasswordViewModel()
  const canEdit = hasToken && !isTokenRejected && !isDone

  return (
    <main className={authPageStyles.page}>
      <section className={authPageStyles.formPanel}>
        <form className={authPageStyles.card} onSubmit={submit} aria-label="비밀번호 재설정" noValidate>
          <AuthLogo />
          <div className={authPageStyles.cardHeader}>
            <p className={authPageStyles.cardEyebrow}>비밀번호 재설정</p>
            <h1 className={authPageStyles.cardTitle}>새 비밀번호 설정</h1>
            <p className={authPageStyles.cardDescription}>
              새 비밀번호를 저장하면 다른 기기의 로그인은 모두 끝나고 새 비밀번호로 다시 로그인합니다.
            </p>
          </div>

          {!hasToken ? (
            <p className={authPageStyles.fieldError} role="alert">{resetPasswordMessages.missingToken}</p>
          ) : null}
          {isTokenRejected ? (
            <p className={authPageStyles.fieldError} role="alert">{resetPasswordMessages.tokenInvalid}</p>
          ) : null}
          {isDone ? <p className={authPageStyles.notice} role="status">{resetPasswordMessages.done}</p> : null}

          {canEdit ? (
            <div className={authPageStyles.fields}>
              <div className={authPageStyles.field}>
                <label className={authPageStyles.fieldName} htmlFor="reset-password">새 비밀번호</label>
                <input
                  className={authPageStyles.fieldControl}
                  id="reset-password"
                  type="password"
                  name="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={72}
                  aria-invalid={error?.field === 'password'}
                  aria-describedby={error?.field === 'password' ? 'reset-password-hint reset-password-error' : 'reset-password-hint'}
                  placeholder="새 비밀번호를 입력해 주세요."
                  value={password}
                  onChange={(event) => updatePassword(event.target.value)}
                />
                <span id="reset-password-hint" className={authPageStyles.fieldHint}>8자 이상 72자 이하로 입력합니다.</span>
              </div>

              <label className={authPageStyles.field}>
                <span className={authPageStyles.fieldName}>새 비밀번호 확인</span>
                <input
                  className={authPageStyles.fieldControl}
                  type="password"
                  name="passwordConfirmation"
                  autoComplete="new-password"
                  required
                  aria-invalid={error?.field === 'passwordConfirmation'}
                  aria-describedby={error?.field === 'passwordConfirmation' ? 'reset-password-error' : undefined}
                  placeholder="새 비밀번호를 다시 입력해 주세요."
                  value={passwordConfirmation}
                  onChange={(event) => updatePasswordConfirmation(event.target.value)}
                />
              </label>
            </div>
          ) : null}

          {error ? <p id="reset-password-error" className={authPageStyles.fieldError} role="alert">{error.message}</p> : null}
          {canEdit ? (
            <button className={authPageStyles.submitButton} type="submit" disabled={isSubmitting}>
              {isSubmitting ? '변경 중…' : '비밀번호 변경'}
            </button>
          ) : null}

          {isDone ? (
            <Link className={authPageStyles.primaryLink} to="/login">
              로그인하러 가기
            </Link>
          ) : null}

          <p className={authPageStyles.linksRow}>
            <Link className={authPageStyles.footerLink} to="/forgot-password">재설정 링크 다시 요청</Link>
            <span className={authPageStyles.linkSeparator} aria-hidden="true" />
            <Link className={authPageStyles.footerLink} to="/login">로그인으로 돌아가기</Link>
          </p>
        </form>
      </section>
    </main>
  )
}
