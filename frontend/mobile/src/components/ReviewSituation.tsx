import { Pressable, StyleSheet, Text, View } from 'react-native'
import { reviewProgramKey, type ReviewProgram, type ReviewRelation } from '@govbiz/shared/domain/entities/CombinationReview'
import {
  participationToReviewStatus, reviewProgramStatusLabels, reviewRelationAnswerLabels, reviewRelationLabels, reviewStatusToParticipation, type ReviewProgramStatus,
} from '@govbiz/shared/domain/entities/CombinationReviewParticipation'
import { Button, StatusBadge, colors, styles } from '../ui'
import { ChoiceField } from './ChoiceField'

export type ReviewSituation = { programs: ReviewProgram[]; relation: ReviewRelation }

const statusOptions = Object.entries(reviewProgramStatusLabels).map(([value, label]) => ({ value, label }))
const relationFields = ['sameProject', 'sameCost'] as const
const relationAnswers = ['YES', 'NO', 'UNKNOWN'] as const

/**
 * 내 상황(선택) 입력 칸이에요. 사업마다 지금 상태 하나(모름 · 신청 전 · 신청함 · 선정·협약·수행 중 · 받음·종료)와
 * 두 사업의 관계 두 칸(같은 과제·제품 · 같은 비용 항목, 예 · 아니오 · 모름)을 골라요. 상태는 shared 규칙으로 기존 사실 6개에 저장해요.
 */
export function ReviewSituationFields({ value, names, disabled, onChange }: {
  value: ReviewSituation; names: Record<string, string>; disabled: boolean; onChange(next: ReviewSituation): void
}) {
  return <View style={local.fields}>
    {value.programs.map((program, index) => <View key={reviewProgramKey(program)} style={local.field}>
      <Text style={styles.muted}>사업 {index + 1} · {names[reviewProgramKey(program)] ?? '공고명 확인 필요'}</Text>
      <ChoiceField label={`사업 ${index + 1} 지금 상태`} value={participationToReviewStatus(program.participation)} options={statusOptions} disabled={disabled}
        onChange={status => { if (!disabled) onChange({ ...value, programs: value.programs.map((item, itemIndex) => itemIndex === index
          ? { ...item, participation: reviewStatusToParticipation(status as ReviewProgramStatus, item.participation) } : item) }) }} />
    </View>)}
    {relationFields.map(field => <View key={field} accessibilityRole="radiogroup" accessibilityLabel={reviewRelationLabels[field]} style={local.field}>
      <Text style={styles.label}>{reviewRelationLabels[field]}</Text>
      <View style={local.choices}>{relationAnswers.map(answer => {
        const checked = value.relation[field] === answer
        return <Pressable key={answer} accessibilityRole="radio" accessibilityLabel={`${reviewRelationLabels[field]} ${reviewRelationAnswerLabels[answer]}`}
          accessibilityState={{ checked, disabled }} disabled={disabled} onPress={() => onChange({ ...value, relation: { ...value.relation, [field]: answer } })}
          style={[local.choice, checked && local.selected, disabled && local.disabled]}>
          <Text style={[local.choiceText, checked && local.selectedText]}>{reviewRelationAnswerLabels[answer]}</Text>
        </Pressable>
      })}</View>
    </View>)}
  </View>
}

/**
 * 세 질문 결과 아래의 "내 상황으로 좁히기"예요. 고른 상황을 검토 입력으로 저장(입력 버전 확인)한 뒤 새 분석을 한 번 접수해요.
 * 바꾼 것이 없거나 지금 새 분석을 보낼 수 없으면 그 이유를 버튼 위에 적어요.
 */
export function ReviewNarrowingPanel({ value, names, dirty, busy, disabled, blocked, onChange, onSubmit }: {
  value: ReviewSituation; names: Record<string, string>; dirty: boolean; busy: boolean
  /** 불러오는 중처럼 이유를 적지 않고 잠시 막을 때 써요. */
  disabled: boolean
  blocked: string | null; onChange(next: ReviewSituation): void; onSubmit(): void
}) {
  const reason = blocked ?? (dirty ? null : '상황을 바꾸면 다시 분석할 수 있어요')
  return <View testID="review-narrowing" style={styles.card}>
    <View style={styles.row}><Text accessibilityRole="header" style={styles.heading}>내 상황으로 좁히기</Text><StatusBadge label="선택" /></View>
    <Text style={styles.muted}>사업별 지금 상태와 두 사업이 같은 과제·비용인지 고르면 조건부 답을 좁혀 다시 분석해요. 저장한 입력으로 유료 분석을 한 번 실행해요.</Text>
    <ReviewSituationFields value={value} names={names} disabled={busy || disabled} onChange={onChange} />
    {reason && <Text testID="review-narrowing-reason" accessibilityLiveRegion="polite" style={styles.muted}>{reason}</Text>}
    <Button label="저장하고 다시 분석" busy={busy} disabled={disabled || Boolean(reason)} onPress={onSubmit} />
  </View>
}

const local = StyleSheet.create({
  fields: { gap: 14 },
  field: { gap: 7 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { minHeight: 44, minWidth: 64, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9,
    borderWidth: 1, borderColor: colors.border, borderRadius: 22, backgroundColor: colors.surface },
  selected: { backgroundColor: colors.soft, borderColor: colors.primary },
  disabled: { opacity: 0.55 },
  choiceText: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  selectedText: { color: colors.primary, fontWeight: '600' },
})
