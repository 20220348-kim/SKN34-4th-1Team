import { useEffect, useRef, useState } from 'react'
import { Text } from 'react-native'
import type { PasswordResetVerification } from '@govbiz/shared/domain/entities/Account'
import { isEmailAddress, normalizeEmail } from '@govbiz/shared/domain/entities/EmailAddress'
import { signUpPasswordIssue } from '@govbiz/shared/domain/usecases/SignUpUseCase'
import { requestPasswordReset, resetPassword, verifyPasswordResetCode } from '../api/account'
import { ApiError } from '../api/client'
import { authErrorMessage } from '../auth/errors'
import { Button, Field, Notice, styles } from '../ui'
import { PartnerSheet } from './PartnerSheet'

export function PasswordResetSheet({ visible, onClose }: { visible: boolean; onClose(): void }) {
  const [stage, setStage] = useState<'email' | 'code' | 'password' | 'done'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [pass, setPass] = useState<PasswordResetVerification | null>(null)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const running = useRef(false)
  useEffect(() => {
    request.current?.abort(); running.current = false
    setStage('email'); setEmail(''); setCode(''); setPass(null); setPassword(''); setConfirmation(''); setBusy(false); setError(null)
    return () => request.current?.abort()
  }, [visible])
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (running.current) return
    running.current = true
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError(null)
    try { await action(controller.signal) } catch (cause) {
      if (!controller.signal.aborted) {
        if (cause instanceof ApiError && cause.status === 404) setError('가입한 이메일을 찾을 수 없어요. 입력한 주소를 확인해 주세요.')
        else if (cause instanceof ApiError && cause.status === 409) setError('소셜 로그인으로 가입한 계정이에요. 가입한 소셜 로그인 방법을 이용해 주세요.')
        else if (cause instanceof ApiError && cause.status === 503) setError('현재 인증 메일을 보낼 수 없어요. 잠시 후 다시 시도해 주세요.')
        else if (cause instanceof ApiError && cause.code === 'PASSWORD_RESET_TOKEN_INVALID') {
          setPass(null); setStage('code'); setError('인증이 만료됐거나 이미 사용됐어요. 인증번호를 다시 받아 주세요.')
        } else setError(authErrorMessage(cause))
      }
    } finally { if (request.current === controller) { running.current = false; if (!controller.signal.aborted) setBusy(false) } }
  }
  function normalizedEmail() {
    const value = normalizeEmail(email)
    if (!isEmailAddress(value)) throw new Error('올바른 이메일 주소를 입력해 주세요.')
    return value
  }
  const send = () => run(async signal => {
    await requestPasswordReset(normalizedEmail(), signal)
    if (signal.aborted) return
    setCode(''); setPass(null); setStage('code')
  })
  const verify = () => run(async signal => {
    if (!/^\d{6}$/.test(code)) throw new Error('메일로 받은 6자리 인증번호를 입력해 주세요.')
    const result = await verifyPasswordResetCode(normalizedEmail(), code, signal)
    if (!signal.aborted) { setPass(result); setStage('password') }
  })
  const save = () => run(async signal => {
    if (!pass || Date.parse(pass.expiresAt) <= Date.now()) { setPass(null); setStage('code'); throw new Error('인증이 만료됐어요. 인증번호를 다시 받아 주세요.') }
    if (signUpPasswordIssue(password)) throw new Error('새 비밀번호는 영문·숫자·특수문자로 8~72자 입력해 주세요.')
    if (password !== confirmation) throw new Error('새 비밀번호 확인이 일치하지 않아요.')
    await resetPassword(pass.passToken, password, signal)
    if (!signal.aborted) { setPassword(''); setConfirmation(''); setPass(null); setStage('done') }
  })
  function close() { if (!running.current) onClose() }
  return <PartnerSheet visible={visible} title="비밀번호 찾기" onClose={close} actions={stage === 'done'
    ? <Button label="로그인으로 돌아가기" style={{ flex: 1 }} onPress={onClose} />
    : <><Button label="취소" variant="secondary" disabled={busy} style={{ flex: 1 }} onPress={close} />
      <Button label={stage === 'email' ? '인증번호 받기' : stage === 'code' ? '인증번호 확인' : '새 비밀번호 저장'}
        busy={busy} disabled={busy} style={{ flex: 2 }} onPress={() => void (stage === 'email' ? send() : stage === 'code' ? verify() : save())} /></>}>
    {stage === 'done' ? <Notice>비밀번호를 변경했어요. 모든 기존 로그인 세션이 종료됐으니 새 비밀번호로 다시 로그인해 주세요.</Notice> : <>
      <Text style={styles.body}>가입한 이메일로 받은 인증번호를 확인한 뒤 새 비밀번호를 설정해요.</Text>
      <Field label="재설정 이메일" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false}
        editable={!busy && stage === 'email'} maxLength={320} />
      {stage === 'code' && <><Field label="재설정 인증번호" value={code} onChangeText={value => setCode(value.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad" autoComplete="one-time-code" maxLength={6} editable={!busy} />
        <Button label="인증번호 다시 받기" variant="ghost" disabled={busy} onPress={() => void send()} />
        <Button label="이메일 변경" variant="ghost" disabled={busy} onPress={() => { setStage('email'); setCode(''); setPass(null); setError(null) }} /></>}
      {stage === 'password' && <><Field label="새 비밀번호" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" maxLength={72} editable={!busy} />
        <Field label="새 비밀번호 확인" value={confirmation} onChangeText={setConfirmation} secureTextEntry autoCapitalize="none" maxLength={72} editable={!busy} /></>}
    </>}
    {error && <Notice error>{error}</Notice>}
  </PartnerSheet>
}
