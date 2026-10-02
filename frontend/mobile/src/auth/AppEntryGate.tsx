import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { WelcomeScreen } from '../screens/WelcomeScreen'
import { Button, Notice, Page, colors, styles } from '../ui'
import { completeIntroduction, readIntroductionCompleted } from './introductionStorage'
import { useLoginFlow } from './loginFlow'
import { useAuth } from './session'

export function AppEntryGate({ children }: { children: ReactNode }) {
  const { status, refreshSession, restoreError } = useAuth()
  const requestLogin = useLoginFlow()
  const [completed, setCompleted] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [publicEntry, setPublicEntry] = useState(false)
  const read = useCallback(async () => {
    setError(null)
    try { setCompleted(await readIntroductionCompleted()) }
    catch { setError('기능 소개 기록을 확인하지 못했습니다. 다시 시도해 주세요.') }
  }, [])
  useEffect(() => { void read() }, [read])
  useEffect(() => {
    if (status !== 'signedIn' || completed !== false) return
    let active = true
    completeIntroduction().then(() => { if (active) setCompleted(true) })
      .catch(() => { if (active) setError('기능 소개 기록을 저장하지 못했습니다. 다시 시도해 주세요.') })
    return () => { active = false }
  }, [status, completed])
  async function enter(action: 'browse' | 'signup' | 'methods' = 'browse') {
    if (busy) return
    if (action === 'signup') { requestLogin({ direct: true, mode: 'signup' }); return }
    if (action === 'methods') { requestLogin({ methods: true }); return }
    setBusy(true); setError(null)
    try {
      await completeIntroduction()
      setCompleted(true)
    } catch { setError('기능 소개 기록을 저장하지 못했습니다. 다시 시도해 주세요.') }
    finally { setBusy(false) }
  }
  if (status === 'signedIn') return children
  if (status === 'loading' || completed === null && !error) return <Page headerless scroll={false} backgroundColor={colors.surface}>
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }}><Text style={[styles.title, { color: colors.primary }]}>G · GovBiz</Text>
      <ActivityIndicator accessibilityLabel="앱 시작 준비 중" color={colors.primary} /></View></Page>
  if (status === 'unavailable' && !publicEntry) return <Page headerless><Notice error>{restoreError ?? '로그인 상태를 확인하지 못했습니다.'}</Notice>
    <Button label="로그인 상태 다시 확인" onPress={() => void refreshSession()} />
    <Button label="공개 공고 둘러보기" variant="secondary" onPress={() => setPublicEntry(true)} /></Page>
  if (completed === null) return <Page headerless><Notice error>{error}</Notice><Button label="다시 확인" onPress={() => void read()} /></Page>
  if (!completed && status === 'signedOut') return <WelcomeScreen busy={busy} error={error} onBrowse={() => void enter()}
    onSignup={() => void enter('signup')} onLogin={() => void enter('methods')} />
  return children
}
