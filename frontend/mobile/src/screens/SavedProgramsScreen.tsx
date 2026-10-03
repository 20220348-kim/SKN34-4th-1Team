import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { SavedSupportProgram } from '@govbiz/shared/domain/entities/SavedSupportProgram'
import type { ApplicationProgressStage } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { ApiError, errorMessage } from '../api/client'
import { listSavedPrograms, removeSavedProgram, saveProgram } from '../api/savedPrograms'
import { useAuth } from '../auth/session'
import { Page, Button, Notice, Card, StatusBadge, colors, styles } from '../ui'
import { AppIcon } from '../components/AppIcon'
import { SegmentedControl } from '../components/SegmentedControl'
import { partnerDeadlineDay } from '../components/PartnerDates'
import { preparationDate, preparationKey, preparationStageLabels, PreparationRow, ReviewRow } from '../components/PreparationRows'
import { usePreparationWorkspace } from '../components/usePreparationWorkspace'
import { statusLabels } from '../components/ProgramCard'
import { GuestFeatureNotice } from '../components/GuestFeatureNotice'

type SavedState = { token: string | null; programs: SavedSupportProgram[]; loading: boolean; error: string | null }
type Filter = 'all' | 'interest' | ApplicationProgressStage
type Undo = { owner: string; item: SavedSupportProgram; index: number }
const filters: { value: Filter; label: string }[] = [{ value: 'all', label: '전체' }, { value: 'interest', label: '관심' },
  ...Object.entries(preparationStageLabels).map(([value, label]) => ({ value: value as ApplicationProgressStage, label }))]

