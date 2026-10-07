import { useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button, colors, styles } from '../ui'

/** 여러 값을 골라도 선택 화면을 닫지 않는 네이티브 조건 선택입니다. */
export function MultiSelectField({ label, selected, options, onToggle, onClear }: {
  label: string; selected: readonly string[]; options: readonly string[]; onToggle(value: string): void; onClear(): void
}) {
  const [open, setOpen] = useState(false)
  return <View style={{ flex: 1, gap: 6 }}><Text style={styles.label}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} 선택: ${selected.length ? `${selected.length}개` : '전체'}`}
      onPress={() => setOpen(true)} style={styles.input}><Text style={styles.body}>{selected.length ? `${selected.length}개 선택` : '전체'} ▾</Text></Pressable>
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={{ padding: 20, gap: 12 }}><Text style={styles.heading}>{label} · 여러 개 선택</Text>
          <Text style={styles.muted}>선택하지 않으면 전체 공고를 표시합니다.</Text>
          <View style={styles.row}><Button label={`${label} 선택 해제`} variant="secondary" onPress={onClear} />
            <Button label="선택 완료" onPress={() => setOpen(false)} /></View></View>
        <ScrollView bounces={false} overScrollMode="never" contentContainerStyle={{ padding: 20, gap: 8 }}>{options.map(value => <Pressable key={value}
          accessibilityRole="checkbox" accessibilityLabel={`${label} ${value}`} accessibilityState={{ checked: selected.includes(value) }}
          onPress={() => onToggle(value)} style={[styles.input, selected.includes(value) && { backgroundColor: colors.soft }]}>
          <Text style={styles.body}>{selected.includes(value) ? '☑ ' : '☐ '}{value}</Text></Pressable>)}</ScrollView>
      </SafeAreaView>
    </Modal>
  </View>
}
