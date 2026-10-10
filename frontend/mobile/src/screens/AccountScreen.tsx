import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import type { SignupEmailVerification } from '@govbiz/shared/domain/entities/Account'
import type { AccountDeletionPreview } from '@govbiz/shared/domain/entities/AccountDeletionPreview'
import type { OAuthProviderId } from '@govbiz/shared/domain/entities/OAuthProvider'
import { isEmailAddress, normalizeEmail } from '@govbiz/shared/domain/entities/EmailAddress'
import { signUpPasswordIssue } from '@govbiz/shared/domain/usecases/SignUpUseCase'
import { changePassword, deleteAccount, getDeletionPreview, readOAuthProviders, sendSignupEmailCode, verifySignupEmailCode } from '../api/account'
import { ApiError } from '../api/client'
import { useAuth } from '../auth/session'
import { authErrorMessage } from '../auth/errors'
import { supportsNativeOAuth } from '../auth/oauth'
import { PlanUsageSection } from '../components/PlanUsage'
import { Page, Button, Field, Notice, Card, colors } from '../ui'
import { PartnerSheet } from '../components/PartnerSheet'
import { PasswordResetSheet } from '../components/PasswordResetSheet'
import { ServiceInformationSheet } from '../components/ServiceInformationSheet'
import { serviceInformation, type ServiceInformationSection } from '../content/serviceInformation'

