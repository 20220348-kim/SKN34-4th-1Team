import { useContext, type PropsWithChildren } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BottomTabBarHeightContext } from 'expo-router/js-tabs'
import { colors as tokens, radius } from '@govbiz/shared/design/tokens'
import { ddayTone } from '@govbiz/shared/domain/labels'
import { useScrollBoundary } from './components/useScrollBoundary'

/** 화면 코드가 쓰는 색 이름입니다. 값은 웹과 같은 shared 디자인 토큰에서 가져옵니다. */
export const colors = {
  background: tokens.canvas, surface: tokens.surface, text: tokens.ink, muted: tokens.inkMuted,
  secondaryText: tokens.inkMuted, placeholder: tokens.inkSubtle, primary: tokens.brandPrimary, primaryText: tokens.brandHover,
  border: tokens.line, fieldBorder: tokens.lineStrong, divider: tokens.surfaceMuted, track: tokens.track,
  danger: tokens.danger, dangerSoft: tokens.dangerSoft, soft: tokens.brandSoft,
  info: tokens.info, infoSoft: tokens.infoSoft, warning: tokens.warning, warningSoft: tokens.warningSoft,
}

// Tabs own the bottom inset; a root page or its fixed footer owns it otherwise.
export function Page({ children, scroll = true, headerless = false, bottomSafeArea = true, keyboardOffset = 0, refreshing, onRefresh, backgroundColor = colors.background }: PropsWithChildren<{
  scroll?: boolean; headerless?: boolean; bottomSafeArea?: boolean; keyboardOffset?: number; refreshing?: boolean; onRefresh?: () => void; backgroundColor?: string
}>) {
  const insets = useSafeAreaInsets()
  const tabBarHeight = useContext(BottomTabBarHeightContext)
  const paddingBottom = bottomSafeArea && tabBarHeight === undefined ? insets.bottom : 0
  const scrollBoundary = useScrollBoundary(Boolean(onRefresh))
  return <KeyboardAvoidingView style={[styles.page, { backgroundColor, paddingTop: headerless ? insets.top : 0,
    paddingLeft: insets.left, paddingRight: insets.right }]}
    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    keyboardVerticalOffset={keyboardOffset + (headerless ? 0 : insets.top + 56)}>
    {scroll ? <ScrollView {...scrollBoundary} contentContainerStyle={[styles.content, { paddingBottom }]}
      refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={colors.primary} /> : undefined}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">{children}</ScrollView>
      : <View style={[styles.content, { flex: 1, paddingBottom }]}>{children}</View>}
  </KeyboardAvoidingView>
}

export function Button({ label, onPress, disabled, variant = 'primary', busy, size = 'medium', accessibilityLabel, style }: {
  label: string; onPress: () => void; disabled?: boolean; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean
  size?: 'small' | 'medium' | 'large'
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
    disabled={disabled || busy} onPress={onPress}
    style={({ pressed }) => [styles.button, variant === 'secondary' && styles.secondary,
      variant === 'ghost' && styles.ghost, variant === 'danger' && styles.dangerButton,
      size === 'small' && styles.smallButton, size === 'large' && styles.largeButton,
      (disabled || busy || pressed) && { opacity: 0.55 }, style]}>
    {busy && <ActivityIndicator color={variant === 'primary' ? colors.surface : colors.primary} />}
    <Text style={[styles.buttonText, variant === 'secondary' && { color: colors.text },
      variant === 'ghost' && { color: colors.secondaryText }, variant === 'danger' && { color: colors.danger },
      size === 'small' && { fontSize: 14 }, size === 'large' && { fontSize: 16 }]}>{label}</Text>
  </Pressable>
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <View style={{ gap: 7 }}><Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} placeholderTextColor={colors.placeholder} {...props} style={[styles.input, props.style]} />
  </View>
}

export function Notice({ children, error = false }: PropsWithChildren<{ error?: boolean }>) {
  return <View accessibilityLiveRegion="polite" style={[styles.notice, error && { backgroundColor: colors.dangerSoft }]}>
    <Text style={[styles.body, error && { color: colors.danger }]}>{children}</Text>
  </View>
}

export function Card({ children }: PropsWithChildren) { return <View style={styles.card}>{children}</View> }
export function Title({ children }: PropsWithChildren) { return <Text style={styles.title}>{children}</Text> }
export function Subtitle({ children }: PropsWithChildren) { return <Text style={styles.subtitle}>{children}</Text> }

export type BadgeTone = 'neutral' | 'success' | 'info' | 'warning' | 'danger'

/** 배지 색(바탕 · 글자)입니다. StatusBadge와 직접 그린 D-day 글자가 같은 색을 씁니다. */
export function badgeColors(tone: BadgeTone) {
  const [backgroundColor, color] = { neutral: [colors.divider, colors.secondaryText], success: [colors.soft, colors.primaryText],
    info: [colors.infoSoft, colors.info], warning: [colors.warningSoft, colors.warning], danger: [colors.dangerSoft, colors.danger] }[tone]
  return { backgroundColor, color }
}

/** shared `ddayTone` 단계를 배지 색으로 바꿉니다. 마감 7일 이내 빨강 · 30일 이내 노랑 · 그 뒤 초록 · 지남 회색(웹과 같은 규칙)입니다. */
export function ddayBadgeTone(daysLeft: number): BadgeTone {
  return ({ urgent: 'danger', soon: 'warning', later: 'success', closed: 'neutral' } as const)[ddayTone(daysLeft)]
}

export function StatusBadge({ label, tone = 'neutral' }: { label: string; tone?: BadgeTone }) {
  return <Text style={[styles.badge, badgeColors(tone)]}>{label}</Text>
}

export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 12, width: '100%', maxWidth: 720, alignSelf: 'center' },
  title: { color: colors.text, fontSize: 22, lineHeight: 31, fontWeight: '700' },
  subtitle: { color: colors.secondaryText, fontSize: 15, lineHeight: 24 },
  heading: { color: colors.text, fontSize: 17, lineHeight: 24, fontWeight: '600' },
  body: { color: colors.text, fontSize: 15, lineHeight: 24 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  label: { color: colors.text, fontSize: 14, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radius.xl, backgroundColor: colors.surface,
    paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, color: colors.text, minHeight: 48 },
  button: { borderRadius: radius.full, backgroundColor: colors.primary, minHeight: 44, paddingHorizontal: 16, paddingVertical: 10,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  buttonText: { color: colors.surface, fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.fieldBorder },
  ghost: { backgroundColor: 'transparent' },
  dangerButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.danger },
  smallButton: { minHeight: 44, paddingVertical: 8 },
  largeButton: { minHeight: 52, paddingVertical: 14 },
  card: { backgroundColor: colors.surface, borderRadius: radius['2xl'], padding: 16, gap: 9 },
  notice: { backgroundColor: colors.soft, borderRadius: radius.xl, padding: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  badge: { borderRadius: radius.md, backgroundColor: colors.soft, color: colors.primaryText, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 3, fontSize: 12, fontWeight: '600' },
})
