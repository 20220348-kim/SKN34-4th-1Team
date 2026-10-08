import { useCallback, useEffect, useRef, useState } from 'react'
import { router, useFocusEffect } from 'expo-router'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { SavedSupportProgram } from '@govbiz/shared/domain/entities/SavedSupportProgram'
import { applicationProgressStages, type ApplicationPreparationSummary, type ApplicationProgressStage } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import { applicationProgressStageLabels, daysUntil, formatDday, programStatusLabels } from '@govbiz/shared/domain/labels'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { ApiError, errorMessage } from '../api/client'
import { listSavedPrograms, removeSavedProgram, saveProgram } from '../api/savedPrograms'
import { useAuth } from '../auth/session'
import { useScrollBoundary } from '../components/useScrollBoundary'
import { Page, Button, Field, Notice, Card, StatusBadge, colors, ddayBadgeTone, styles } from '../ui'
import { AppIcon } from '../components/AppIcon'
import { SegmentedControl } from '../components/SegmentedControl'
import { preparationDate, preparationKey, PreparationRow, ReviewRow, ProgressStageSheet, preparationWorkStatus, preparationWorkStatusLabels, reviewWorkStatus, reviewWorkStatusLabels } from '../components/PreparationRows'
import { usePreparationWorkspace } from '../components/usePreparationWorkspace'
import { GuestFeatureNotice } from '../components/GuestFeatureNotice'
import { FilterMultiChoices } from '../components/FilterMultiChoices'
import { PartnerSheet } from '../components/PartnerSheet'
import { ChoiceField } from '../components/ChoiceField'
import { SavedProgramCalendar } from '../components/SavedProgramCalendar'
import { SavedProgramPipeline } from '../components/SavedProgramPipeline'
import { emptySavedProgramFilters, filterSavedPrograms, savedCalendarMonth, savedCalendarToday, savedProgramTargetOptions, sortSavedProgramsByDeadline,
  type SavedProgramFilters, type SavedProgramStageFilter } from '../components/savedProgramPresentation'
import { regionNames } from '@govbiz/shared/domain/entities/Region'
import { supportProgramCategories } from '@govbiz/shared/domain/entities/SupportProgramCategory'

type SavedState = { token: string | null; programs: SavedSupportProgram[]; loading: boolean; error: string | null }
type Filter = SavedProgramStageFilter
type Undo = { owner: string; item: SavedSupportProgram; index: number }
type SavedView = 'list' | 'calendar' | 'pipeline'
type WorkType = 'all' | 'document' | 'review'
type WorkStatus = 'all' | keyof typeof preparationWorkStatusLabels | keyof typeof reviewWorkStatusLabels
type StageTarget = { owner: string; identity: SupportProgramIdentity; items: ApplicationPreparationSummary[] }
const filters: { value: Filter; label: string }[] = [{ value: 'all', label: '전체' }, { value: 'interest', label: '관심' },
  ...applicationProgressStages.map((value) => ({ value, label: applicationProgressStageLabels[value] }))]

