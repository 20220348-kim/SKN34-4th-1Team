import { useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button, colors, styles } from '../ui'
import { PartnerSheet } from './PartnerSheet'

export function ChoiceField({ label, value, options, onChange, placeholder = '', disabled = false, compact = false, inline = false }: {
  label: string; value: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void
  placeholder?: string; disabled?: boolean; compact?: boolean; inline?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selectedOption = options.find((item) => item.value === value)
  const displayValue = selectedOption?.label ?? (value || placeholder)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  const choices = options.map(item => <Pressable key={item.value} accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ checked: value === item.value, disabled }} disabled={disabled}
    onPress={() => { onChange(item.value); setOpen(false) }} style={[styles.input, value === item.value && { backgroundColor: colors.soft }]}>
    <Text style={styles.body}>{item.label}{value === item.value ? '  ✓' : ''}</Text>
  </Pressable>)
  return <View style={[{ gap: 7 }, inline && { flexDirection: 'row', alignItems: 'center' }]}>
    <Text style={styles.label}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${displayValue}`}
      disabled={disabled} accessibilityState={{ disabled }} onPress={() => setOpen(true)} style={[styles.input, disabled && { opacity: 0.55 }]}>
      <Text style={[styles.body, !selectedOption && !value && { color: colors.placeholder }]}>{displayValue} ▾</Text>
    </Pressable>
    {compact ? <PartnerSheet visible={open} title={label} compact actions={null} onClose={() => setOpen(false)}>{choices}</PartnerSheet>
      : <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          <View style={{ padding: 20, gap: 16 }}><Text style={styles.heading}>{label}</Text><Button label="닫기" variant="secondary" onPress={() => setOpen(false)} /></View>
          <ScrollView bounces={false} overScrollMode="never" contentContainerStyle={{ padding: 20, gap: 8 }}>{choices}</ScrollView>
        </SafeAreaView>
      </Modal>}
  </View>
}
