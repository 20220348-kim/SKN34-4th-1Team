import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { SupportProgramSearchRelaxation } from '@govbiz/shared/domain/entities/SupportProgramSearchRelaxation'
import { colors, styles } from '../ui'

/**
 * 추천 결과가 없을 때의 다시 찾기 도움입니다(웹과 같은 문구). 서버가 센 제외 사유를 그대로 알리고, 조건 빼기는 확인 카드만
 * 만들며 검색은 사용자가 확인한 뒤에 합니다. 버튼의 수는 그 조건 때문에 뺀 공고 수이지 다시 찾은 결과 수가 아닙니다.
 */
export function ZeroResultHelp({ explanation, relaxations, disabled, onRelax, onRephrase }: {
  explanation: string | null
  relaxations: SupportProgramSearchRelaxation[]
  disabled: boolean
  onRelax(relaxation: SupportProgramSearchRelaxation): void
  onRephrase(): void
}) {
  return <View testID="ai-search-zero-result-help" style={local.box}>
    <Text style={styles.body}>조건에 맞는 공고를 찾지 못했어요.</Text>
    {explanation ? <Text style={styles.muted}>{explanation}</Text> : null}
    <View accessibilityLabel="조건을 바꿔 다시 찾기" style={local.actions}>
      {relaxations.map(relaxation => <Chip key={relaxation.kind} disabled={disabled} onPress={() => onRelax(relaxation)}
        label={relaxation.excludedCount === null ? relaxation.label : `${relaxation.label} · 뺀 공고 ${relaxation.excludedCount}건`} />)}
      <Chip label="다른 표현으로 다시 말하기" disabled={disabled} onPress={onRephrase} />
    </View>
    {relaxations.length > 0 && <Text style={styles.muted}>고른 조건은 확인 카드에서 한 번 더 확인한 뒤 검색해요.</Text>}
  </View>
}

function Chip({ label, disabled, onPress }: { label: string; disabled: boolean; onPress(): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [local.chip, (pressed || disabled) && { opacity: disabled ? 0.45 : 0.85 }]}>
    <Text style={local.chipText}>{label}</Text>
  </Pressable>
}

const local = StyleSheet.create({
  box: { gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, justifyContent: 'center', borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.surface },
  chipText: { color: colors.text, fontSize: 14, lineHeight: 20 },
})
