import type { PropsWithChildren } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native'

export const colors = {
  background: '#F4F7F5', surface: '#FFFFFF', text: '#162B28', muted: '#5D6F69',
  primary: '#176B53', border: '#DDE7E1', danger: '#AD3131', soft: '#E5F2EA',
}

export function Page({ children, scroll = true }: PropsWithChildren<{ scroll?: boolean }>) {
  return <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    {scroll ? <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      : <View style={[styles.content, { flex: 1 }]}>{children}</View>}
  </KeyboardAvoidingView>
}

export function Button({ label, onPress, disabled, variant = 'primary', busy }: {
  label: string; onPress: () => void; disabled?: boolean; variant?: 'primary' | 'secondary' | 'ghost'; busy?: boolean
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || busy, busy }}
    disabled={disabled || busy} onPress={onPress}
    style={({ pressed }) => [styles.button, variant === 'secondary' && styles.secondary,
      variant === 'ghost' && styles.ghost, (disabled || busy || pressed) && { opacity: 0.55 }]}>
    {busy && <ActivityIndicator color={variant === 'primary' ? colors.surface : colors.primary} />}
    <Text style={[styles.buttonText, variant !== 'primary' && { color: colors.primary }]}>{label}</Text>
  </Pressable>
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <View style={{ gap: 7 }}><Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} placeholderTextColor={colors.muted} {...props} style={[styles.input, props.style]} />
  </View>
}

export function Notice({ children, error = false }: PropsWithChildren<{ error?: boolean }>) {
  return <View accessibilityLiveRegion="polite" style={[styles.notice, error && { backgroundColor: '#FDEEEE' }]}>
    <Text style={[styles.body, error && { color: colors.danger }]}>{children}</Text>
  </View>
}

export function Card({ children }: PropsWithChildren) { return <View style={styles.card}>{children}</View> }
export function Title({ children }: PropsWithChildren) { return <Text style={styles.title}>{children}</Text> }
export function Subtitle({ children }: PropsWithChildren) { return <Text style={styles.subtitle}>{children}</Text> }

export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, paddingBottom: 36, gap: 18, width: '100%', maxWidth: 720, alignSelf: 'center' },
  title: { color: colors.text, fontSize: 28, lineHeight: 37, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 15, lineHeight: 23 },
  heading: { color: colors.text, fontSize: 19, lineHeight: 27, fontWeight: '700' },
  body: { color: colors.text, fontSize: 15, lineHeight: 24 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  label: { color: colors.text, fontSize: 14, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface,
    paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, color: colors.text, minHeight: 48 },
  button: { borderRadius: 12, backgroundColor: colors.primary, minHeight: 48, paddingHorizontal: 16, paddingVertical: 12,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  buttonText: { color: colors.surface, fontSize: 15, fontWeight: '600' },
  secondary: { backgroundColor: colors.soft, borderWidth: 1, borderColor: colors.border },
  ghost: { backgroundColor: 'transparent' },
  card: { backgroundColor: colors.surface, borderRadius: 18, borderWidth: 1, borderColor: colors.border, padding: 18, gap: 12 },
  notice: { backgroundColor: colors.soft, borderRadius: 12, padding: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  badge: { borderRadius: 6, backgroundColor: colors.soft, color: colors.primary, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 4, fontSize: 12, fontWeight: '600' },
})