export function SavedProgramsScreen({ onOpenProgram, onCountChange, onLogin }: {
  onOpenProgram(identity: SupportProgramIdentity): void; onCountChange?(count: number): void; onLogin(mode?: 'login' | 'signup'): void
}) {
  const { session, status, refreshSession, invalidateSession } = useAuth()
  const token = status === 'signedIn' ? session?.accessToken ?? null : null
  const [state, setState] = useState<SavedState>({ token: null, programs: [], loading: true, error: null })
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState<'saved' | 'preparation'>('saved')
  const [filter, setFilter] = useState<Filter>('all')
  const [removing, setRemoving] = useState<string | null>(null)
  const [undo, setUndo] = useState<Undo | null>(null)
  const mutation = useRef<AbortController | null>(null)
  const workspace = usePreparationWorkspace(token)
  useFocusEffect(useCallback(() => {
    const controller = new AbortController()
    mutation.current?.abort(); setRemoving(null); setUndo(null)
    setState((current) => current.token === token ? { ...current, loading: true, error: null } : { token, programs: [], loading: true, error: null })
    if (token) void listSavedPrograms(token, controller.signal).then((programs) => {
      if (!controller.signal.aborted) setState({ token, programs, loading: false, error: null })
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setState((current) => ({ ...current, token, loading: false, error: errorMessage(cause) }))
    })
    return () => { controller.abort(); mutation.current?.abort() }
  }, [token, revision, invalidateSession]))
  const visible: SavedState = state.token === token ? state : { token, programs: [], loading: true, error: null }
  useEffect(() => { onCountChange?.(token ? visible.programs.length : 0) }, [token, visible.programs.length, onCountChange])
  useEffect(() => { if (!undo) return; const timer = setTimeout(() => setUndo(null), 7_000); return () => clearTimeout(timer) }, [undo])
  function refresh() { setRevision((value) => value + 1); workspace.refresh() }
  async function removeProgram(item: SavedSupportProgram) {
    if (!token || removing) return
    const identity = { sourceCode: item.program.sourceCode, sourceProgramId: item.program.id }
    const controller = new AbortController(); mutation.current = controller
    setRemoving(preparationKey(identity)); setState((current) => ({ ...current, error: null }))
    try {
      await removeSavedProgram(token, identity, controller.signal)
      if (controller.signal.aborted) return
      setUndo({ owner: token, item, index: visible.programs.indexOf(item) })
      setState((current) => current.token !== token ? current : { ...current, programs: current.programs.filter(({ program }) => program.sourceCode !== identity.sourceCode || program.id !== identity.sourceProgramId) })
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setState((current) => current.token !== token ? current : { ...current, error: errorMessage(cause) })
    } finally { if (!controller.signal.aborted) setRemoving(null) }
  }
  async function undoRemove() {
    if (!undo || undo.owner !== token || !token || removing) return
    const identity = { sourceCode: undo.item.program.sourceCode, sourceProgramId: undo.item.program.id }
    const controller = new AbortController(); mutation.current = controller; setRemoving(preparationKey(identity))
    try {
      const restored = await saveProgram(token, identity, controller.signal)
      if (controller.signal.aborted) return
      setState((current) => {
        if (current.token !== token) return current
        const programs = current.programs.filter(({ program }) => program.sourceCode !== identity.sourceCode || program.id !== identity.sourceProgramId)
        programs.splice(Math.max(0, undo.index), 0, restored)
        return { ...current, programs, error: null }
      }); setUndo(null)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setState((current) => current.token !== token ? current : { ...current, error: errorMessage(cause) })
    } finally { if (!controller.signal.aborted) setRemoving(null) }
  }
  const latestPreparation = (identity: SupportProgramIdentity) => workspace.preparations?.find((item) => preparationKey(item) === preparationKey(identity))
  const stageOf = (saved: SavedSupportProgram) => latestPreparation({ sourceCode: saved.program.sourceCode, sourceProgramId: saved.program.id })?.progressStage ?? 'interest'
  const shown = filter === 'all' ? visible.programs : workspace.preparations === null ? [] : visible.programs.filter((item) => stageOf(item) === filter)
  const workCount = workspace.preparations !== null && workspace.reviews !== null ? workspace.preparations.length + workspace.reviews.length : null
  if (status === 'loading') return <Page><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" /></Page>
  if (status === 'unavailable') return <Page><Notice error>로그인 상태를 확인하지 못했습니다.</Notice><Button label="다시 확인" onPress={() => void refreshSession()} /></Page>
  if (!token) return <Page><GuestFeatureNotice title="관심 있는 공고를 한곳에 모아보세요" icon="bookmark"
    description="로그인하면 웹과 앱에 저장한 관심 공고와 신청 준비를 이어서 볼 수 있어요." onLogin={onLogin} /></Page>
  return <View style={local.page}>
    <View style={local.header}><SegmentedControl<'saved' | 'preparation'> label="관심함 보기" value={view} onChange={setView} options={[
      { value: 'saved', label: '담은 공고' }, { value: 'preparation', label: `준비 중인 작업${workCount === null ? '' : ` ${workCount}`}` }]} /></View>
    <ScrollView contentContainerStyle={local.list} refreshControl={<RefreshControl refreshing={visible.loading || workspace.loading} onRefresh={refresh} tintColor={colors.primary} />}>
      {workspace.preparationError && <Notice error>신청 문서 조회 실패: {workspace.preparationError}</Notice>}
      {workspace.reviewError && <Notice error>중복 검토 조회 실패: {workspace.reviewError}</Notice>}
      {(visible.error || workspace.preparationError || workspace.reviewError) && <Button label="다시 확인" variant="secondary" onPress={refresh} />}
      {view === 'saved' ? <>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={local.filters}>{filters.map(({ value, label }) =>
          <Pressable key={value} accessibilityRole="button" accessibilityLabel={`${label} 공고 필터`} accessibilityState={{ selected: filter === value }}
            onPress={() => setFilter(value)} style={[local.chip, value === filter && local.activeChip]}><Text style={[local.chipText, value === filter && { color: colors.surface }]}>
              {label} {value === 'all' ? visible.programs.length : workspace.preparations === null ? '—' : visible.programs.filter((item) => stageOf(item) === value).length}</Text></Pressable>)}</ScrollView>
        {visible.loading && !visible.programs.length && <ActivityIndicator accessibilityLabel="관심 공고 불러오는 중" color={colors.primary} />}
        {visible.error && <Notice error>{visible.error}</Notice>}
        {!visible.loading && !visible.error && !visible.programs.length && <Notice>아직 관심 공고가 없습니다. 공고 상세 화면에서 저장해 보세요.</Notice>}
        {!visible.loading && visible.programs.length > 0 && !shown.length && workspace.preparations !== null && <Notice>이 단계의 관심 공고가 없습니다.</Notice>}
        {shown.map((item) => {
          const { program, savedAt } = item
          const identity = { sourceCode: program.sourceCode, sourceProgramId: program.id }
          const prep = latestPreparation(identity)
          const docs = workspace.preparations?.filter((value) => preparationKey(value) === preparationKey(identity))
          const reviews = workspace.reviews?.filter(({ review }) => review.programs.some((value) => preparationKey(value) === preparationKey(identity)))
          const days = program.applicationEndDate ? partnerDeadlineDay(program.applicationEndDate) : null
          return <Card key={preparationKey(identity)}>
            <View style={local.meta}><View style={[local.dot, { backgroundColor: program.status === 'OPEN' ? colors.primary : colors.muted }]} />
              <Text style={[local.status, { color: program.status === 'OPEN' ? colors.primary : colors.muted }]}>{statusLabels[program.status]}</Text>
              {days !== null && <StatusBadge label={days < 0 ? '마감' : days === 0 ? 'D-day' : `D-${days}`} tone={days >= 0 && days <= 3 ? 'warning' : 'neutral'} />}
              <View style={{ flex: 1 }} /><StatusBadge label={workspace.preparations === null ? '단계 미확인' : prep ? preparationStageLabels[prep.progressStage] : '관심'} tone={prep ? 'info' : 'neutral'} /></View>
            <Text style={styles.heading}>{program.title}</Text>
            <Text style={styles.muted}>{[program.organization, program.regions.join(' · '), program.applicationEndDate ? `${preparationDate(program.applicationEndDate)} 마감` : program.applicationPeriod].filter(Boolean).join(' · ')}</Text>
            {((docs?.length ?? 0) > 0 || (reviews?.length ?? 0) > 0) && <View style={local.summary}>
              {!!docs?.length && <View style={local.summaryItem}><AppIcon name="document" color={colors.muted} size={14} /><Text style={local.small}>문서 {docs.length}{docs.every((value) => value.hasCurrentDocument !== undefined) ? ` · 초안 완료 ${docs.filter((value) => value.hasCurrentDocument).length}` : ''}</Text></View>}
              {!!reviews?.length && <View style={local.summaryItem}><AppIcon name="shield" color={colors.muted} size={14} /><Text style={local.small}>검토 {reviews.length} · 분석 완료 {reviews.filter(({ review, latestRun }) => latestRun?.status === 'SUCCEEDED' && latestRun.inputRevision === review.inputRevision).length}</Text></View>}
            </View>}
            <View style={local.cardFoot}><Text style={local.small}>{preparationDate(savedAt)} 담음</Text><View style={{ flex: 1 }} />
              <Pressable accessibilityRole="button" accessibilityLabel={`${program.title} 관심 공고에서 빼기`} accessibilityState={{ disabled: removing !== null }} disabled={removing !== null}
                onPress={() => void removeProgram(item)} style={local.bookmark}><AppIcon name="bookmark" color={colors.primary} selected size={19} /></Pressable>
              <Button label="상세 보기" size="small" variant="secondary" onPress={() => onOpenProgram(identity)} /></View>
          </Card>
        })}
      </> : <>
        {workspace.loading && <ActivityIndicator accessibilityLabel="준비 중인 작업 불러오는 중" color={colors.primary} />}
        <Text style={local.groupTitle}>신청 문서 {workspace.preparations?.length ?? '—'}</Text>
        {workspace.preparations?.map((item) => <PreparationRow key={item.id} item={item} />)}
        {!workspace.loading && workspace.preparations?.length === 0 && <Text style={styles.muted}>아직 신청 문서가 없습니다.</Text>}
        <Text style={local.groupTitle}>중복 검토 {workspace.reviews?.length ?? '—'}</Text>
        {workspace.reviews?.map((item) => <ReviewRow key={item.review.id} item={item} />)}
        {!workspace.loading && workspace.reviews?.length === 0 && <Text style={styles.muted}>아직 중복 검토가 없습니다.</Text>}
      </>}
    </ScrollView>
    {undo?.owner === token && <View accessibilityLiveRegion="polite" style={local.toast}><Text style={local.toastText}>관심 공고에서 뺐어요</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="되돌리기" disabled={removing !== null} onPress={() => void undoRemove()} style={local.undo}><Text style={local.undoText}>되돌리기</Text></Pressable></View>}
  </View>
}