export function SavedProgramsScreen({ onOpenProgram, onCountChange, onLogin }: {
  onOpenProgram(identity: SupportProgramIdentity): void; onCountChange?(count: number): void; onLogin(mode?: 'login' | 'signup'): void
}) {
  const { session, status, refreshSession, invalidateSession } = useAuth()
  const scrollBoundary = useScrollBoundary(true)
  const token = status === 'signedIn' ? session?.accessToken ?? null : null
  const [state, setState] = useState<SavedState>({ token: null, programs: [], loading: true, error: null })
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState<'saved' | 'preparation'>('saved')
  const [filterOpen, setFilterOpen] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [workType, setWorkType] = useState<WorkType>('all')
  const [workStatus, setWorkStatus] = useState<WorkStatus>('all')
  const [workStage, setWorkStage] = useState<'all' | ApplicationProgressStage>('all')
  const [savedView, setSavedView] = useState<SavedView>('list')
  const [search, setSearch] = useState<{ owner: string | null; filters: SavedProgramFilters }>({ owner: null, filters: emptySavedProgramFilters() })
  const today = savedCalendarToday()
  const [month, setMonth] = useState(() => savedCalendarMonth(today))
  const [stageTarget, setStageTarget] = useState<StageTarget | null>(null)
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
  useEffect(() => { setFilter('all'); setWorkType('all'); setWorkStatus('all'); setWorkStage('all'); setSavedView('list'); setMonth(savedCalendarMonth(savedCalendarToday())); setStageTarget(null); setFilterOpen(false) }, [token])
  const criteria = search.owner === token ? search.filters : emptySavedProgramFilters()
  function changeCriteria(update: (value: SavedProgramFilters) => SavedProgramFilters) {
    setSearch(current => ({ owner: token, filters: update(current.owner === token ? current.filters : emptySavedProgramFilters()) }))
  }
  function toggleCriterion(key: 'region' | 'category' | 'target', value: string) {
    changeCriteria(current => ({ ...current, [key]: current[key].includes(value) ? current[key].filter(item => item !== value) : [...current[key], value] }))
  }
  function resetFilters() { changeCriteria(emptySavedProgramFilters); setFilter('all') }
  function resetWorkFilters() { setWorkType('all'); setWorkStatus('all'); setWorkStage('all') }
  function newDocument(identity?: SupportProgramIdentity) { router.push(identity ? { pathname: '/all/preparation/new', params: identity } : '/all/preparation/new') }
  function openStage(identity: SupportProgramIdentity, preferredId?: number) {
    if (!token || workspace.preparations === null || workspace.loading || workspace.preparationError) return
    const items = workspace.preparations.filter(item => preparationKey(item) === preparationKey(identity))
    const preferred = items.find(item => item.id === preferredId)
    setStageTarget({ owner: token, identity, items: preferred ? [preferred, ...items.filter(item => item.id !== preferred.id)] : items })
  }
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
  const matching = sortSavedProgramsByDeadline(filterSavedPrograms(visible.programs, criteria))
  const shown = filter === 'all' ? matching : workspace.preparations === null ? [] : matching.filter(item => stageOf(item) === filter)
  const options = (values: readonly string[]) => [...new Set(values)].sort((left, right) => left.localeCompare(right, 'ko-KR'))
  const activeCriteria = [
    ...(criteria.keyword.trim() ? [{ key: 'keyword' as const, value: criteria.keyword, label: `검색 · ${criteria.keyword.trim()}` }] : []),
    ...(['region', 'category', 'target'] as const).flatMap(key => criteria[key].map(value => ({ key, value, label: `${{ region: '지역', category: '분야', target: '대상' }[key]} · ${value}` }))),
  ]
  const listStageReady = filter === 'all' || workspace.preparations !== null && !workspace.preparationError
  const stageBusy = workspace.loading || workspace.preparations === null || Boolean(workspace.preparationError)
  const workCount = workspace.preparations !== null && workspace.reviews !== null ? workspace.preparations.length + workspace.reviews.length : null
  const shownPreparations = workType === 'review' ? [] : workspace.preparations?.filter(item =>
    (workStatus === 'all' || preparationWorkStatus(item) === workStatus) && (workStage === 'all' || item.progressStage === workStage)) ?? []
  const shownReviews = workType === 'document' || workStage !== 'all' ? [] : workspace.reviews?.filter(item => workStatus === 'all' || reviewWorkStatus(item) === workStatus) ?? []
  const workFilterCount = Number(workType !== 'all') + Number(workStatus !== 'all') + Number(workStage !== 'all')
  const workStatusOptions = [{ value: 'all', label: '전체 상태' },
    ...Object.entries(workType === 'document' ? preparationWorkStatusLabels : workType === 'review' ? reviewWorkStatusLabels : { ...preparationWorkStatusLabels, ...reviewWorkStatusLabels }).map(([value, label]) => ({ value, label }))]
  if (status === 'loading') return <Page><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" /></Page>
  if (status === 'unavailable') return <Page><Notice error>로그인 상태를 확인하지 못했습니다.</Notice><Button label="다시 확인" onPress={() => void refreshSession()} /></Page>
  if (!token) return <Page><GuestFeatureNotice title="관심 있는 공고를 한곳에 모아보세요" icon="bookmark"
    description="로그인하면 웹과 앱에 저장한 관심 공고와 신청 준비를 이어서 볼 수 있어요." onLogin={onLogin} /></Page>
  return <View style={local.page}>
    <View style={local.header}><SegmentedControl<'saved' | 'preparation'> label="관심함 보기" value={view} onChange={setView} options={[
      { value: 'saved', label: '담은 공고' }, { value: 'preparation', label: `준비 중인 작업${workCount === null ? '' : ` ${workCount}`}` }]} /></View>
    <ScrollView {...scrollBoundary} contentContainerStyle={local.list} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      refreshControl={<RefreshControl refreshing={visible.loading || workspace.loading} onRefresh={refresh} tintColor={colors.primary} />}>
      {workspace.preparationError && <Notice error>신청 문서 조회 실패: {workspace.preparationError}</Notice>}
      {workspace.reviewError && <Notice error>중복 검토 조회 실패: {workspace.reviewError}</Notice>}
      {(visible.error || workspace.preparationError || workspace.reviewError) && <Button label="다시 확인" variant="secondary" onPress={refresh} />}
      {view === 'saved' ? <>
        <SegmentedControl<SavedView> label="담은 공고 보기 방식" value={savedView} onChange={setSavedView} options={[
          { value: 'list', label: '목록' }, { value: 'calendar', label: '달력' }, { value: 'pipeline', label: '진행 관리' }]} />
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 9 }}><View style={{ flex: 1, minWidth: 0 }}>
          <Field label="담은 공고 검색" placeholder="공고명 또는 기관명" value={criteria.keyword} maxLength={100}
            onChangeText={keyword => changeCriteria(current => ({ ...current, keyword }))} /></View>
          <Button label={`필터 ${criteria.region.length + criteria.category.length + criteria.target.length + (filter === 'all' ? 0 : 1)}`}
            accessibilityLabel="관심 공고 필터 열기" variant="secondary" onPress={() => setFilterOpen(true)} />
        </View>
        {(activeCriteria.length > 0 || filter !== 'all') && <View style={local.applied}>
          {activeCriteria.map(item => <Button key={`${item.key}:${item.value}`} size="small" variant="secondary" label={`${item.label} ×`}
            accessibilityLabel={`${item.label} 조건 해제`} onPress={() => item.key === 'keyword' ? changeCriteria(current => ({ ...current, keyword: '' })) : toggleCriterion(item.key, item.value)} />)}
          {filter !== 'all' && <Button size="small" variant="secondary" label={`진행 · ${filters.find(item => item.value === filter)?.label} ×`} onPress={() => setFilter('all')} />}
          <Button label="필터 초기화" size="small" variant="ghost" onPress={resetFilters} />
        </View>}
        {!visible.loading && !visible.error && listStageReady && <Text accessibilityLiveRegion="polite" style={styles.muted}>조건에 맞는 공고 {shown.length}건 / 담은 공고 {visible.programs.length}건{savedView === 'list' ? ' · 마감 임박순' : ''}</Text>}
        {visible.loading && !visible.programs.length && <ActivityIndicator accessibilityLabel="관심 공고 불러오는 중" color={colors.primary} />}
        {visible.error && <Notice error>{visible.error}</Notice>}
        {!visible.loading && !visible.error && !visible.programs.length && <><Notice>아직 관심 공고가 없습니다. 공고 상세 화면에서 저장해 보세요.</Notice>
          <Button label="공고 찾기" variant="secondary" onPress={() => router.navigate({ pathname: '/', params: { mode: 'filter' } })} /></>}
        {!visible.loading && !visible.error && visible.programs.length > 0 && !shown.length && listStageReady && <Notice>조건에 맞는 관심 공고가 없습니다.</Notice>}
        {savedView === 'calendar' && visible.programs.length > 0 && <SavedProgramCalendar key={token} items={shown} month={month} today={today}
          ready={!visible.error} loading={visible.loading} onMonthChange={setMonth} onOpenProgram={onOpenProgram} />}
        {savedView === 'pipeline' && visible.programs.length > 0 && (workspace.preparations !== null && !workspace.preparationError
          ? <SavedProgramPipeline items={shown} preparations={workspace.preparations} busy={stageBusy} onOpenProgram={onOpenProgram} onOpenStage={openStage} onNewDocument={newDocument} />
          : workspace.loading ? <ActivityIndicator accessibilityLabel="진행 관리 불러오는 중" color={colors.primary} />
            : <Notice>신청 준비를 확인하지 못해 진행 단계를 표시할 수 없어요. 다시 확인해 주세요.</Notice>)}
        {savedView === 'list' && shown.map((item) => {
          const { program, savedAt } = item
          const identity = { sourceCode: program.sourceCode, sourceProgramId: program.id }
          const prep = latestPreparation(identity)
          const docs = workspace.preparations?.filter((value) => preparationKey(value) === preparationKey(identity))
          const reviews = workspace.reviews?.filter(({ review }) => review.programs.some((value) => preparationKey(value) === preparationKey(identity)))
          const days = daysUntil(program.applicationEndDate)
          return <Card key={preparationKey(identity)}>
            <View style={local.meta}><View style={[local.dot, { backgroundColor: program.status === 'OPEN' ? colors.primary : colors.muted }]} />
              <Text style={[local.status, { color: program.status === 'OPEN' ? colors.primary : colors.muted }]}>{programStatusLabels[program.status]}</Text>
              {days !== null && <StatusBadge label={formatDday(days)} tone={ddayBadgeTone(days)} />}
              <View style={{ flex: 1 }} /><Pressable accessibilityRole="button" accessibilityLabel={`${program.title} 진행 단계 바꾸기`}
                accessibilityState={{ disabled: stageBusy }} disabled={stageBusy} onPress={() => openStage(identity)} style={local.stageButton}>
                <StatusBadge label={workspace.preparations === null ? '단계 미확인' : prep ? applicationProgressStageLabels[prep.progressStage] : '관심'} tone={prep ? 'info' : 'neutral'} /></Pressable></View>
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
        <Button label={`필터 ${workFilterCount}`} accessibilityLabel="준비 작업 필터 열기" variant="secondary" onPress={() => setFilterOpen(true)} />
        {workFilterCount > 0 && <Button label="준비 작업 필터 초기화" variant="ghost" onPress={resetWorkFilters} />}
        {workspace.loading && <ActivityIndicator accessibilityLabel="준비 중인 작업 불러오는 중" color={colors.primary} />}
        {!workspace.loading && workCount !== null && <Text accessibilityLiveRegion="polite" style={styles.muted}>조건에 맞는 작업 {shownPreparations.length + shownReviews.length}건 / 전체 작업 {workCount}건</Text>}
        {workType !== 'review' && <><Text style={local.groupTitle}>신청 문서 {workspace.preparations === null ? '—' : shownPreparations.length}</Text>
          {shownPreparations.map((item) => <PreparationRow key={item.id} item={item} />)}
          {!workspace.loading && workspace.preparations?.length === 0 && <><Text style={styles.muted}>아직 신청 문서가 없습니다.</Text><Button label="새 신청문서" variant="secondary" onPress={() => newDocument()} /></>}
          {!workspace.loading && (workspace.preparations?.length ?? 0) > 0 && !shownPreparations.length && <Notice>조건에 맞는 신청 문서가 없습니다.</Notice>}</>}
        {workType !== 'document' && workStage === 'all' && <><Text style={local.groupTitle}>중복 검토 {workspace.reviews === null ? '—' : shownReviews.length}</Text>
          {shownReviews.map((item) => <ReviewRow key={item.review.id} item={item} />)}
          {!workspace.loading && workspace.reviews?.length === 0 && <><Text style={styles.muted}>아직 중복 검토가 없습니다.</Text><Button label="새 검토" variant="secondary" onPress={() => router.push('/all/reviews/new')} /></>}
          {!workspace.loading && (workspace.reviews?.length ?? 0) > 0 && !shownReviews.length && <Notice>조건에 맞는 중복 검토가 없습니다.</Notice>}</>}
      </>}
    </ScrollView>
    <PartnerSheet visible={filterOpen} compact={view === 'preparation'} title={view === 'saved' ? '관심 공고 필터' : '준비 작업 필터'} onClose={() => setFilterOpen(false)} actions={<>
      <Button label="초기화" variant="secondary" onPress={view === 'saved' ? resetFilters : resetWorkFilters} />
      <Button label={view === 'preparation' ? workCount === null ? '결과 확인하기' : `결과 ${shownPreparations.length + shownReviews.length}건 보기`
        : listStageReady && !visible.error ? `결과 ${shown.length}건 보기` : '결과 확인하기'} onPress={() => setFilterOpen(false)} />
    </>}>
      {view === 'preparation' ? <>
        <ChoiceField compact label="작업 종류" value={workType} options={[{ value: 'all', label: '전체 작업' }, { value: 'document', label: '신청 문서' }, { value: 'review', label: '중복 검토' }]}
          onChange={value => { setWorkType(value as WorkType); setWorkStatus('all'); setWorkStage('all') }} />
        <ChoiceField compact label="작업 상태" value={workStatus} options={workStatusOptions} onChange={value => setWorkStatus(value as WorkStatus)} />
        {workType === 'document' && <ChoiceField compact label="신청 진행 단계" value={workStage} options={[{ value: 'all', label: '전체 단계' }, ...applicationProgressStages.map(value => ({ value, label: applicationProgressStageLabels[value] }))]}
          onChange={value => setWorkStage(value as 'all' | ApplicationProgressStage)} />}
      </> : <>
      <FilterMultiChoices label="지역" selected={criteria.region} options={options([...regionNames, ...criteria.region, ...visible.programs.flatMap(item => item.program.regions)])}
        onToggle={value => toggleCriterion('region', value)} onClear={() => changeCriteria(current => ({ ...current, region: [] }))} />
      <FilterMultiChoices label="분야" selected={criteria.category} options={options([...supportProgramCategories, ...criteria.category, ...visible.programs.flatMap(item => item.program.categories)])}
        onToggle={value => toggleCriterion('category', value)} onClear={() => changeCriteria(current => ({ ...current, category: [] }))} />
      <FilterMultiChoices label="대상" selected={criteria.target} options={savedProgramTargetOptions}
        onToggle={value => toggleCriterion('target', value)} onClear={() => changeCriteria(current => ({ ...current, target: [] }))} />
      <Text style={styles.heading}>진행 단계</Text><View style={styles.row}>{filters.map(({ value, label }) =>
        <Button key={value} label={label} accessibilityLabel={`진행 단계 ${label}`} size="small" variant={filter === value ? 'primary' : 'secondary'} onPress={() => setFilter(value)} />)}</View>
      {workspace.preparationError && <Notice error>진행 단계를 확인하지 못했어요. {workspace.preparationError}</Notice>}
      {visible.error && <Notice error>{visible.error}</Notice>}
      <Text style={styles.muted}>지역·분야·대상을 여러 개 선택할 수 있어요. 선택하지 않으면 전체 담은 공고를 보여줍니다.</Text>
      </>}
    </PartnerSheet>
    {stageTarget?.owner === token && (stageTarget.items.length > 0
      ? <ProgressStageSheet key={`${token}:${preparationKey(stageTarget.identity)}`} items={stageTarget.items} token={token} onClose={() => setStageTarget(null)} onSaved={workspace.refresh} />
      : <PartnerSheet visible title="신청 준비 시작" onClose={() => setStageTarget(null)} actions={<Button label="닫기" variant="secondary" onPress={() => setStageTarget(null)} />}>
        <Notice>신청 문서를 만들면 준비 중·제출 완료·심사 중·결과 단계를 관리할 수 있어요.</Notice>
        <Button label="이 공고로 신청 문서 작성" onPress={() => { const identity = stageTarget.identity; setStageTarget(null); newDocument(identity) }} />
      </PartnerSheet>)}
    {undo?.owner === token && <View accessibilityLiveRegion="polite" style={local.toast}><Text style={local.toastText}>관심 공고에서 뺐어요</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="되돌리기" disabled={removing !== null} onPress={() => void undoRemove()} style={local.undo}><Text style={local.undoText}>되돌리기</Text></Pressable></View>}
  </View>
}

const local = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background }, header: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 12, backgroundColor: colors.surface },
  list: { paddingHorizontal: 16, paddingTop: 16, gap: 10 }, filters: { gap: 6, paddingBottom: 2 },
  applied: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, stageButton: { minHeight: 44, justifyContent: 'center' },
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
