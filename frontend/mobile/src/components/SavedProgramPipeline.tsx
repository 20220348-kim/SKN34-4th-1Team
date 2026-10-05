import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { SavedSupportProgram } from '@govbiz/shared/domain/entities/SavedSupportProgram'
import type { ApplicationPreparationSummary, ApplicationProgressStage } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { Button, colors, styles } from '../ui'
import { AppIcon, type AppIconName } from './AppIcon'
import { preparationKey, preparationStageLabels } from './PreparationRows'

type StepId = 'interest' | 'preparing' | 'applied' | 'review' | 'result'
const steps: {
  id: StepId; label: string; icon: AppIconName; color: string; soft: string
  stages: ApplicationProgressStage[]; description: string; empty: string
}[] = [
  { id: 'interest', label: '관심', icon: 'bookmark', color: colors.secondaryText, soft: '#EEF0F3', stages: [],
    description: '관심 있는 공고를 살펴보고 신청 문서 작성을 시작해 보세요.', empty: '아직 신청 준비를 시작하지 않은 관심 공고가 없어요.' },
  { id: 'preparing', label: '준비 중', icon: 'document', color: colors.info, soft: colors.infoSoft, stages: ['PREPARING'],
    description: '신청 문서를 준비하고 있는 사업이에요.', empty: '준비 중인 신청 문서가 없어요.' },
  { id: 'applied', label: '지원 완료', icon: 'send', color: colors.primaryText, soft: colors.soft, stages: ['APPLIED'],
    description: '지원을 마친 사업의 심사 진행을 관리해 보세요.', empty: '지원 완료로 표시한 신청 문서가 없어요.' },
  { id: 'review', label: '심사 중', icon: 'search', color: '#7040AC', soft: '#F3EDFC', stages: ['DOCUMENT_REVIEW', 'PRESENTATION_REVIEW'],
    description: '서류·발표 심사 단계를 구분해 확인할 수 있어요.', empty: '심사 중인 신청 문서가 없어요.' },
  { id: 'result', label: '결과', icon: 'report', color: colors.warning, soft: colors.warningSoft, stages: ['SELECTED', 'REJECTED'],
    description: '신청 문서별 선정·미선정 결과를 확인해 보세요.', empty: '아직 결과를 기록한 신청 문서가 없어요.' },
]

