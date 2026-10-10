import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AccountScreen } from '../screens/AccountScreen'
import { Button, colors } from '../ui'
import { useAuth, type MobileSession } from './session'

export type LoginRequest = {
  message?: string
  direct?: boolean
  methods?: boolean
  mode?: 'login' | 'signup'
  onAuthenticated?(session: MobileSession): void
  onCancel?(): void
}
const LoginContext = createContext<((request?: LoginRequest) => void) | null>(null)

/** Login stays over the originating screen; only its explicitly selected action resumes. */
export function LoginFlowProvider({ children }: { children: ReactNode }) {
  const { status, session } = useAuth()
  const [pending, setPending] = useState<LoginRequest | null>(null)
  const [stage, setStage] = useState<'prompt' | 'methods' | 'login' | 'signup'>('prompt')
  const [busy, setBusy] = useState(false)
  const pendingRef = useRef<LoginRequest | null>(null)
  const insets = useSafeAreaInsets()
  const requestLogin = useCallback((request: LoginRequest = {}) => {
    if (status === 'signedIn' && session) { request.onAuthenticated?.(session); return }
    if (status !== 'signedOut') return
    pendingRef.current?.onCancel?.()
    pendingRef.current = request
    setPending(request); setBusy(false)
    setStage(request.methods ? 'methods' : request.direct ? request.mode ?? 'login' : 'prompt')
  }, [status, session])
  function cancel() {
    if (busy) return
    const request = pendingRef.current
    pendingRef.current = null; setPending(null)
    request?.onCancel?.()
  }
  useEffect(() => {
    if (status !== 'signedIn' || !session || !pendingRef.current) return
    const request = pendingRef.current
    pendingRef.current = null; setPending(null); setBusy(false)
    request.onAuthenticated?.(session)
  }, [status, session])
  useEffect(() => () => { pendingRef.current?.onCancel?.(); pendingRef.current = null }, [])
  return <LoginContext.Provider value={requestLogin}>
    <View style={{ flex: 1 }} accessibilityElementsHidden={pending !== null}
      importantForAccessibility={pending ? 'no-hide-descendants' : 'auto'}>{children}</View>
    <Modal visible={pending !== null} transparent={stage === 'prompt' || stage === 'methods'} animationType="none" onRequestClose={cancel}>
      {stage === 'methods' ? <View style={local.overlay}><View accessibilityViewIsModal style={[local.methodsSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={local.grab} /><View style={local.methodsHeader}>
          <Text accessibilityRole="header" style={local.methodsTitle}>로그인 방법</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="로그인 방법 닫기" onPress={cancel} style={local.close}>
            <Text style={local.closeIcon}>×</Text></Pressable>
        </View>
        <ScrollView bounces={false} overScrollMode="never" style={{ flexShrink: 1 }} contentContainerStyle={local.methodsContent} keyboardShouldPersistTaps="handled">
        <Text style={local.methodsDescription}>로그인하면 보던 화면에서 이어서 이용할 수 있어요.</Text>
        <Button label="이메일로 로그인" variant="secondary" onPress={() => setStage('login')} />
        <View style={local.signupRow}><Text style={local.methodsDescription}>처음이신가요?</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="회원가입하러가기" onPress={() => setStage('signup')} style={local.signupLink}>
            <Text style={local.signupText}>회원가입하러가기</Text></Pressable></View>
        </ScrollView>
      </View></View> : stage === 'prompt' ? <View style={local.overlay}><View accessibilityViewIsModal style={[local.prompt, { paddingBottom: Math.max(insets.bottom, 24) }]}>
        <Text accessibilityRole="header" style={local.title}>로그인이 필요해요</Text>
        <Text style={local.description}>{pending?.message ?? '로그인하면 보던 화면에서 이어서 이용할 수 있어요.'}</Text>
        <Button label="로그인" onPress={() => setStage('login')} />
        <Button label="회원가입" variant="secondary" onPress={() => setStage('signup')} />
        <Button label="계속 둘러보기" variant="ghost" onPress={cancel} />
      </View></View> : <View accessibilityViewIsModal style={{ flex: 1, backgroundColor: colors.surface, paddingTop: insets.top }}>
        <View style={local.header}><Text accessibilityRole="header" style={local.title}>{stage === 'signup' ? '회원가입' : '로그인'}</Text>
          <Button label="취소" accessibilityLabel="로그인 취소" variant="ghost" disabled={busy} onPress={cancel} /></View>
        <AccountScreen key={stage} initialMode={stage === 'signup' ? 'signup' : 'login'} authOnly onBusyChange={setBusy}
          showSocialOptions
          onCompany={() => undefined} />
      </View>}
    </Modal>
  </LoginContext.Provider>
}

export function useLoginFlow() {
  const value = useContext(LoginContext)
  if (!value) throw new Error('useLoginFlow must be used inside LoginFlowProvider')
  return value
}

const local = StyleSheet.create({
  methodsSheet: { maxHeight: '80%', backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 20, paddingTop: 10, gap: 4 },
  methodsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  methodsTitle: { color: colors.text, fontSize: 18, fontWeight: '700', lineHeight: 26 },
  methodsDescription: { color: colors.secondaryText, fontSize: 13, lineHeight: 21 },
  methodsContent: { gap: 10 }, close: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  closeIcon: { color: colors.muted, fontSize: 26, lineHeight: 32 },
  signupRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 6 },
  signupLink: { minHeight: 48, justifyContent: 'center' }, signupText: { color: colors.primaryText, fontSize: 14, fontWeight: '600' },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 99, backgroundColor: colors.fieldBorder },
  // 본문 글자색(colors.text)을 45% 불투명도(#…73)로 덮습니다.
  overlay: { flex: 1, backgroundColor: `${colors.text}73`, justifyContent: 'flex-end' },
  prompt: { backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, gap: 14 },
  title: { color: colors.text, fontSize: 22, lineHeight: 31, fontWeight: '700' },
  description: { color: colors.secondaryText, fontSize: 15, lineHeight: 24 },
  header: { minHeight: 56, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
})
