import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { applicationProgressStages, applicationServiceFieldLabels, type ApplicationPreparationSummary, type ApplicationProgressStage } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { ApiError, errorMessage } from '../api/client'
import { getPreparationWebUrl, updatePreparationProgress, type PreparationReview } from '../api/preparation'
import { Button, colors, Notice, StatusBadge, styles } from '../ui'
import { AppIcon } from './AppIcon'
import { PartnerSheet } from './PartnerSheet'
import { usePreparationWorkspace } from './usePreparationWorkspace'

export const preparationStageLabels: Record<ApplicationProgressStage, string> = {
  PREPARING: '준비 중', APPLIED: '지원 완료', DOCUMENT_REVIEW: '서류 심사', PRESENTATION_REVIEW: '발표 심사', SELECTED: '선정', REJECTED: '미선정',
}
export const preparationKey = (identity: SupportProgramIdentity) => JSON.stringify([identity.sourceCode, identity.sourceProgramId])
export const preparationDate = (date: string) => date.slice(5, 10).replace('-', '.')

export async function openPreparationWeb(path: string, identity?: SupportProgramIdentity) {
  try { await Linking.openURL(getPreparationWebUrl(path, identity)) }
  catch (cause) { Alert.alert('준비 화면을 열지 못했습니다', cause instanceof Error && cause.message.startsWith('웹 주소') ? cause.message : errorMessage(cause)) }
}

export function PreparationRow({ item }: { item: ApplicationPreparationSummary }) {
  const completed = item.hasCurrentDocument === true
  const total = item.requiredTotal
  const answered = item.answeredRequired
  return <Pressable accessibilityRole="button" accessibilityLabel={`${item.formTitle} · ${applicationServiceFieldLabels[item.serviceField]} 열기`}
    onPress={() => void openPreparationWeb(`/app/application-preparations/${item.id}${completed ? '/documents' : ''}`)} style={local.row}>
    <View style={local.icon}><AppIcon name="document" color={colors.primary} size={18} /></View>
    <View style={local.text}><Text style={local.rowTitle}>{item.formTitle} · {applicationServiceFieldLabels[item.serviceField]}</Text>
      <Text style={local.small}>{completed ? `${item.programTitle} · 입력 버전 ${item.inputRevision}`
        : total !== undefined && answered !== undefined ? `${total}개 항목 중 ${answered}개 확인` : `${item.programTitle} · 입력 버전 ${item.inputRevision}`}</Text>
      {!completed && total !== undefined && total > 0 && answered !== undefined && <View accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: total, now: answered }} style={local.track}>
        <View style={[local.bar, { width: `${Math.min(100, answered / total * 100)}%` }]} /></View>}
    </View>
    <View style={local.pill}><StatusBadge label={completed ? '초안 완료' : item.hasCurrentDocument === false ? '작성 중' : '상태 확인 필요'}
      tone={completed ? 'success' : 'neutral'} /></View>
  </Pressable>
}

export function ReviewRow({ item }: { item: PreparationReview }) {
  const { review, latestRun } = item
  const current = latestRun?.inputRevision === review.inputRevision
  const completed = current && latestRun?.status === 'SUCCEEDED'
  const running = current && (latestRun?.status === 'QUEUED' || latestRun?.status === 'RUNNING')
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [running])
  const labels = { QUEUED: '분석 대기', RUNNING: '분석 중', SUCCEEDED: '분석 완료', FAILED: '분석 실패', INTERRUPTED: '분석 중단', UNKNOWN: '결과 확인 필요' }
  const label = !latestRun ? '분석 전' : !current ? '입력 변경' : labels[latestRun.status]
  const elapsed = latestRun ? Math.max(0, Math.floor((now - new Date(latestRun.startedAt).getTime()) / 1_000)) : 0
  return <Pressable accessibilityRole="button" accessibilityLabel={`${review.title} 열기`} style={local.row}
    onPress={() => void openPreparationWeb(`/app/combination-reviews/${review.id}${current && latestRun ? `/runs/${latestRun.id}` : ''}`)}>
    <View style={[local.icon, { backgroundColor: completed ? colors.soft : colors.warningSoft }]}>{running
      ? <ActivityIndicator accessibilityLabel="중복 검토 진행 중" color={colors.primary} />
      : <AppIcon name="shield" color={completed ? colors.primary : colors.warning} size={18} />}</View>
    <View style={local.text}><Text style={local.rowTitle}>{review.title}</Text>
      <Text style={local.small}>{review.programs.length}개 공고 · {running ? `${elapsed}초 경과`
        : latestRun ? `${preparationDate(latestRun.startedAt)} 실행 · 결과 보기` : `${preparationDate(review.updatedAt)} 수정`}</Text></View>
    <View style={local.pill}><StatusBadge label={label} tone={completed ? 'success' : running ? 'info' : 'neutral'} /></View>
  </Pressable>
}

