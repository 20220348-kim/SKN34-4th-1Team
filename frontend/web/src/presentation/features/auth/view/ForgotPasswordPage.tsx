import { Link } from 'react-router'

import { publicPaths } from '../../../shared/routes/appPaths'
import { MAX_EMAIL_LENGTH } from '../../../../domain/entities/EmailAddress'
import { useForgotPasswordViewModel } from '../viewmodel/useForgotPasswordViewModel'
import { AuthLogo } from './AuthLogo'
import { authPageStyles } from './AuthPage.styles'

/**
 * 비밀번호 찾기 화면입니다. 로그인 화면의 "비밀번호 찾기" 링크가 이 화면으로 옵니다.
 * 이메일 형식이 맞을 때만 "인증번호 받기"가 켜지고, 메일로 온 6자리 인증번호를 맞히면 새 비밀번호 화면으로 넘어갑니다.
 */
export function ForgotPasswordPage() {
  const vm = useForgotPasswordViewModel()
  const isCodeStep = vm.step === 'code'

  return (
    <main className={authPageStyles.page}>
      <section className={authPageStyles.formPanel}>
        <form className={authPageStyles.card} onSubmit={vm.submit} aria-label="비밀번호 찾기" noValidate>
          <AuthLogo />
          <div className={authPageStyles.cardHeader}>
            <p className={authPageStyles.cardEyebrow}>비밀번호 찾기</p>
            <h1 className={authPageStyles.cardTitle}>{isCodeStep ? '인증번호 입력' : '비밀번호를 잊으셨나요?'}</h1>
            <p className={authPageStyles.cardDescription}>
              {isCodeStep
                ? '메일로 보낸 6자리 인증번호를 입력하면 새 비밀번호를 정할 수 있습니다.'
                : '가입한 이메일로 6자리 인증번호를 보내 드립니다. 카카오·Google로 가입한 계정은 소셜 로그인으로 들어와 주세요.'}
            </p>
          </div>

          <div className={authPageStyles.fields}>
            {isCodeStep ? (
              <div className={authPageStyles.field}>
                <span className={authPageStyles.fieldName}>인증번호를 보낸 이메일</span>
                <div className={authPageStyles.inlineRow}>
                  <input className={authPageStyles.fieldControl} type="email" name="sentEmail" aria-label="인증번호를 보낸 이메일" readOnly value={vm.email} />
                  <button className={authPageStyles.inlineButton} type="button" onClick={vm.changeEmail}>이메일 바꾸기</button>
                </div>
              </div>
            ) : (
              <label className={authPageStyles.field}>
                <span className={authPageStyles.fieldName}>이메일</span>
                <input
                  className={authPageStyles.fieldControl}
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  aria-invalid={vm.error?.field === 'email'}
                  aria-describedby={vm.error ? 'forgot-password-error' : undefined}
                  placeholder="가입한 이메일을 입력해 주세요."
                  maxLength={MAX_EMAIL_LENGTH}
                  spellCheck={false}
                  value={vm.email}
                  onChange={(event) => vm.updateEmail(event.target.value)}
                  onBlur={vm.checkEmail}
                />
              </label>
            )}

            {isCodeStep ? (
              <div className={authPageStyles.field}>
                <label className={authPageStyles.fieldName} htmlFor="forgot-password-code">인증번호</label>
                <input
                  className={authPageStyles.fieldControl}
                  id="forgot-password-code"
                  type="text"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  aria-invalid={vm.error?.field === 'code'}
                  aria-describedby={vm.error ? 'forgot-password-error' : undefined}
                  placeholder="메일로 받은 6자리 인증번호"
                  value={vm.code}
                  onChange={(event) => vm.updateCode(event.target.value)}
                />
              </div>
            ) : null}
          </div>

          {vm.notice ? <p className={authPageStyles.notice} role="status">{vm.notice}</p> : null}
          {vm.error ? <p id="forgot-password-error" className={authPageStyles.fieldError} role="alert">{vm.error.message}</p> : null}

          {isCodeStep ? (
            <>
              <button className={authPageStyles.submitButton} type="submit" disabled={!vm.canVerify}>
                {vm.isVerifying ? '확인 중…' : '확인'}
              </button>
              <button className={authPageStyles.inlineButton} type="button" disabled={vm.isSending} onClick={vm.resendCode}>
                {vm.isSending ? '보내는 중…' : '인증번호 다시 받기'}
              </button>
            </>
          ) : (
            <button className={authPageStyles.submitButton} type="submit" disabled={!vm.canSend}>
              {vm.isSending ? '보내는 중…' : '인증번호 받기'}
            </button>
          )}

          <p className={authPageStyles.linksRow}>
            <Link className={authPageStyles.footerLink} to={publicPaths.login}>로그인으로 돌아가기</Link>
            <span className={authPageStyles.linkSeparator} aria-hidden="true" />
            <Link className={authPageStyles.footerLink} to={publicPaths.signup}>회원가입</Link>
          </p>
        </form>
      </section>
    </main>
  )
}