const local = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background }, header: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 12, backgroundColor: colors.surface },
  list: { padding: 16, gap: 10, paddingBottom: 100 }, filters: { gap: 6, paddingBottom: 2 },
  chip: { minHeight: 36, paddingHorizontal: 11, borderRadius: 999, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, justifyContent: 'center' },
  activeChip: { backgroundColor: colors.text, borderColor: colors.text }, chipText: { color: colors.secondaryText, fontSize: 12 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 }, dot: { width: 5, height: 5, borderRadius: 3 }, status: { fontSize: 12, fontWeight: '600' },
  summary: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 8, borderRadius: 10, backgroundColor: colors.background },
  summaryItem: { flexDirection: 'row', alignItems: 'center', gap: 4 }, small: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  cardFoot: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bookmark: { minWidth: 44, minHeight: 44, borderRadius: 22, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  groupTitle: { fontSize: 13, lineHeight: 20, fontWeight: '600', color: colors.muted, marginTop: 6 },
  toast: { position: 'absolute', bottom: 12, left: 16, right: 16, backgroundColor: colors.text, borderRadius: 12, paddingLeft: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toastText: { color: colors.surface, fontSize: 13, flexShrink: 1 }, undo: { minHeight: 48, paddingHorizontal: 14, justifyContent: 'center' },
  undoText: { color: '#60D6A0', fontSize: 14, fontWeight: '600' },
})