export function ProgressStageSheet({ items, token, onClose, onSaved }: {
  items: ApplicationPreparationSummary[]; token: string; onClose(): void; onSaved(): void
}) {
  const [selectedId, setSelectedId] = useState(items[0]?.id)
  const item = items.find((value) => value.id === selectedId) ?? items[0]
  const [stage, setStage] = useState<ApplicationProgressStage>(item?.progressStage ?? 'PREPARING')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const work = useRef<AbortController | null>(null)
  useEffect(() => { if (item) setStage(item.progressStage) }, [item?.id, item?.progressRevision])
  useEffect(() => () => work.current?.abort(), [])
  async function save() {
    if (!item || busy || stage === item.progressStage) return
    const controller = new AbortController(); work.current = controller
    setBusy(true); setError(null)
    try {
      await updatePreparationProgress(item, stage, token, controller.signal)
      if (!controller.signal.aborted) { onSaved(); onClose() }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof ApiError && cause.status === 409
        ? '다른 화면에서 진행 단계가 변경됐어요. 닫고 새로고침한 뒤 다시 시도해 주세요.' : errorMessage(cause))
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <PartnerSheet visible title="진행 단계 바꾸기" onClose={() => { if (!busy) onClose() }}
    actions={<><Button label="취소" variant="secondary" disabled={busy} onPress={onClose} />
      <Button label="저장" busy={busy} disabled={!item || stage === item.progressStage} onPress={() => void save()} /></>}>
    {items.length > 1 && <View style={{ gap: 6 }}><Text style={styles.label}>단계를 바꿀 신청 문서</Text>
      {items.map((value) => <Pressable key={value.id} accessibilityRole="radio" accessibilityState={{ checked: value.id === item?.id }}
        disabled={busy} onPress={() => setSelectedId(value.id)} style={local.option}>
        <Text style={styles.body}>{value.id === item?.id ? '● ' : '○ '}{value.formTitle} · {applicationServiceFieldLabels[value.serviceField]}</Text></Pressable>)}</View>}
    {applicationProgressStages.map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={preparationStageLabels[value]}
      accessibilityState={{ checked: value === stage, disabled: busy }} disabled={busy} onPress={() => setStage(value)} style={local.option}>
      <Text style={[styles.body, value === stage && { color: colors.primary }]}>{value === stage ? '● ' : '○ '}{preparationStageLabels[value]}</Text></Pressable>)}
    {error && <Notice error>{error}</Notice>}
  </PartnerSheet>
}

export function ProgramPreparationSection({ identity, token }: { identity: SupportProgramIdentity; token: string }) {
  const workspace = usePreparationWorkspace(token)
  const [stageOpen, setStageOpen] = useState(false)
  const items = workspace.preparations?.filter((item) => preparationKey(item) === preparationKey(identity)) ?? []
  const reviews = workspace.reviews?.filter(({ review }) => review.programs.some((program) => preparationKey(program) === preparationKey(identity))) ?? []
  return <View style={local.section}>
    <View style={local.sectionHead}><Text style={styles.heading}>준비</Text><Text style={local.small}>담은 공고라 보여요</Text></View>
    {workspace.loading && <ActivityIndicator accessibilityLabel="준비 현황 불러오는 중" color={colors.primary} />}
    {workspace.preparationError && <Notice error>신청 문서 조회 실패: {workspace.preparationError}</Notice>}
    {workspace.reviewError && <Notice error>중복 검토 조회 실패: {workspace.reviewError}</Notice>}
    {(workspace.preparationError || workspace.reviewError) && <Button label="준비 현황 다시 확인" variant="ghost" onPress={workspace.refresh} />}
    {workspace.preparations !== null && <View style={local.stageRow}><View style={local.text}><Text style={local.small}>진행 단계</Text>
      <Text style={styles.body}>{items[0] ? preparationStageLabels[items[0].progressStage] : '관심'}</Text></View>
      <StatusBadge label={items[0] ? preparationStageLabels[items[0].progressStage] : '관심'} tone={items[0] ? 'info' : 'neutral'} />
      <Pressable accessibilityRole="button" accessibilityLabel="진행 단계 바꾸기" style={local.change} onPress={() => items.length ? setStageOpen(true)
        : Alert.alert('아직 신청 준비를 시작하지 않았어요', '신청 문서를 만들면 진행 단계를 관리할 수 있어요.')}><Text style={local.changeText}>바꾸기</Text></Pressable></View>}
    {items.map((item) => <PreparationRow key={item.id} item={item} />)}
    {reviews.map((item) => <ReviewRow key={item.review.id} item={item} />)}
    {!workspace.loading && workspace.preparations !== null && workspace.reviews !== null && !items.length && !reviews.length
      && <Text style={styles.muted}>아직 준비 중인 작업이 없어요.</Text>}
    <View style={local.buttons}><Button label="+ 새 문서" variant="secondary" onPress={() => void openPreparationWeb('/app/application-preparations/new', identity)} />
      <Button label="중복 검토 요청" variant="secondary" onPress={() => void openPreparationWeb('/app/combination-reviews/new', identity)} /></View>
    {stageOpen && <ProgressStageSheet items={items} token={token} onClose={() => setStageOpen(false)} onSaved={workspace.refresh} />}
  </View>
}

const local = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: 12, backgroundColor: colors.surface, padding: 12 },
  icon: { width: 30, height: 30, borderRadius: 10, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 3 },
  rowTitle: { color: colors.text, fontSize: 14, lineHeight: 21, fontWeight: '600' },
  small: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  pill: { alignSelf: 'flex-start' },
  track: { height: 4, borderRadius: 99, backgroundColor: colors.track, overflow: 'hidden', marginTop: 4 },
  bar: { height: 4, borderRadius: 99, backgroundColor: colors.primary },
  option: { minHeight: 44, paddingVertical: 10 },
  section: { borderWidth: 1, borderColor: colors.border, borderRadius: 16, backgroundColor: colors.surface, padding: 12, gap: 6 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 4 },
  stageRow: { flexDirection: 'row', alignItems: 'center', gap: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingBottom: 8 },
  change: { minHeight: 44, justifyContent: 'center', paddingLeft: 6 },
  changeText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 8 },
})
