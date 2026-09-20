import { useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button, colors, styles } from '../ui'

export function ChoiceField({ label, value, options, onChange }: {
  label: string; value: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  return <View style={{ gap: 7 }}>
    <Text style={styles.label}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${options.find((item) => item.value === value)?.label ?? value}`}
      onPress={() => setOpen(true)} style={styles.input}>
      <Text style={styles.body}>{options.find((item) => item.value === value)?.label ?? value} ▾</Text>
    </Pressable>
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={{ padding: 20, gap: 16 }}><Text style={styles.heading}>{label}</Text><Button label="닫기" variant="secondary" onPress={() => setOpen(false)} /></View>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 8 }}>
          {options.map((item) => <Pressable key={item.value} accessibilityRole="radio" accessibilityState={{ checked: value === item.value }}
            onPress={() => { onChange(item.value); setOpen(false) }} style={[styles.input, value === item.value && { backgroundColor: colors.soft }]}>
            <Text style={styles.body}>{item.label}{value === item.value ? '  ✓' : ''}</Text>
          </Pressable>)}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </View>
}
