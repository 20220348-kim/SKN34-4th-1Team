import { StyleSheet, Text, View } from 'react-native'
import type { SupportProgramConversationContext } from '@govbiz/shared/domain/entities/SupportProgramConversation'
import { Button, colors } from '../ui'

const labels = { region: '지역', industry: '업종', establishedOn: '설립일', foundedYear: '설립연도', supportPurpose: '지원 목적' }

/** The same condition proposal surface appears in search and its introduction preview. */
export function SearchConditionCard({ context, onConfirm, onEdit, busy, disabled }: {
  context: SupportProgramConversationContext; onConfirm?(): void; onEdit?(): void; busy?: boolean; disabled?: boolean
}) {
  return <View style={local.card}>
    <Text style={local.title}>이 조건으로 검색할까요?</Text>
    {onConfirm && context.query && <Text style={local.query}>검색어 · {context.query}</Text>}
    <View style={local.chips}>
      <View style={local.chip}><Text style={local.label}>접수</Text><Text style={local.value}>{context.acceptingOnly ? '접수 중' : '전체'}</Text></View>
      {Object.entries(context.companyConditions).filter(([, value]) => value != null && value !== '').map(([key, value]) =>
        <View key={key} style={local.chip}><Text style={local.label}>{labels[key as keyof typeof labels]}</Text><Text style={local.value}>{value}</Text></View>)}
    </View>
    {onConfirm ? <View style={local.actions}>
      {onEdit && <View style={{ flex: 1 }}><Button label="조건 바꾸기" variant="secondary" disabled={busy} onPress={onEdit} /></View>}
      <View style={{ flex: 1.4 }}><Button label="이 조건으로 검색" busy={busy} disabled={disabled} onPress={onConfirm} /></View>
    </View> : <View style={local.exampleButton}><Text style={local.exampleButtonText}>이 조건으로 검색</Text></View>}
  </View>
}

const local = StyleSheet.create({
  card: { padding: 16, borderRadius: 20, borderWidth: 1, borderColor: '#CFE8DA', backgroundColor: colors.surface, gap: 14 },
  title: { color: colors.text, fontSize: 17, fontWeight: '600', lineHeight: 24 },
  query: { color: colors.secondaryText, fontSize: 14, lineHeight: 22 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, backgroundColor: colors.background, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  label: { fontSize: 13, lineHeight: 20, color: colors.muted }, value: { fontSize: 14, lineHeight: 20, color: colors.text },
  actions: { flexDirection: 'row', gap: 8 },
  exampleButton: { minHeight: 40, backgroundColor: colors.primary, borderRadius: 999, alignItems: 'center', justifyContent: 'center', padding: 8 },
  exampleButtonText: { color: colors.surface, fontSize: 14, fontWeight: '600' },
})