/** 단계 현황에서 선택한 공고·문서만 보여 주며, 진행 변경은 기존 문서별 revision을 사용합니다. */
export function SavedProgramPipeline({ items, preparations, busy, onOpenProgram, onOpenStage, onNewDocument }: {
  items: readonly SavedSupportProgram[]; preparations: readonly ApplicationPreparationSummary[]; busy: boolean
  onOpenProgram(identity: SupportProgramIdentity): void; onOpenStage(identity: SupportProgramIdentity, preparationId?: number): void
  onNewDocument(identity: SupportProgramIdentity): void
}) {
  const savedKeys = new Set(items.map(({ program }) => preparationKey({ sourceCode: program.sourceCode, sourceProgramId: program.id })))
  const kept = preparations.filter(item => savedKeys.has(preparationKey(item)))
  const preparedKeys = new Set(kept.map(preparationKey))
  const interest = items.filter(({ program }) => !preparedKeys.has(preparationKey({ sourceCode: program.sourceCode, sourceProgramId: program.id })))
  const overview = steps.map(step => {
    const entries = kept.filter(item => step.stages.includes(item.progressStage))
    return { ...step, entries, count: step.id === 'interest' ? interest.length : entries.length }
  })
  const [selectedId, setSelectedId] = useState<StepId>(() => overview.find(step => step.count > 0)?.id ?? 'interest')
  const selected = overview.find(step => step.id === selectedId)!

  return <View style={local.root}>
    <View style={local.overview}>
      <Text accessibilityRole="header" style={styles.heading}>단계별 현황</Text>
      <Text style={styles.muted}>단계를 눌러 해당 공고와 문서를 확인하세요.</Text>
      <View style={local.steps}>
        {overview.map(step => { const active = step.id === selectedId; return <Pressable key={step.id}
          accessibilityRole="tab" accessibilityLabel={`${step.label} ${step.count}건`} accessibilityState={{ selected: active }}
          onPress={() => setSelectedId(step.id)} style={({ pressed }) => [local.step,
            { backgroundColor: active ? step.color : colors.surface, borderColor: active ? step.color : colors.border }, pressed && { opacity: 0.7 }]}>
          <View style={[local.icon, { backgroundColor: step.soft }]}><AppIcon name={step.icon} color={step.color} size={18} /></View>
          <Text style={[local.stepLabel, active && { color: colors.surface }]}>{step.label}</Text>
          <Text style={[local.stepCount, { color: active ? colors.surface : step.color }]}>{step.count}<Text style={local.countUnit}>건</Text></Text>
        </Pressable> })}
      </View>
      <Text style={local.caption}>관심은 공고 수, 나머지 단계는 신청 문서 수예요.</Text>
    </View>

    <View style={local.group} accessibilityLabel={`${selected.label} 단계`}>
      <View style={local.groupHeading}>
        <View style={[local.marker, { backgroundColor: selected.color }]} />
        <Text accessibilityRole="header" style={styles.heading}>{selected.label} {selected.id === 'interest' ? '공고' : '신청 문서'}</Text>
        <Text style={[local.total, { backgroundColor: selected.soft, color: selected.color }]}>{selected.count}건</Text>
      </View>
      <Text style={styles.muted}>{selected.description}</Text>
      {selected.count === 0 && <View style={local.empty}>
        <View style={[local.emptyIcon, { backgroundColor: selected.soft }]}><AppIcon name={selected.icon} color={selected.color} size={28} /></View>
        <Text style={local.emptyTitle}>{selected.empty}</Text>
        <Text style={styles.muted}>다른 단계도 확인해 보세요.</Text>
      </View>}
      {selected.id === 'interest' ? interest.map(({ program }) => {
        const identity = { sourceCode: program.sourceCode, sourceProgramId: program.id }
        return <View key={preparationKey(identity)} style={[local.card, { borderTopColor: selected.color }]}>
          <View style={local.cardMeta}>
            <Text style={[local.badge, { backgroundColor: selected.soft, color: selected.color }]}>관심</Text>
            <Text style={[styles.muted, local.organization]}>{program.organization}</Text>
          </View>
          <Text style={local.programTitle}>{program.title}</Text>
          <Text style={styles.muted}>신청 문서를 만들면 진행 단계를 관리할 수 있어요.</Text>
          <View style={local.actions}>
            <Button label="신청 문서 작성" accessibilityLabel={`${program.title} 신청 문서 작성`} size="small" style={local.action}
              onPress={() => onNewDocument(identity)} />
            <Button label="공고 상세" accessibilityLabel={`${program.title} 상세 보기`} size="small" variant="secondary" style={local.action}
              onPress={() => onOpenProgram(identity)} />
          </View>
        </View>
      }) : selected.entries.map(item => {
        const identity = { sourceCode: item.sourceCode, sourceProgramId: item.sourceProgramId }
        const badge = item.progressStage === 'SELECTED' ? { color: colors.primaryText, soft: colors.soft }
          : item.progressStage === 'REJECTED' ? { color: colors.danger, soft: colors.dangerSoft } : selected
        return <View key={item.id} style={[local.card, { borderTopColor: selected.color }]}>
          <View style={local.cardMeta}>
            <Text style={[local.badge, { backgroundColor: badge.soft, color: badge.color }]}>{preparationStageLabels[item.progressStage]}</Text>
            <Text style={styles.muted}>신청 문서</Text>
          </View>
          <Text style={local.programTitle}>{item.programTitle}</Text>
          <View style={[local.document, { backgroundColor: selected.soft }]}>
            <AppIcon name="document" color={selected.color} size={20} />
            <View style={local.documentText}><Text style={local.caption}>작성 문서</Text><Text style={local.formTitle}>{item.formTitle}</Text></View>
          </View>
          <View style={local.actions}>
            <Button label="단계 바꾸기" accessibilityLabel={`${item.formTitle} 단계 바꾸기`} size="small" disabled={busy}
              style={[local.action, { backgroundColor: selected.color }]} onPress={() => onOpenStage(identity, item.id)} />
            <Button label="공고 상세" accessibilityLabel={`${item.programTitle} 상세 보기`} size="small" variant="secondary" style={local.action}
              onPress={() => onOpenProgram(identity)} />
          </View>
        </View>
      })}
    </View>
    <View style={local.help}><AppIcon name="document" color={colors.muted} size={17} />
      <Text style={[styles.muted, local.helpText]}>관심 공고에서 뺀 사업의 문서·검토는 ‘준비 중인 작업’에서 확인할 수 있어요.</Text>
    </View>
  </View>
}

const local = StyleSheet.create({
  root: { gap: 20 }, overview: { gap: 8 },
  steps: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  step: { flexBasis: '30%', flexGrow: 1, minWidth: 80, borderRadius: 14, borderWidth: 1, padding: 12, gap: 7 },
  icon: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  stepLabel: { color: colors.secondaryText, fontSize: 13, lineHeight: 19, fontWeight: '600' },
  stepCount: { fontSize: 24, lineHeight: 30, fontWeight: '700' }, countUnit: { fontSize: 12, fontWeight: '500' },
  caption: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  group: { gap: 10 }, groupHeading: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  marker: { width: 4, height: 22, borderRadius: 2 }, total: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, fontSize: 12, fontWeight: '600', overflow: 'hidden' },
  card: { backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border, borderTopWidth: 3, padding: 16, gap: 12 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  badge: { borderRadius: 6, overflow: 'hidden', paddingHorizontal: 9, paddingVertical: 4, fontSize: 12, fontWeight: '600' },
  organization: { flexShrink: 1 }, programTitle: { color: colors.text, fontSize: 17, lineHeight: 25, fontWeight: '700' },
  document: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 10, padding: 12 },
  documentText: { flex: 1, gap: 2 }, formTitle: { color: colors.text, fontSize: 14, lineHeight: 21, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 2 }, action: { flexBasis: 110, flexGrow: 1 },
  empty: { backgroundColor: colors.surface, padding: 24, borderRadius: 16, alignItems: 'center', gap: 10 },
  emptyIcon: { width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: colors.secondaryText, fontSize: 15, lineHeight: 23, textAlign: 'center', fontWeight: '600' },
  help: { flexDirection: 'row', gap: 8, paddingHorizontal: 4, alignItems: 'flex-start' }, helpText: { flex: 1 },
})
