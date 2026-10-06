import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { SupportProgram } from '@govbiz/shared/domain/entities/SupportProgram'
import { programStatusLabels } from '@govbiz/shared/domain/labels'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { Button, Card, StatusBadge, colors, styles } from '../ui'

export type ProgramSelectionLabels = { selected: string; select: string }
export function ProgramCard({ program, onOpen, selection }: { program: SupportProgram; onOpen: (identity: SupportProgramIdentity) => void
  selection?: { selected: boolean; disabled: boolean; onToggle(): void; labels?: ProgramSelectionLabels }
}) {
  const open = () => onOpen({ sourceCode: program.sourceCode, sourceProgramId: program.id })
  const body = <>
      <View style={styles.row}><StatusBadge label={programStatusLabels[program.status]}
        tone={program.status === 'OPEN' ? 'success' : program.status === 'UPCOMING' ? 'info' : 'neutral'} /><Text style={styles.muted}>{program.sourceName}</Text></View>
      <Text style={styles.heading}>{program.title}</Text>
      <Text style={styles.muted}>{program.organization}</Text>
      <Text style={styles.body} numberOfLines={2}>{program.summary}</Text>
      <Text style={styles.muted}>{program.applicationPeriod}</Text>
      {program.regions.length > 0 && <Text style={styles.muted}>{program.regions.join(' · ')}</Text>}
      {program.matchedReasons.map((reason) => <Text key={reason} style={styles.muted}>• {reason}</Text>)}
      <Text style={[styles.label, { textAlign: 'right' }]}>공고 상세 →</Text>
    </>
  if (!selection) return <Pressable accessibilityRole="button" accessibilityLabel={`${program.title}, 상세 보기`} onPress={open}><Card>{body}</Card></Pressable>
  return <View testID={`review-program-${program.sourceCode}-${program.id}`} style={[styles.card, local.selectable, selection.selected && local.selected]}>
    {selection.selected && <Text style={local.selectedLabel}>{selection.labels?.selected ?? '✓ 비교 대상 선택됨'}</Text>}
    <Pressable accessibilityRole="button" accessibilityLabel={`${program.title}, 상세 보기`} onPress={open} style={{ gap: 9 }}>{body}</Pressable>
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 }}>
      <Button label={selection.selected ? '✓ 선택됨 · 해제' : selection.labels?.select ?? '비교할 공고로 선택'} accessibilityLabel={`${program.title} ${selection.selected ? '선택 해제' : '선택'}`} variant={selection.selected ? 'primary' : 'secondary'}
        disabled={selection.disabled} onPress={selection.onToggle} />
    </View>
  </View>
}

const local = StyleSheet.create({
  selectable: { borderWidth: 1, borderColor: 'transparent' },
  selected: { backgroundColor: colors.soft, borderColor: colors.primary },
  selectedLabel: { color: colors.primaryText, fontSize: 13, fontWeight: '600' },
})
