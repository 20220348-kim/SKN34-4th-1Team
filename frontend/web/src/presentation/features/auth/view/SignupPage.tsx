import { Link } from 'react-router'

import { useSignupViewModel } from '../viewmodel/useSignupViewModel'
import { AuthLogo } from './AuthLogo'
import { authPageStyles } from './AuthPage.styles'
import { EmailIcon } from './EmailIcon'
import { OAuthSignInButtons } from './OAuthSignInButtons'

/**
 * 회원가입 화면입니다. 로그인 화면과 같은 껍데기를 쓰고 소셜 가입 버튼과 이메일·인증번호·비밀번호 입력만 둡니다.
 * 이메일 옆 "인증번호 받기"로 메일을 보내고 바로 아래 칸에서 번호를 맞힌 뒤에만 가입할 수 있습니다.
 * 기업 정보는 가입 뒤 프로필 단계에서 받고, 약관 동의는 가입 버튼 아래 안내로 갈음해 가입 시각을 서버가 기록합니다.
 */
export function SignupPage() {
  const {
    loginPath,
    oauthOptions,
    email,
    code,
    emailStep,
    codeNotice,
    password,
    passwordConfirmation,
    error,
    isSendingCode,
    isVerifyingCode,
    isSubmitting,
    updateEmail,
    updateCode,
    updatePassword,
    updatePasswordConfirmation,
    sendCode,
    verifyCode,
    submit,
  } = useSignupViewModel()
  const isVerified = emailStep === 'verified'

  return (
    <main className={authPageStyles.page}>
      <section className={authPageStyles.formPanel}>
        <form className={authPageStyles.card} onSubmit={submit} aria-label="회원가입" noValidate>
          <AuthLogo />
          <h1 className="sr-only">회원가입</h1>

          <OAuthSignInButtons mode="signup" options={oauthOptions} />

          <hr className={authPageStyles.sectionRule} />

          <div className={authPageStyles.fields}>
            <div className={authPageStyles.field}>
              <label className={authPageStyles.fieldName} htmlFor="signup-email">이메일</label>
              <div className={authPageStyles.inlineRow}>
                <input
                  className={authPageStyles.fieldControl}
                  id="signup-email"
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  readOnly={isVerified}
                  aria-invalid={error?.field === 'email'}
                  aria-describedby={error?.field === 'email' ? 'signup-error' : undefined}
                  placeholder="이메일을 입력해 주세요."
                  value={email}
                  onChange={(event) => updateEmail(event.target.value)}
                />
                {isVerified ? (
                  <span className={authPageStyles.verifiedTag}>인증됨</span>
                ) : (
                  <button className={authPageStyles.inlineButton} type="button" disabled={isSendingCode} onClick={() => void sendCode()}>
                    {isSendingCode ? '보내는 중…' : emailStep === 'sent' ? '다시 받기' : '인증번호 받기'}
                  </button>
                )}
              </div>
            </div>

            {emailStep === 'sent' ? (
              <div className={authPageStyles.field}>
                <label className={authPageStyles.fieldName} htmlFor="signup-code">인증번호</label>
                <div className={authPageStyles.inlineRow}>
                  <input
                    className={authPageStyles.fieldControl}
                    id="signup-code"
                    type="text"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    aria-invalid={error?.field === 'code'}
                    aria-describedby={error?.field === 'code' ? 'signup-error' : undefined}
                    placeholder="메일로 받은 6자리 인증번호"
                    value={code}
                    onChange={(event) => updateCode(event.target.value)}
                  />
                  <button className={authPageStyles.inlineButton} type="button" disabled={isVerifyingCode} onClick={() => void verifyCode()}>
                    {isVerifyingCode ? '확인 중…' : '확인'}
                  </button>
                </div>
              </div>
            ) : null}
            {codeNotice ? <p className={authPageStyles.notice} role="status">{codeNotice}</p> : null}

            <div className={authPageStyles.field}>
              <label className={authPageStyles.fieldName} htmlFor="signup-password">비밀번호</label>
              <input
                className={authPageStyles.fieldControl}
                id="signup-password"
                type="password"
                name="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={72}
                aria-invalid={error?.field === 'password'}
                aria-describedby={error?.field === 'password' ? 'signup-password-hint signup-error' : 'signup-password-hint'}
                placeholder="비밀번호를 입력해 주세요. (8~72자)"
                value={password}
                onChange={(event) => updatePassword(event.target.value)}
              />
              <span id="signup-password-hint" className="sr-only">8자 이상 72자 이하로 입력합니다.</span>
            </div>

            <label className={authPageStyles.field}>
              <span className={authPageStyles.fieldName}>비밀번호 확인</span>
              <input
                className={authPageStyles.fieldControl}
                type="password"
                name="passwordConfirmation"
                autoComplete="new-password"
                required
                aria-invalid={error?.field === 'passwordConfirmation'}
                aria-describedby={error?.field === 'passwordConfirmation' ? 'signup-error' : undefined}
                placeholder="비밀번호를 다시 입력해 주세요."
                value={passwordConfirmation}
                onChange={(event) => updatePasswordConfirmation(event.target.value)}
              />
            </label>
          </div>

          {error ? <p id="signup-error" className={authPageStyles.fieldError} role="alert">{error.message}</p> : null}
          <button className={authPageStyles.submitButton} type="submit" disabled={isSubmitting || !isVerified}>
            <EmailIcon className={authPageStyles.buttonIcon} />
            {isSubmitting ? '가입 중…' : '이메일로 가입하기'}
          </button>
          <p className={authPageStyles.fieldHint}>가입하면 이용약관과 개인정보 처리방침에 동의한 것으로 봅니다.</p>

          <p className={authPageStyles.linksRow}>
            <span className={authPageStyles.linksLead}>이미 계정이 있으신가요?</span>
            <Link className={authPageStyles.footerLink} to={loginPath}>로그인</Link>
          </p>
        </form>
      </section>
    </main>
  )
}
