import type { PropsWithChildren, ReactNode } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors } from '../ui'

/** The approved proposal screens share one native modal sheet and a fixed action area. */
export function PartnerSheet({ visible, title, onClose, children, actions }: PropsWithChildren<{
  visible: boolean; title: string; onClose(): void; actions: ReactNode
}>) {
  const insets = useSafeAreaInsets()
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={local.overlay}>
      <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="시트 닫기" onPress={onClose} />
      <View accessibilityViewIsModal style={[local.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={local.grab} />
        <View style={local.header}><Text style={local.title}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="닫기" onPress={onClose} style={local.close}>
            <Text style={local.closeText}>×</Text></Pressable></View>
        <ScrollView contentContainerStyle={local.content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        <View style={local.actions}>{actions}</View>
      </View>
    </KeyboardAvoidingView>
  </Modal>
}

const local = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(25,31,40,0.45)' },
  sheet: { maxHeight: '86%', minHeight: '60%', borderTopLeftRadius: 22, borderTopRightRadius: 22, backgroundColor: colors.surface },
  grab: { width: 40, height: 5, borderRadius: 99, backgroundColor: colors.fieldBorder, alignSelf: 'center', marginTop: 10 },
  header: { minHeight: 56, paddingLeft: 20, paddingRight: 8, flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1, color: colors.text, fontSize: 18, fontWeight: '700' },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 28, color: colors.secondaryText },
  content: { paddingHorizontal: 20, paddingBottom: 16, gap: 12 },
  actions: { paddingHorizontal: 20, paddingTop: 10, flexDirection: 'row', gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
})
