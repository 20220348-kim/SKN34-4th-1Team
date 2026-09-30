import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors } from '../ui'

export function SegmentedControl<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly { value: T; label: string }[]; onChange(value: T): void
}) {
  return <View accessibilityRole="tablist" accessibilityLabel={label} style={local.track}>
    {options.map((option) => <Pressable key={option.value} accessibilityRole="tab" accessibilityLabel={option.label}
      accessibilityState={{ selected: option.value === value }} onPress={() => onChange(option.value)}
      style={({ pressed }) => [local.segment, value === option.value && local.selected, pressed && { opacity: 0.7 }]}>
      <Text style={[local.label, value === option.value && local.selectedLabel]}>{option.label}</Text>
    </Pressable>)}
  </View>
}

const local = StyleSheet.create({
  track: { flexDirection: 'row', padding: 4, backgroundColor: colors.track, borderRadius: 999 },
  segment: { flex: 1, minHeight: 36, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999 },
  selected: { backgroundColor: colors.surface },
  label: { color: colors.secondaryText, fontSize: 15, lineHeight: 20, fontWeight: '500', textAlign: 'center' },
  selectedLabel: { color: colors.text, fontWeight: '600' },
})
