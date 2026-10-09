import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, AppState, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { reviewProgramKey, supportsAutomaticReview, unknownParticipation, type ReviewProgram } from '@govbiz/shared/domain/entities/CombinationReview'
import type { SupportProgram } from '@govbiz/shared/domain/entities/SupportProgram'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { useAuth } from '../auth/session'
import { FeatureUsageLine } from '../components/PlanUsage'
import { ApiError, errorMessage, programClient } from '../api/client'
import { listPreparationReviews, type PreparationReview } from '../api/preparation'
import { useCombinationReview } from '../components/useCombinationReview'
import { ReviewResult, reviewRunLabels, reviewTime } from '../components/ReviewResult'
import { ReviewRow } from '../components/PreparationRows'
import { CatalogScreen } from './CatalogScreen'
import { ChoiceField } from '../components/ChoiceField'
import { SegmentedControl } from '../components/SegmentedControl'
import { ReviewSavedPrograms } from '../components/ReviewSavedPrograms'
import { ReviewNarrowingPanel, ReviewSituationFields, type ReviewSituation } from '../components/ReviewSituation'
import { Button, Card, Field, Notice, Page, StatusBadge, Title, colors, styles } from '../ui'

function ReviewLogin({ onLogin }: { onLogin(): void }) {
  const auth = useAuth()
  return <Page><Title>중복 지원·수혜 검토</Title>
    {auth.status === 'loading' ? <ActivityIndicator accessibilityLabel="로그인 상태 확인 중" />
      : auth.status === 'unavailable' ? <><Notice error>로그인 상태를 확인하지 못했어요.</Notice><Button label="로그인 상태 다시 확인" onPress={() => void auth.refreshSession()} /></>
        : <><Notice>로그인하면 본인의 검토와 참여 이력을 관리할 수 있어요. 기업 등록 없이 직접 입력할 수 있습니다.</Notice><Button label="로그인하고 시작" onPress={onLogin} /></>}
  </Page>
}

