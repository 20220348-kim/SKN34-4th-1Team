import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, styles } from '../ui'

/** 한 필터 시트 안에서 여러 값을 고르는 조건 그룹입니다. */
export function FilterMultiChoices({ label, options, selected, onToggle, onClear }: {
  label: string; options: readonly string[]; selected: readonly string[]
  onToggle(value: string): void; onClear(): void
}) {
  return <View style={local.group}>
    <View style={local.heading}><Text style={styles.heading}>{label}</Text>
      {selected.length > 0 && <Text style={local.count}>{selected.length}개 선택</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel={`${label} 전체`} accessibilityState={{ selected: selected.length === 0 }}
        onPress={onClear} style={local.clear}><Text style={[styles.muted, selected.length === 0 && local.selectedText]}>전체</Text></Pressable>
    </View>
    <View style={local.choices}>{options.map(value => <Pressable key={value} accessibilityRole="checkbox"
      accessibilityLabel={`${label} ${value}`} accessibilityState={{ checked: selected.includes(value) }} onPress={() => onToggle(value)}
      style={[local.choice, selected.includes(value) && local.selected]}>
      <Text style={[local.text, selected.includes(value) && local.selectedText]}>{value}</Text>
    </Pressable>)}</View>
  </View>
}

const local = StyleSheet.create({
  group: { gap: 10, marginBottom: 8 }, heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  count: { fontSize: 12, color: colors.primary }, clear: { marginLeft: 'auto', minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { minHeight: 40, maxWidth: '100%', justifyContent: 'center', paddingHorizontal: 13, paddingVertical: 9,
    borderWidth: 1, borderColor: colors.border, borderRadius: 22, backgroundColor: colors.surface },
  selected: { backgroundColor: colors.soft, borderColor: colors.primary },
  text: { color: colors.muted, fontSize: 14, lineHeight: 21 }, selectedText: { color: colors.primary, fontWeight: '600' },
})
