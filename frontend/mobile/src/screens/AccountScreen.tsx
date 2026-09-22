import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { z } from 'zod'
import { isEmailAddress, normalizeEmail } from '@govbiz/shared/domain/entities/EmailAddress'
import { isValidSignUpPassword } from '@govbiz/shared/domain/usecases/SignUpUseCase'
import { apiRequest } from '../api/client'
import { useAuth } from '../auth/session'
import { authErrorMessage } from '../auth/errors'
import { supportsNativeOAuth } from '../auth/oauth'
import { Page, Button, Field, Notice, Card, colors } from '../ui'

const emailPassSchema = z.object({ passToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.string().datetime({ offset: true }) })

export function AccountScreen({ onCompany }: { onCompany(): void }) {
  const auth = useAuth()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [emailPass, setEmailPass] = useState<{ passToken: string; expiresAt: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)

  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    setPassword(''); setConfirmation(''); setEmailPass(null); setCode(''); setCodeSent(false)
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
    await apiRequest('/api/v1/auth/signup/email-code', { method: 'POST', body: { email: validEmail() }, signal })
    if (signal.aborted) return
    setCodeSent(true); setEmailPass(null); setNotice('메일로 보낸 6자리 인증번호를 입력해 주세요.')
  })
  const verifyCode = () => run(async (signal) => {
    if (!/^\d{6}$/.test(code)) throw new Error('6자리 인증번호를 입력해 주세요.')
    const pass = emailPassSchema.parse(await apiRequest('/api/v1/auth/signup/email-code/verify', { method: 'POST', body: { email: validEmail(), code }, signal }))
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
    if (!isValidSignUpPassword(password)) throw new Error('비밀번호는 8자 이상 72자 이하로 입력해 주세요.')
    if (password !== confirmation) throw new Error('비밀번호 확인이 일치하지 않습니다.')
    await auth.signUp({ email: normalized, password, emailPassToken: emailPass.passToken })
  })

  if (auth.status === 'loading') return <Page><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" /></Page>
  if (auth.status === 'unavailable') return <Page><Notice error>{auth.restoreError}</Notice><Button label="로그인 상태 다시 확인" onPress={() => void auth.refreshSession()} /><Button label="저장된 로그인 정보 지우기" variant="ghost" onPress={() => void run(() => auth.signOut())} />{error && <Notice error>{error}</Notice>}</Page>
  if (auth.session) return <Page>
    <Text style={{ fontSize: 26, fontWeight: '700', color: colors.text }}>내 계정</Text>
    <Card><Text style={{ color: colors.text, fontSize: 18 }}>{auth.session.account.email}</Text><Text style={{ color: colors.muted, marginTop: 8 }}>{auth.session.account.company?.companyName ?? '기업 정보를 등록하면 맞춤 서비스를 이용할 수 있습니다.'}</Text></Card>
    {auth.restoreError && <Notice error>{auth.restoreError}</Notice>}
    <Button label={auth.session.account.company ? '기업 프로필 관리' : '기업 프로필 등록'} onPress={onCompany} />
    <Button label="로그아웃" variant="secondary" busy={busy} onPress={() => void run(() => auth.signOut())} />
    {error && <Notice error>{error}</Notice>}
  </Page>

  return <Page>
    <Text style={{ fontSize: 28, fontWeight: '700', color: colors.text }}>{mode === 'login' ? 'GovBiz 로그인' : '계정 만들기'}</Text>
    <Text style={{ color: colors.muted }}>웹에서 사용하던 계정과 관심 공고를 앱에서도 이어서 사용하세요.</Text>
    {process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN === 'true' && <View style={{ gap: 10 }}>
      {supportsNativeOAuth() ? <><Button label="Google로 계속하기" variant="secondary" disabled={busy} onPress={() => void run(() => auth.signInWithOAuth('google'))} /><Button label="카카오로 계속하기" variant="secondary" disabled={busy} onPress={() => void run(() => auth.signInWithOAuth('kakao'))} /></> : <Notice>소셜 로그인은 GovBiz 개발 빌드 또는 설치된 앱에서 사용할 수 있습니다.</Notice>}
    </View>}
    <Field label="이메일" value={email} onChangeText={updateEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" editable={!busy} maxLength={320} />
    {mode === 'signup' && <>
      <Button label={emailPass ? '인증번호 다시 받기' : codeSent ? '인증번호 재전송' : '인증번호 받기'} variant="secondary" onPress={() => void sendCode()} disabled={busy} />
      {codeSent && !emailPass && <><Field label="인증번호" value={code} onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" autoComplete="one-time-code" maxLength={6} editable={!busy} /><Button label="인증번호 확인" onPress={() => void verifyCode()} disabled={busy} /></>}
    </>}
    <Field label="비밀번호" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} maxLength={72} editable={!busy} />
    {mode === 'signup' && <><Field label="비밀번호 확인" value={confirmation} onChangeText={setConfirmation} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" maxLength={72} editable={!busy} /><Text style={{ color: colors.muted }}>비밀번호는 8~72자로 입력하세요. 가입하면 이용약관과 개인정보 처리방침에 동의한 것으로 봅니다.</Text></>}
    {notice && <Notice>{notice}</Notice>}
    {error && <Notice error>{error}</Notice>}
    {auth.restoreError && <Notice error>{auth.restoreError}</Notice>}
    <Button label={mode === 'login' ? '로그인' : '회원가입'} onPress={() => void submit()} busy={busy} disabled={mode === 'signup' && !emailPass} />
    <Button label={mode === 'login' ? '이메일로 회원가입' : '기존 계정으로 로그인'} variant="ghost" disabled={busy} onPress={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); setNotice(null); setPassword(''); setConfirmation(''); setEmailPass(null); setCodeSent(false); setCode('') }} />
    {auth.restoreError && <Button label="기기 로그인 정보 다시 지우기" variant="ghost" onPress={() => void run(() => auth.signOut())} disabled={busy} />}
  </Page>
}