export function CombinationReviewListScreen({ onNew, onLogin }: { onNew(): void; onLogin(): void }) {
  const auth = useAuth()
  if (auth.status !== 'signedIn' || !auth.session) return <ReviewLogin onLogin={onLogin} />
  return <OwnedReviewList key={auth.session.accessToken} token={auth.session.accessToken} onNew={onNew} />
}
function OwnedReviewList({ token, onNew }: { token: string; onNew(): void }) {
  const { invalidateSession } = useAuth()
  const [items, setItems] = useState<PreparationReview[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive')
  useEffect(() => { const subscription = AppState.addEventListener('change', value => setForeground(value === 'active')); return () => subscription.remove() }, [])
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  useFocusEffect(useCallback(() => {
    if (!foreground) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      setLoading(true); setError(null)
      try {
        const rows = await listPreparationReviews(token, controller.signal)
        if (controller.signal.aborted) return
        setItems(rows)
        if (rows.some(item => item.latestRun?.status === 'QUEUED' || item.latestRun?.status === 'RUNNING')) timer = setTimeout(() => void load(), 10_000)
      } catch (cause) {
        if (controller.signal.aborted) return
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setError(errorMessage(cause))
      } finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [foreground, invalidateSession, revision, token]))
  return <Page refreshing={loading} onRefresh={refresh}>
    <Text style={styles.muted}>공고 2개를 비교해 신청·수혜 조건을 확인해요.</Text>
    {loading && items === null && <ActivityIndicator color={colors.primary} accessibilityLabel="검토 목록 불러오는 중" />}
    {error && <><Notice error>{error}</Notice><Button label="검토 목록 다시 확인" onPress={refresh} /></>}
    {items !== null && <Text style={styles.label}>중복 검토 {items.length}</Text>}
    {items?.length === 0 && !error && <Card><Text style={styles.heading}>아직 저장한 검토가 없어요</Text><Text style={styles.body}>공고 2개를 고르면 바로 분석할 수 있어요.</Text></Card>}
    {items?.map(item => <ReviewRow key={item.review.id} item={item} />)}
    <Button label="새 검토 시작" onPress={onNew} />
  </Page>
}

/**
 * 입력 단계예요. 공고 선택 다음이 바로 분석 확인(confirm)이고, 사업별 상태 · 관계 · 추가 설명은 그 단계의 "내 상황(선택)"에서 받아요.
 * analysis는 실행 결과 화면이에요. 예전 참여 상태 단계 주소(`step=participation`)는 라우트가 분석 확인으로 열어요.
 */
export type CombinationReviewStep = 'selection' | 'confirm' | 'analysis'
const scopeNotice = '두 공고를 함께 신청 · 수행할 수 있는지, 같은 과제 · 비용으로 두 번 받는 것은 아닌지 봐요. 다른 사업까지 합친 과거 수혜 이력 누적은 이 검토 범위 밖이에요.'

export function CombinationReviewEditorScreen({ id, runId, initialProgram, initialStep, onStepChange, onLogin, onOpenProgram }: {
  id: number | null; runId?: number; initialProgram?: SupportProgramIdentity; initialStep?: CombinationReviewStep; onLogin(): void
  onStepChange?(id: number, step: CombinationReviewStep): void; onOpenProgram(identity: SupportProgramIdentity): void
}) {
  const auth = useAuth()
  if (auth.status !== 'signedIn' || !auth.session) return <ReviewLogin onLogin={onLogin} />
  return <OwnedReviewEditor key={`${auth.session.accessToken}:${id ?? 'new'}:${runId ?? 'latest'}:${initialProgram?.sourceCode ?? ''}:${initialProgram?.sourceProgramId ?? ''}`} id={id} runId={runId} initialProgram={initialProgram}
    initialStep={initialStep} onStepChange={onStepChange} token={auth.session.accessToken} email={auth.session.account.email} onOpenProgram={onOpenProgram} />
}

function OwnedReviewEditor({ id, runId, initialProgram, initialStep, onStepChange, token, email, onOpenProgram }: {
  id: number | null; runId?: number; initialProgram?: SupportProgramIdentity; initialStep?: CombinationReviewStep; token: string; email: string
  onStepChange?(id: number, step: CombinationReviewStep): void; onOpenProgram(identity: SupportProgramIdentity): void
}) {
  const vm = useCombinationReview(token, email, id, runId)
  const { invalidateSession } = useAuth()
  const router = useRouter()
  const [step, setStep] = useState<CombinationReviewStep>(initialStep ?? (id ? 'analysis' : 'selection'))
  const [method, setMethod] = useState<'filter' | 'saved'>('filter')
  const [savedVisited, setSavedVisited] = useState(false)
  const [selectionVisited, setSelectionVisited] = useState(!id || initialStep === 'selection')
  const [names, setNames] = useState<Record<string, string>>({})
  const [nameError, setNameError] = useState<string | null>(null)
  const [nameRevision, setNameRevision] = useState(0)
  const initialSelected = useRef(false)
  const latest = useRef(vm); latest.current = vm
  const referencePrograms = [...new Map([...vm.draft.programs, ...(vm.run?.input.programs ?? [])].map(program => [reviewProgramKey(program), program])).values()]
  const programReferences = useRef(referencePrograms); programReferences.current = referencePrograms
  const signature = JSON.stringify(referencePrograms.map(reviewProgramKey))
  const initialSourceCode = initialProgram?.sourceCode
  const initialSourceProgramId = initialProgram?.sourceProgramId
  const locked = vm.busy || Boolean(vm.pending)
  useEffect(() => {
    if (!initialStep) return
    setStep(initialStep)
    if (initialStep === 'selection') setSelectionVisited(true)
  }, [initialStep])
  useEffect(() => {
    const controller = new AbortController()
    setNameError(null)
    const client = programClient(token)
    void Promise.all(programReferences.current.map(async program => {
      const key = reviewProgramKey(program)
      const detail = await client.getDetail({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId }, controller.signal)
      if (!detail) throw new Error('공고를 찾을 수 없어요.')
      if (!controller.signal.aborted) setNames(previous => ({ ...previous, [key]: detail.title }))
    })).catch(cause => { if (!controller.signal.aborted) {
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setNameError('선택한 공고의 이름을 확인하지 못했어요. 공식 정보를 다시 불러와 주세요.')
    } })
    return () => controller.abort()
  }, [invalidateSession, nameRevision, signature, token])
  useEffect(() => {
    if (id || !initialSourceCode || !initialSourceProgramId || initialSelected.current) return
    initialSelected.current = true
    const controller = new AbortController()
    const identity = { sourceCode: initialSourceCode, sourceProgramId: initialSourceProgramId }
    void programClient(token).getDetail(identity, controller.signal).then(program => {
      if (controller.signal.aborted || latest.current.draft.programs.length) return
      if (!program) throw new Error('공고를 찾을 수 없어요.')
      const reviewProgram: ReviewProgram = { ...identity, subProgramId: null, participation: unknownParticipation() }
      setNames(previous => ({ ...previous, [reviewProgramKey(reviewProgram)]: program.title }))
      vm.setDraft(previous => ({ ...previous, programs: [reviewProgram] }))
    }).catch(() => { if (!controller.signal.aborted) setNameError('출발한 공고를 확인하지 못했어요. 필터 검색에서 다시 선택해 주세요.') })
    return () => controller.abort()
  }, [id, initialSourceCode, initialSourceProgramId, token, vm.setDraft])

  const name = (program: ReviewProgram, index: number) => names[reviewProgramKey(program)] ?? `사업 ${index + 1} · 공고명 확인 필요`
  function toggle(program: SupportProgram) {
    if (locked) return
    const identity = { sourceCode: program.sourceCode, sourceProgramId: program.id, subProgramId: null }
    const key = reviewProgramKey(identity)
    setNames(previous => ({ ...previous, [key]: program.title }))
    vm.setDraft(previous => ({ ...previous, programs: previous.programs.some(item => reviewProgramKey(item) === key)
      ? previous.programs.filter(item => reviewProgramKey(item) !== key)
      : previous.programs.length < 2 ? [...previous.programs, { ...identity, participation: unknownParticipation() }] : previous.programs }))
  }
  function changeStep(next: CombinationReviewStep, savedId = vm.review?.id) {
    vm.setError(null); if (next === 'selection') setSelectionVisited(true); setStep(next)
    if (savedId) onStepChange?.(savedId, next)
  }
  async function saveStep(next: CombinationReviewStep) {
    const saved = await vm.saveInputs()
    if (saved) changeStep(next, saved.id)
  }
  function reload() {
    Alert.alert('최신 저장 입력을 사용할까요?', '현재 작성 중인 내용은 저장된 입력으로 바뀝니다.', [
      { text: '취소', style: 'cancel' }, { text: '불러오기', onPress: () => { vm.reloadInputs(); changeStep('confirm') } },
    ])
  }
  async function start(same = false) { if (await vm.start(same)) changeStep('analysis') }
  /** 바뀐 입력(내 상황 포함)을 저장한 뒤 그 버전으로 새 분석을 접수하고 결과 화면에서 새 실행을 보여 줘요. */
  async function saveAndStart(additionalFacts?: string) { if (await vm.saveAndStart(additionalFacts)) changeStep('analysis') }
  function supplement() { if (vm.run) vm.setFacts(vm.run.input.additionalFacts); changeStep('confirm') }
  const setSituation = (situation: ReviewSituation) => vm.setDraft(previous => ({ ...previous, programs: situation.programs, relation: situation.relation }))
  const unsupported = vm.draft.programs.some(program => !supportsAutomaticReview(program))
  const progress = <View style={local.steps}>{(['selection', 'confirm'] as const).map((value, index) => <Text key={value}
    style={[styles.muted, value === step && local.current]}>{index + 1}. {value === 'selection' ? '공고 선택' : '분석 확인'}</Text>)}</View>
  const saveHint = <Text accessibilityLiveRegion="polite" style={styles.muted}>{vm.saving ? '저장 중…' : vm.saveError ? '저장하지 못했어요. 입력은 이 화면에 유지됩니다.'
    : vm.review && !vm.dirty ? '제목·공고·내 상황 저장됨' : step === 'confirm' ? '바꾼 입력은 검토 실행 전에 저장돼요.' : '다음 단계로 넘어가면 입력이 저장돼요.'}</Text>
  const selectionHeader = <View style={local.selectionHeader}>{progress}{saveHint}<Field label="검토 제목" value={vm.draft.title} maxLength={200} editable={!locked}
    placeholder="예: 창업·기술개발 사업 함께 지원하기" onChangeText={title => vm.setDraft(previous => ({ ...previous, title }))} />
    <Card><View style={styles.row}><Text style={styles.label}>비교할 공고</Text><StatusBadge label={vm.draft.programs.length > 2 ? `기존 공고 ${vm.draft.programs.length}개` : `${vm.draft.programs.length} / 2 선택`} /></View>
      {vm.draft.programs.length > 2 && <Notice>기존 결과는 볼 수 있지만 새 분석은 공고를 2개로 줄여야 해요.</Notice>}
      {vm.draft.programs.map((program, index) => <View key={reviewProgramKey(program)} style={local.selected}><Text style={[styles.muted, { flex: 1 }]}>{name(program, index)}</Text>
        <Button label="해제" accessibilityLabel={`${name(program, index)} 비교 대상 해제`} variant="ghost" disabled={locked} onPress={() => vm.setDraft(previous => ({ ...previous, programs: previous.programs.filter(item => reviewProgramKey(item) !== reviewProgramKey(program)) }))} /></View>)}
    </Card>
    <SegmentedControl label="공고 선택 방법" options={[{ value: 'filter', label: '필터 검색' }, { value: 'saved', label: '관심 공고함' }]}
      value={method} onChange={value => { setMethod(value as typeof method); if (value === 'saved') setSavedVisited(true) }} />
  </View>
  return <View style={{ flex: 1 }}>
    {vm.loading && <ActivityIndicator accessibilityLabel="검토 불러오는 중" color={colors.primary} />}
    {vm.error && <View style={local.notice}><Notice error>{vm.error}</Notice><Button label="저장된 검토·보관 요청 다시 확인" variant="ghost" onPress={vm.refresh} />
      {vm.review && <Button label="최신 저장 입력 불러오기" variant="ghost" onPress={reload} />}</View>}
    {nameError && <View style={local.notice}><Notice error>{nameError}</Notice><Button label="공고 정보 다시 확인" variant="ghost" onPress={() => setNameRevision(value => value + 1)} /></View>}
    {vm.pending && <View style={local.notice}><Notice>완료 여부를 확인하지 못한 분석 요청이 있어요. 입력과 요청 키를 바꾸지 않고 같은 요청으로 확인합니다.</Notice>
      {vm.pending.reviewId !== (vm.review?.id ?? id) ? <Button label="미확인 요청의 검토 열기" onPress={() => router.replace({ pathname: '/all/reviews/[id]', params: { id: String(vm.pending!.reviewId) } })} />
        : <Button label="같은 요청으로 확인" busy={vm.busy} onPress={() => void start(true)} />}</View>}
    {selectionVisited && <View style={[local.panel, step !== 'selection' && local.hidden]} accessibilityElementsHidden={step !== 'selection'}
      importantForAccessibility={step === 'selection' ? 'auto' : 'no-hide-descendants'} pointerEvents={step === 'selection' ? 'auto' : 'none'}>
      <View style={[local.panel, method !== 'filter' && local.hidden]} accessibilityElementsHidden={method !== 'filter'} importantForAccessibility={method === 'filter' ? 'auto' : 'no-hide-descendants'} pointerEvents={method === 'filter' ? 'auto' : 'none'}>
        <CatalogScreen header={selectionHeader} onOpenProgram={onOpenProgram} selection={{ keys: vm.selectedKeys, disabled: locked, onToggle: toggle }} /></View>
      {savedVisited && <View style={[local.panel, method !== 'saved' && local.hidden]} accessibilityElementsHidden={method !== 'saved'} importantForAccessibility={method === 'saved' ? 'auto' : 'no-hide-descendants'} pointerEvents={method === 'saved' ? 'auto' : 'none'}>
        <ReviewSavedPrograms header={selectionHeader} token={token} keys={vm.selectedKeys} disabled={locked} onToggle={toggle} onOpen={onOpenProgram} /></View>}
    </View>}
    {step === 'confirm' && <Page key="confirm">{progress}{saveHint}<Title>이 내용으로 검토할까요?</Title>
      <Notice>{scopeNotice}</Notice>
      <Card><Text accessibilityRole="header" style={styles.heading}>분석 대상 공고</Text>
        {vm.draft.programs.map((program, index) => <Text key={reviewProgramKey(program)} style={styles.body}>사업 {index + 1} · {names[reviewProgramKey(program)] ?? '공고명 확인 필요'}</Text>)}
      </Card>
      <Card>
        <View style={styles.row}><Text accessibilityRole="header" style={styles.heading}>내 상황</Text><StatusBadge label="선택" /></View>
        <Text style={styles.muted}>모두 비워 둬도 분석할 수 있어요. 고르면 조건에 따라 갈리는 답을 내 상황에 맞춰 좁혀요.</Text>
        <ReviewSituationFields value={vm.draft} names={names} disabled={locked} onChange={setSituation} />
        <Field label="추가로 알려줄 내용 (선택)" multiline value={vm.facts} onChangeText={vm.setFacts} editable={!locked} maxLength={8000}
          placeholder="예: 두 사업에서 같은 인건비를 사용하려고 해요." style={{ minHeight: 110, textAlignVertical: 'top' }} />
        <Text style={styles.muted}>{vm.facts.length} / 8000 · 추가 설명은 검토 실행을 요청할 때 이 실행에만 저장돼요.</Text>
        {vm.dirty && <Notice>바꾼 내 상황은 [검토 실행]을 누르면 저장한 뒤 분석해요.</Notice>}
      </Card>
      {unsupported && <Notice error>선택한 공고는 현재 자동 분석을 지원하지 않아요. 다른 공고를 선택하거나 공식 원문을 확인해 주세요.</Notice>}
      <Notice>공식 원문을 바탕으로 AI가 분석하며 사용 비용이 발생할 수 있어요. 접수된 분석은 앱을 닫아도 이어집니다. 결과는 신청 자격이나 동시 수혜를 보장하지 않습니다.</Notice>
      {vm.startBlocked && <Text testID="review-start-reason" accessibilityLiveRegion="polite" style={styles.muted}>{vm.startBlocked}</Text>}
    </Page>}
    {/* 새 실행을 접수하거나 다른 실행을 고르면 화면을 새로 그려 맨 위의 진행 상태부터 보여 줘요. */}
    {step === 'analysis' && <Page key={`analysis:${vm.selectedRunId ?? 'latest'}`}><Title>{vm.review?.title ?? '공고 분석'}</Title>
      {vm.busy && <ActivityIndicator color={colors.primary} accessibilityLabel="분석 요청 확인 중" />}
      {!vm.loading && !vm.error && !vm.run && !vm.runs.length && <Notice>아직 분석 결과가 없어요. 입력을 확인한 뒤 명시적으로 분석을 요청해 주세요.</Notice>}
      {vm.runs.length > 0 && <ChoiceField label="실행 결과 선택" value={String(vm.selectedRunId ?? vm.runs[0].id)}
        options={[...(vm.selectedRunId && !vm.runs.some(item => item.id === vm.selectedRunId) ? [{ value: String(vm.selectedRunId), label: `실행 ${vm.selectedRunId} · 결과 확인` }] : []), ...vm.runs.map(item => ({ value: String(item.id), label: `실행 ${item.id} · ${reviewRunLabels[item.status]} · ${reviewTime(item.startedAt)} · 입력 ${item.inputRevision}` }))]}
        onChange={value => vm.selectRun(Number(value))} />}
      {vm.cursor && <Button label="이전 실행 더 보기" variant="secondary" disabled={vm.busy} onPress={() => void vm.moreRuns()} />}
      {vm.run && <ReviewResult key={vm.run.id} run={vm.run} names={names} currentRevision={vm.currentRevision} onSupplement={supplement} onRefresh={vm.refresh}
        narrowing={vm.review && <ReviewNarrowingPanel value={vm.draft} names={names} dirty={vm.dirty} busy={vm.busy} disabled={vm.loading || !vm.storageReady}
          blocked={vm.startBlocked} onChange={setSituation} onSubmit={() => void saveAndStart(vm.run!.input.additionalFacts)} />}
        reanalyze={vm.review && <Reanalyze busy={vm.busy} disabled={vm.loading || !vm.storageReady} blocked={vm.startBlocked}
          onPress={() => void saveAndStart(vm.run!.input.additionalFacts)} />} />}
      {!vm.pending && <Button label="입력 수정하기" variant="secondary" disabled={vm.busy} onPress={supplement} />}
    </Page>}
    {step === 'confirm' && <FeatureUsageLine token={token} feature="COMBINATION_REVIEW" revision={vm.busy} />}
    {step !== 'analysis' && <View style={local.actions}>
      {step === 'selection' && <Button style={local.action} label="다음 · 분석 확인" busy={vm.saving} disabled={locked || vm.loading || !vm.draft.title.trim() || vm.draft.programs.length !== 2} onPress={() => void saveStep('confirm')} />}
      {/* 이전 단계로 갈 때도 바꾼 내 상황을 저장해요. [검토 실행]은 바뀐 입력을 먼저 저장(입력 버전 확인)한 뒤 그 버전으로 분석을 접수해요. */}
      {step === 'confirm' && <><Button style={local.action} label="공고 선택으로" variant="secondary" disabled={locked || vm.loading} onPress={() => void saveStep('selection')} /><Button style={local.action} label="검토 실행"
        busy={vm.busy} disabled={vm.loading || !vm.storageReady || !vm.review || Boolean(vm.startBlocked)} onPress={() => void saveAndStart()} /></>}
    </View>}
  </View>
}

/**
 * 지난 여섯 단계 결과에 붙는 [새 방식으로 다시 분석]이에요. 지금 저장된 입력으로 새 분석을 한 번 접수하고, 분석 방식은 서버가 정해요.
 * 지금 보낼 수 없으면 이유를 버튼 위에 적어요.
 */
function Reanalyze({ busy, disabled, blocked, onPress }: { busy: boolean; disabled: boolean; blocked: string | null; onPress(): void }) {
  return <View style={local.reanalyze}>
    {blocked && <Text testID="review-reanalyze-reason" accessibilityLiveRegion="polite" style={styles.muted}>{blocked}</Text>}
    <Button label="새 방식으로 다시 분석" variant="secondary" busy={busy} disabled={disabled || Boolean(blocked)} onPress={onPress} />
  </View>
}

const local = StyleSheet.create({
  panel: { flex: 1 }, hidden: { display: 'none' }, selectionHeader: { gap: 12 }, action: { flex: 1 },
  selected: { backgroundColor: colors.soft, borderRadius: 10, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  steps: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 }, current: { color: colors.primary, fontWeight: '600' },
  actions: { paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface, flexDirection: 'row', justifyContent: 'space-evenly', gap: 8 },
  notice: { padding: 12, gap: 6 }, reanalyze: { gap: 6 },
})