export function AccountScreen({ onCompany, onSettings, initialMode = 'login', authOnly = false, onBusyChange, showSocialOptions = true }: {
  onCompany(): void; onSettings?(): void; initialMode?: 'login' | 'signup'; authOnly?: boolean; onBusyChange?(busy: boolean): void
  showSocialOptions?: boolean
}) {
  const auth = useAuth()
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [emailPass, setEmailPass] = useState<SignupEmailVerification | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const [providers, setProviders] = useState<OAuthProviderId[]>([])
  const [providerError, setProviderError] = useState<string | null>(null)
  const [providerRevision, setProviderRevision] = useState(0)
  const [resetOpen, setResetOpen] = useState(false)
  const [information, setInformation] = useState<ServiceInformationSection | null>(null)
  const [profileMode, setProfileMode] = useState<'password' | 'deletion' | null>(null)
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null)
  const [confirmDeletion, setConfirmDeletion] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const profileRunning = useRef(false)
  const owner = useRef(auth.session?.accessToken)
  owner.current = auth.session?.accessToken
  const socialEnabled = showSocialOptions && process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN === 'true' && supportsNativeOAuth()

  useEffect(() => {
    const controller = new AbortController()
    setProviders([]); setProviderError(null)
    if (auth.status === 'signedOut' && socialEnabled) void readOAuthProviders(controller.signal)
      .then(value => { if (!controller.signal.aborted) setProviders(value) })
      .catch(() => { if (!controller.signal.aborted) setProviderError('소셜 로그인 방법을 확인하지 못했어요. 이메일 로그인은 이용할 수 있어요.') })
    return () => controller.abort()
  }, [auth.status, socialEnabled, providerRevision])

  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false) }, [busy, onBusyChange])
  useEffect(() => {
    request.current?.abort(); profileRunning.current = false
    setPassword(''); setConfirmation(''); setEmailPass(null); setCode(''); setCodeSent(false)
    setProfileMode(null); setPreview(null); setConfirmDeletion(false); setCurrentPassword(''); setBusy(false); setResetOpen(false)
    setError(null); setNotice(null); setInformation(null)
  }, [auth.session?.accessToken])

  function updateEmail(value: string) {
    request.current?.abort()
    setEmail(value); setEmailPass(null); setCode(''); setCodeSent(false); setNotice(null); setError(null)
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError(null); setNotice(null)
    try { await action(controller.signal) } catch (failure) {
      if (!controller.signal.aborted) setError(authErrorMessage(failure))
    } finally {
      if (request.current === controller) setBusy(false)
    }
  }
  function validEmail(): string {
    const normalized = normalizeEmail(email)
    if (!isEmailAddress(normalized)) throw new Error('올바른 이메일 주소를 입력해 주세요. 예: name@example.com')
    return normalized
  }
  const sendCode = () => run(async (signal) => {
    await sendSignupEmailCode(validEmail(), signal)
    if (signal.aborted) return
    setCodeSent(true); setEmailPass(null); setNotice('메일로 보낸 6자리 인증번호를 입력해 주세요.')
  })
  const verifyCode = () => run(async (signal) => {
    if (!/^\d{6}$/.test(code)) throw new Error('6자리 인증번호를 입력해 주세요.')
    const pass = await verifySignupEmailCode(validEmail(), code, signal)
    if (signal.aborted) return
    setEmailPass(pass); setNotice('이메일 인증을 완료했습니다.')
  })
  const submit = () => run(async () => {
    const normalized = validEmail()
    if (mode === 'login') {
      if (!password || password.length > 72) throw new Error('비밀번호를 입력해 주세요. 최대 72자입니다.')
      await auth.signIn(normalized, password)
      return
    }
    if (!emailPass || Date.parse(emailPass.expiresAt) <= Date.now()) {
      setEmailPass(null)
      throw new Error('이메일 인증을 완료한 뒤 가입해 주세요. 만료됐다면 인증번호를 다시 받아 주세요.')
    }
    const passwordIssue = signUpPasswordIssue(password)
    if (passwordIssue === 'tooShort') throw new Error('비밀번호는 8자 이상 입력해 주세요.')
    if (passwordIssue === 'tooLong') throw new Error('비밀번호는 8~72자까지 입력해 주세요.')
    if (passwordIssue === 'invalidCharacter') throw new Error('비밀번호는 영문·숫자·특수문자만 쓸 수 있습니다.')
    if (password !== confirmation) throw new Error('비밀번호 확인이 일치하지 않습니다.')
    await auth.signUp({ email: normalized, password, emailPassToken: emailPass.passToken })
  })

  async function runProfile(action: (accessToken: string, signal: AbortSignal) => Promise<void>) {
    const token = auth.session?.accessToken
    if (!token || profileRunning.current) return
    profileRunning.current = true
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError(null); setNotice(null)
    try { await action(token, controller.signal) } catch (cause) {
      if (!controller.signal.aborted && owner.current === token) {
        if (cause instanceof ApiError && cause.status === 401) {
          setError('로그인이 만료됐어요. 계정 변경 결과를 확인하려면 다시 로그인해 주세요.')
          void auth.invalidateSession().catch(() => undefined)
        } else if (cause instanceof ApiError && cause.code === 'LAST_ADMIN_DELETION') setError('마지막 활성 관리자 계정은 삭제할 수 없어요.')
        else if (cause instanceof ApiError && cause.code === 'CURRENT_PASSWORD_MISMATCH') setError('현재 비밀번호가 일치하지 않아요. 입력을 확인해 주세요.')
        else setError(authErrorMessage(cause))
      }
    } finally { if (request.current === controller) { profileRunning.current = false; if (!controller.signal.aborted) setBusy(false) } }
  }
  function openPasswordChange() { setPassword(''); setConfirmation(''); setError(null); setProfileMode('password') }
  function openDeletion() {
    setProfileMode('deletion'); setPreview(null); setConfirmDeletion(false); setCurrentPassword('')
    void runProfile(async (token, signal) => {
      const result = await getDeletionPreview(token, signal)
      if (!signal.aborted && owner.current === token) setPreview(result)
    })
  }
  function closeProfile() {
    if (profileRunning.current) return
    setProfileMode(null); setPassword(''); setConfirmation(''); setCurrentPassword(''); setError(null)
  }
  const savePassword = () => runProfile(async (token, signal) => {
    if (signUpPasswordIssue(password)) throw new Error('새 비밀번호는 영문·숫자·특수문자로 8~72자 입력해 주세요.')
    if (password !== confirmation) throw new Error('새 비밀번호 확인이 일치하지 않아요.')
    await changePassword(token, password, signal)
    if (signal.aborted || owner.current !== token) return
    setProfileMode(null); setPassword(''); setConfirmation(''); setNotice('비밀번호를 변경했어요. 다른 기기의 로그인은 종료됐어요.')
  })
  const removeAccount = () => runProfile(async (token, signal) => {
    if (!preview || !confirmDeletion) return
    const hasPassword = auth.session?.account.hasPassword !== false
    if (hasPassword && !currentPassword) throw new Error('현재 비밀번호를 입력해 주세요.')
    await deleteAccount(token, hasPassword ? currentPassword : null, signal)
    if (!signal.aborted && owner.current === token) await auth.invalidateSession()
  })

  if (auth.status === 'loading') return <Page><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" /></Page>
  if (auth.status === 'unavailable') return <Page><Notice error>{auth.restoreError}</Notice><Button label="로그인 상태 다시 확인" onPress={() => void auth.refreshSession()} /><Button label="저장된 로그인 정보 지우기" variant="ghost" onPress={() => void run(() => auth.signOut())} />{error && <Notice error>{error}</Notice>}</Page>
  if (auth.session && authOnly) return <Page><ActivityIndicator accessibilityLabel="보던 화면으로 돌아가는 중" /></Page>
  if (auth.session) return <Page>
    <Text style={{ fontSize: 26, fontWeight: '700', color: colors.text }}>내 계정</Text>
    <Card><Text style={{ color: colors.text, fontSize: 18 }}>{auth.session.account.email}</Text><Text style={{ color: colors.muted, marginTop: 8 }}>{auth.session.account.company?.companyName ?? '기업 정보를 등록하면 맞춤 서비스를 이용할 수 있습니다.'}</Text></Card>
    <PlanUsageSection token={auth.session.accessToken} />
    {auth.restoreError && <Notice error>{auth.restoreError}</Notice>}
    <Button label={auth.session.account.company ? '기업 프로필 관리' : '기업 프로필 등록'} onPress={onCompany} />
    {onSettings && <Button label="알림 설정" variant="secondary" onPress={onSettings} />}
    {auth.session.account.hasPassword !== false && <Button label="비밀번호 변경" variant="secondary" disabled={busy} onPress={openPasswordChange} />}
    <Button label="로그아웃" variant="secondary" busy={busy} onPress={() => void run(() => auth.signOut())} />
    <Button label="계정 삭제" variant="ghost" disabled={busy} onPress={openDeletion} />
    {notice && <Notice>{notice}</Notice>}
    {error && <Notice error>{error}</Notice>}
    <Button label="개인정보 처리방침" variant="ghost" onPress={() => setInformation('privacy')} />
    <Button label="이용약관" variant="ghost" onPress={() => setInformation('terms')} />
    <Button label="도움말·문의" variant="ghost" onPress={() => setInformation('support')} />
    <ServiceInformationSheet section={information} onClose={() => setInformation(null)} />
    <PartnerSheet visible={profileMode !== null} title={profileMode === 'password' ? '비밀번호 변경' : '계정 삭제'} onClose={closeProfile}
      actions={<><Button label="취소" variant="secondary" disabled={busy} style={{ flex: 1 }} onPress={closeProfile} />
        {profileMode === 'password' ? <Button label="새 비밀번호 저장" busy={busy} disabled={busy} style={{ flex: 2 }} onPress={() => void savePassword()} />
          : <Button label={confirmDeletion ? '계정 삭제 확인' : '내용 확인하고 계속'} variant={confirmDeletion ? 'danger' : 'primary'}
            busy={busy} disabled={busy || !preview} style={{ flex: 2 }} onPress={() => confirmDeletion ? void removeAccount() : setConfirmDeletion(true)} />}</>}>
      {profileMode === 'password' ? <><Text>현재 로그인한 세션만 유지하고 다른 기기의 로그인을 종료해요.</Text>
        <Field label="새 비밀번호" value={password} onChangeText={setPassword} secureTextEntry maxLength={72} editable={!busy} autoCapitalize="none" />
        <Field label="새 비밀번호 확인" value={confirmation} onChangeText={setConfirmation} secureTextEntry maxLength={72} editable={!busy} autoCapitalize="none" /></>
        : !preview ? <>{busy && <ActivityIndicator accessibilityLabel="계정 삭제 내용 확인 중" />}
          {!busy && <Button label="삭제 내용 다시 확인" variant="secondary" onPress={openDeletion} />}</>
          : <><Text>계정 삭제 시 다음 항목을 정리해요. 삭제 후에는 이 계정으로 로그인할 수 없어요.</Text>
            <Text>{preview.hasCompany ? '등록한 기업 정보를 삭제해요.' : '등록한 기업 정보가 없어요.'}</Text>
            <Text>내 모집글 {preview.openRecruitmentCount}건 마감 · 받은 대기 제안 {preview.receivedPendingProposalCount}건 만료</Text>
            <Text>보낸 대기 제안 {preview.sentPendingProposalCount}건 철회 · 로그인 세션 종료</Text>
            {confirmDeletion && (auth.session.account.hasPassword !== false
              ? <Field label="삭제 확인용 현재 비밀번호" value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry maxLength={72} editable={!busy} autoCapitalize="none" />
              : <Notice>비밀번호가 없는 소셜 계정이에요. 현재 로그인 세션으로 본인을 확인해요.</Notice>)}
          </>}
      {error && <Notice error>{error}</Notice>}
    </PartnerSheet>
  </Page>

  return <Page>
    <Text style={{ fontSize: 28, fontWeight: '700', color: colors.text }}>{mode === 'login' ? 'GovBiz 로그인' : '계정 만들기'}</Text>
    <Text style={{ color: colors.muted }}>웹에서 사용하던 계정과 관심 공고를 앱에서도 이어서 사용하세요.</Text>
    {socialEnabled && providers.length > 0 && <View style={{ gap: 10 }}>{(['kakao', 'google'] as const).filter(provider => providers.includes(provider)).map(provider =>
      <Button key={provider} label={provider === 'kakao' ? '카카오로 계속하기' : 'Google로 계속하기'} variant="secondary" disabled={busy}
        onPress={() => void run(() => auth.signInWithOAuth(provider))} />)}</View>}
    {providerError && <><Notice error>{providerError}</Notice><Button label="소셜 로그인 방법 다시 확인" variant="ghost" onPress={() => setProviderRevision(value => value + 1)} /></>}
    <Field label="이메일" value={email} onChangeText={updateEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" editable={!busy} maxLength={320} />
    {mode === 'signup' && <>
      <Button label={emailPass ? '인증번호 다시 받기' : codeSent ? '인증번호 재전송' : '인증번호 받기'} variant="secondary" onPress={() => void sendCode()} disabled={busy} />
      {codeSent && !emailPass && <><Field label="인증번호" value={code} onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" autoComplete="one-time-code" maxLength={6} editable={!busy} /><Button label="인증번호 확인" onPress={() => void verifyCode()} disabled={busy} /></>}
    </>}
    <Field label="비밀번호" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} maxLength={72} editable={!busy} />
    {mode === 'signup' && <><Field label="비밀번호 확인" value={confirmation} onChangeText={setConfirmation} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" maxLength={72} editable={!busy} /><Text style={{ color: colors.muted }}>비밀번호는 영문·숫자·특수문자만 사용할 수 있으며, 8~72자로 입력해 주세요. {serviceInformation.terms.preparing || serviceInformation.privacy.preparing
      ? '이용약관과 개인정보 처리방침은 운영 문서 확정 전의 초안입니다.' : '가입 전에 이용약관과 개인정보 처리방침을 확인해 주세요.'}</Text>
      <Button label="이용약관 읽기" variant="ghost" disabled={busy} onPress={() => setInformation('terms')} />
      <Button label="개인정보 처리방침 읽기" variant="ghost" disabled={busy} onPress={() => setInformation('privacy')} /></>}
    {notice && <Notice>{notice}</Notice>}
    {error && <Notice error>{error}</Notice>}
    {auth.restoreError && <Notice error>{auth.restoreError}</Notice>}
    <Button label={mode === 'login' ? '로그인' : '회원가입'} onPress={() => void submit()} busy={busy} disabled={mode === 'signup' && !emailPass} />
    <Button label={mode === 'login' ? '이메일로 회원가입' : '기존 계정으로 로그인'} variant="ghost" disabled={busy} onPress={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); setNotice(null); setPassword(''); setConfirmation(''); setEmailPass(null); setCodeSent(false); setCode('') }} />
    {mode === 'login' && <Button label="비밀번호 찾기" variant="ghost" disabled={busy} onPress={() => setResetOpen(true)} />}
    <PasswordResetSheet visible={resetOpen} onClose={() => setResetOpen(false)} />
    <ServiceInformationSheet section={information} onClose={() => setInformation(null)} />
    {auth.restoreError && <Button label="기기 로그인 정보 다시 지우기" variant="ghost" onPress={() => void run(() => auth.signOut())} disabled={busy} />}
  </Page>
}
