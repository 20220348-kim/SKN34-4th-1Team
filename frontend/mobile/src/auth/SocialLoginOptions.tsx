import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import type { OAuthProviderId } from '@govbiz/shared/domain/entities/OAuthProvider'
import { readOAuthProviders } from '../api/account'
import { Button, Notice } from '../ui'
import { supportsNativeOAuth } from './oauth'

/** The methods sheet and email form expose the same server-confirmed native OAuth actions. */
export function SocialLoginOptions({ enabled, busy, onSelect }: {
  enabled: boolean; busy: boolean; onSelect(provider: OAuthProviderId): void
}) {
  const available = enabled && process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN === 'true' && supportsNativeOAuth()
  const [providers, setProviders] = useState<OAuthProviderId[]>([])
  const [loading, setLoading] = useState(available)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setProviders([]); setError(null); setLoading(available)
    if (available) void readOAuthProviders(controller.signal)
      .then(value => { if (!controller.signal.aborted) setProviders(value) })
      .catch(() => { if (!controller.signal.aborted) setError('소셜 로그인 방법을 확인하지 못했어요. 이메일 로그인은 이용할 수 있어요.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [available, revision])

  if (!available || (!loading && !error && providers.length === 0)) return null
  return <View style={styles.options}>
    {loading && <ActivityIndicator accessibilityLabel="소셜 로그인 방법 확인 중" />}
    {(['kakao', 'google'] as const).filter(provider => providers.includes(provider)).map(provider => {
      const label = provider === 'kakao' ? '카카오로 계속하기' : 'Google로 계속하기'
      return <Pressable key={provider} accessibilityRole="button" accessibilityLabel={label}
        accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={() => onSelect(provider)}
        style={({ pressed }) => [styles.button, provider === 'kakao' ? styles.kakao : styles.google,
          busy ? { opacity: 0.55 } : pressed && { opacity: 0.9 }]}>
        <View style={styles.icon} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {provider === 'kakao' ? <KakaoSymbol /> : <GoogleLogo />}
        </View>
        <Text style={[styles.label, provider === 'kakao' ? styles.kakaoLabel : styles.googleLabel]}>{label}</Text>
      </Pressable>
    })}
    {error && <><Notice error>{error}</Notice><Button label="소셜 로그인 방법 다시 확인" variant="ghost" disabled={busy}
      onPress={() => setRevision(value => value + 1)} /></>}
  </View>
}

// These vector paths are the same provider symbols used by the web OAuth buttons.
function KakaoSymbol() {
  return <Svg width={24} height={24} viewBox="0 0 24 24">
    <Path fill="#000000" d="M12 3C6.48 3 2 6.48 2 10.8c0 2.78 1.86 5.22 4.66 6.6l-.95 3.48c-.08.3.26.54.52.37l4.15-2.74c.53.06 1.07.09 1.62.09 5.52 0 10-3.48 10-7.8S17.52 3 12 3z" />
  </Svg>
}

function GoogleLogo() {
  return <Svg width={24} height={24} viewBox="0 0 48 48">
    <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </Svg>
}

const styles = StyleSheet.create({
  options: { gap: 10 },
  button: { minHeight: 56, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 52,
    alignItems: 'center', justifyContent: 'center' },
  kakao: { backgroundColor: '#FEE500' },
  google: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#747775' },
  icon: { position: 'absolute', left: 20, width: 24, height: 24 },
  label: { fontSize: 16, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  kakaoLabel: { color: '#000000D9' }, googleLabel: { color: '#1F1F1F' },
})
