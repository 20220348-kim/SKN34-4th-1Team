import type { PropsWithChildren } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

export const colors = {
  background: '#F5F6F8', surface: '#FFFFFF', text: '#191F28', muted: '#636E7B',
  secondaryText: '#4E5968', placeholder: '#8B95A1', primary: '#087F46', primaryText: '#06663A',
  border: '#E5E8EB', fieldBorder: '#D1D6DB', divider: '#F2F4F6', track: '#EBEEF1',
  danger: '#D22030', dangerSoft: '#FFEFF0', soft: '#E7F5EE',
  info: '#1F63C6', infoSoft: '#EAF2FD', warning: '#9A4E00', warningSoft: '#FFF4E5',
}

// Navigation owns the header/tab insets. Only headerless pages apply the top inset here.
export function Page({ children, scroll = true, headerless = false, keyboardOffset = 0, refreshing, onRefresh, backgroundColor = colors.background }: PropsWithChildren<{
  scroll?: boolean; headerless?: boolean; keyboardOffset?: number; refreshing?: boolean; onRefresh?: () => void; backgroundColor?: string
}>) {
  const insets = useSafeAreaInsets()
  return <KeyboardAvoidingView style={[styles.page, { backgroundColor, paddingTop: headerless ? insets.top : 0,
    paddingLeft: insets.left, paddingRight: insets.right }]}
    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    keyboardVerticalOffset={keyboardOffset + (headerless ? 0 : insets.top + 56)}>
    {scroll ? <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]}
      refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={colors.primary} /> : undefined}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">{children}</ScrollView>
      : <View style={[styles.content, { flex: 1, paddingBottom: 24 + insets.bottom }]}>{children}</View>}
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

export function StatusBadge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'info' | 'warning' }) {
  const palette = { neutral: [colors.divider, colors.secondaryText], success: [colors.soft, colors.primaryText],
    info: [colors.infoSoft, colors.info], warning: [colors.warningSoft, colors.warning] }[tone]
  return <Text style={[styles.badge, { backgroundColor: palette[0], color: palette[1] }]}>{label}</Text>
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
  input: { borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: 12, backgroundColor: colors.surface,
    paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, color: colors.text, minHeight: 48 },
  button: { borderRadius: 999, backgroundColor: colors.primary, minHeight: 44, paddingHorizontal: 16, paddingVertical: 10,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  buttonText: { color: colors.surface, fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.fieldBorder },
  ghost: { backgroundColor: 'transparent' },
  dangerButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.danger },
  smallButton: { minHeight: 44, paddingVertical: 8 },
  largeButton: { minHeight: 52, paddingVertical: 14 },
  card: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, gap: 9 },
  notice: { backgroundColor: colors.soft, borderRadius: 12, padding: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  badge: { borderRadius: 6, backgroundColor: colors.soft, color: colors.primaryText, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 3, fontSize: 12, fontWeight: '600' },
})
