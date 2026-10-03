import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Crypto from 'expo-crypto'
import type { ApplicationForm, ApplicationFormDiscoveryJob, ApplicationFormAvailability, ApplicationServiceField } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import { applicationServiceFieldLabels } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import type { SupportProgram, SupportProgramDetail } from '@govbiz/shared/domain/entities/SupportProgram'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { useAuth } from '../auth/session'
import { readPendingPreparation, savePendingPreparation, clearPendingPreparation, type PendingPreparationRequest } from '../auth/preparationPending'
import { applicationPreparationUseCase } from '../api/applicationPreparation'
import { getApiBaseUrl, programClient } from '../api/client'
import { PreparationAccess, PreparationSteps, preparationUi } from '../components/ApplicationPreparationUi'
import { SegmentedControl } from '../components/SegmentedControl'
import { ReviewSavedPrograms } from '../components/ReviewSavedPrograms'
import { ChoiceField } from '../components/ChoiceField'
import { CatalogScreen } from './CatalogScreen'
import { Button, Card, Notice, Page, StatusBadge, colors, styles } from '../ui'

type Props = { initialProgram?: SupportProgramIdentity; onLogin(): void; onOpenProgram(identity: SupportProgramIdentity): void; onCreated(id: number): void; onList(): void; onPendingDocument(id: number): void }
const labels = { selected: '✓ 작성 대상 선택됨', select: '작성할 공고로 선택' }
const terminal = (job: ApplicationFormDiscoveryJob) => job.status !== 'QUEUED' && job.status !== 'RUNNING'
export function ApplicationPreparationNewScreen(props: Props) {
  const auth = useAuth()
  if (auth.status !== 'signedIn' || !auth.session) return <PreparationAccess onLogin={props.onLogin} />
  return <OwnedNew key={auth.session.accessToken} token={auth.session.accessToken} email={auth.session.account.email} {...props} />
}
function OwnedNew({ token, email, initialProgram, onOpenProgram, onCreated, onList, onPendingDocument }: Props & { token: string; email: string }) {
  const { invalidateSession } = useAuth()
  const insets = useSafeAreaInsets()
  const useCase = useMemo(() => applicationPreparationUseCase(token), [token])
  const [step, setStep] = useState<'selection' | 'form'>('selection')
  const [method, setMethod] = useState<'filter' | 'saved'>('filter')
  const [savedVisited, setSavedVisited] = useState(false)
  const [program, setProgram] = useState<SupportProgram | SupportProgramDetail | null>(null)
  const [forms, setForms] = useState<ApplicationForm[]>([])
  const [formId, setFormId] = useState('')
  const [field, setField] = useState<ApplicationServiceField>('GENERAL')
  const [availability, setAvailability] = useState<ApplicationFormAvailability | null>(null)
  const [job, setJob] = useState<ApplicationFormDiscoveryJob | null>(null)
  const [jobs, setJobs] = useState<ApplicationFormDiscoveryJob[]>([])
  const [pending, setPending] = useState<PendingPreparationRequest | null>(null)
  const [pendingReady, setPendingReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const request = useRef<AbortController | null>(null)
  const guard = useRef(false)
  const base = getApiBaseUrl()
  const reportError = useCallback((cause: unknown) => {
    if (cause instanceof ApplicationPreparationError && cause.status === 401) void invalidateSession().catch(() => undefined)
    setError(cause instanceof Error ? cause.message : '신청 양식을 확인하지 못했어요.')
  }, [invalidateSession])
  const applyForms = (items: ApplicationForm[]) => { setForms(items); setFormId(items[0]?.formVersionId ?? ''); setField(items[0]?.supportedServiceFields[0] ?? 'GENERAL') }
  useEffect(() => {
    let active = true
    void readPendingPreparation(base, email).then(value => { if (active) { setPending(value); setPendingReady(true) } }).catch(cause => { if (active) reportError(cause) })
    return () => { active = false; request.current?.abort() }
  }, [base, email, reportError])
  useEffect(() => {
    if (!initialProgram) return
    const controller = new AbortController()
    void programClient(token).getDetail(initialProgram, controller.signal).then(result => {
      if (controller.signal.aborted) return
      if (!result) throw new Error('출발한 공고를 찾지 못했어요. 필터 검색에서 다시 선택해 주세요.')
      setProgram(result); setStep('form')
    }).catch(cause => { if (!controller.signal.aborted) reportError(cause) })
    return () => controller.abort()
  }, [initialProgram?.sourceCode, initialProgram?.sourceProgramId, reportError, token])
  const source = program?.sourceCode, sourceId = program?.id
  useFocusEffect(useCallback(() => {
    if (step !== 'form' || !source || !sourceId) return
    const controller = new AbortController(); request.current?.abort(); request.current = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoading(true); setError(null); setJob(null); setAvailability(null); applyForms([])
    const follow = async (candidate: ApplicationFormDiscoveryJob) => {
      if (controller.signal.aborted) return
      setJob(candidate)
      if (candidate.status === 'SUCCEEDED' && candidate.result) applyForms(candidate.result.items)
      if (!terminal(candidate)) timer = setTimeout(() => { void useCase.discoveryJob(candidate.id, controller.signal).then(follow).catch(cause => { if (!controller.signal.aborted) reportError(cause) }) }, 2000)
    }
    void (async () => {
      const [stored, recent] = await Promise.all([useCase.availability(source, sourceId, controller.signal), useCase.discoveryJobs(controller.signal)])
      if (controller.signal.aborted) return
      setAvailability(stored); applyForms(stored.forms.items); setJobs(recent)
      const own = recent.filter(candidate => candidate.sourceCode === source && candidate.sourceProgramId === sourceId).sort((a, b) => b.id - a.id)[0]
      if (own) await follow(own)
      await useCase.markDiscoveryJobsSeen(source, sourceId, controller.signal)
    })().catch(cause => { if (!controller.signal.aborted) reportError(cause) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); clearTimeout(timer) }
  }, [step, source, sourceId, revision, reportError, useCase]))
  function toggle(next: SupportProgram) { if (busy) return; setProgram(previous => previous?.sourceCode === next.sourceCode && previous.id === next.id ? null : next) }
  async function analyze() {
    if (!program || !pendingReady || guard.current || loading || job && !terminal(job)) return
    if (job?.status === 'UNKNOWN') { setError('이전 분석 결과를 먼저 확인해 주세요. 새 분석을 시작하지 않았어요.'); return }
    const record: PendingPreparationRequest = pending ?? { kind: 'discovery', sourceCode: program.sourceCode, sourceProgramId: program.id, requestKey: Crypto.randomUUID() }
    if (record.kind !== 'discovery' || record.sourceCode !== program.sourceCode || record.sourceProgramId !== program.id) { setError('다른 문서의 미확인 요청이 있어요. 해당 문서에서 먼저 확인해 주세요.'); return }
    guard.current = true; setBusy(true); setError(null)
    const controller = new AbortController(); request.current?.abort(); request.current = controller
    try {
      await savePendingPreparation(base, email, record); if (controller.signal.aborted) return
      setPending(record)
      const accepted = await useCase.discover(record.sourceCode, record.sourceProgramId, controller.signal, record.requestKey)
      if (controller.signal.aborted) return
      await clearPendingPreparation(base, email); if (controller.signal.aborted) return
      setPending(null); setJob(accepted); setRevision(value => value + 1)
    } catch (cause) { if (!controller.signal.aborted) {
      reportError(cause)
      if (cause instanceof ApplicationPreparationError && cause.status >= 400 && cause.status < 500 && cause.status !== 408) {
        await clearPendingPreparation(base, email).then(() => setPending(null)).catch(reportError)
      }
    } } finally { guard.current = false; if (!controller.signal.aborted) setBusy(false) }
  }
  const form = forms.find(candidate => candidate.formVersionId === formId)
  async function create() {
    if (!program || !form || guard.current || loading) return
    guard.current = true; setBusy(true); setError(null)
    const controller = new AbortController(); request.current?.abort(); request.current = controller
    try {
      const created = await useCase.create({ sourceCode: program.sourceCode, sourceProgramId: program.id, formVersionId: form.formVersionId, serviceField: field }, controller.signal)
      if (!controller.signal.aborted) onCreated(created.id)
    } catch (cause) { if (!controller.signal.aborted) reportError(cause) }
    finally { guard.current = false; if (!controller.signal.aborted) setBusy(false) }
  }
  const selected = program ? [`${program.sourceCode}:${program.id}`] : []
  const header = <View style={{ gap: 12 }}><PreparationSteps active={0} /><Card><View style={styles.row}><Text style={[styles.label, { flex: 1 }]}>작성할 공고</Text><StatusBadge label={`${program ? 1 : 0} / 1 선택`} /></View>
    {program ? <View style={preparationUi.selected}><Text style={[styles.muted, { flex: 1 }]}>{program.title}</Text><Button label="해제" variant="ghost" disabled={busy} onPress={() => setProgram(null)} /></View>
      : <Text style={styles.muted}>신청문서를 작성할 공고 한 건을 선택해 주세요.</Text>}</Card>
    <SegmentedControl label="공고 선택 방법" value={method} options={[{ value: 'filter', label: '필터 검색' }, { value: 'saved', label: '관심 공고함' }]}
      onChange={value => { setMethod(value); if (value === 'saved') setSavedVisited(true) }} />{error && <Notice error>{error}</Notice>}</View>
  return <View style={{ flex: 1 }}>
    <View style={[{ flex: 1 }, step !== 'selection' && { display: 'none' }]} accessibilityElementsHidden={step !== 'selection'} importantForAccessibility={step === 'selection' ? 'auto' : 'no-hide-descendants'} pointerEvents={step === 'selection' ? 'auto' : 'none'}>
      <View style={[{ flex: 1 }, method !== 'filter' && { display: 'none' }]} accessibilityElementsHidden={method !== 'filter'} importantForAccessibility={method === 'filter' ? 'auto' : 'no-hide-descendants'} pointerEvents={method === 'filter' ? 'auto' : 'none'}>
        <CatalogScreen header={header} onOpenProgram={onOpenProgram} selection={{ keys: selected, maximum: 1, disabled: busy, labels, onToggle: toggle }} /></View>
      {savedVisited && <View style={[{ flex: 1 }, method !== 'saved' && { display: 'none' }]} accessibilityElementsHidden={method !== 'saved'} importantForAccessibility={method === 'saved' ? 'auto' : 'no-hide-descendants'} pointerEvents={method === 'saved' ? 'auto' : 'none'}>
        <ReviewSavedPrograms header={header} token={token} keys={selected} maximum={1} labels={labels} disabled={busy} onToggle={toggle} onOpen={onOpenProgram} /></View>}
    </View>{step === 'form' && <Page><PreparationSteps active={0} />{program && <Card><Text style={styles.heading}>{program.title}</Text><Text style={styles.muted}>{program.organization}</Text><Button label="공고 바꾸기" variant="ghost" disabled={busy} onPress={() => setStep('selection')} />
      <Button label="공식 공고 원문" variant="ghost" onPress={() => void Linking.openURL(program.sourceUrl).catch(() => setError('공식 공고 원문을 열지 못했어요.'))} /></Card>}
      {error && <><Notice error>{error}</Notice><Button label="양식·작업 다시 확인" variant="secondary" disabled={busy} onPress={() => setRevision(value => value + 1)} /></>}
      {loading && <ActivityIndicator color={colors.primary} accessibilityLabel="양식 확인 중" />}
      {pending?.kind === 'document' && <><Notice>결과를 확인하지 못한 문서 생성 요청이 있어요. 새 유료 분석 전에 해당 요청을 확인해 주세요.</Notice><Button label="미확인 생성 문서 열기" variant="secondary" onPress={() => onPendingDocument(pending.preparationId)} /></>}
      {job && <Card><View style={styles.row}><StatusBadge label={job.status === 'QUEUED' ? '분석 대기' : job.status === 'RUNNING' ? '양식 분석 중' : job.status === 'UNKNOWN' ? '결과 확인 필요' : job.status === 'FAILED' ? '분석 실패' : '분석 완료'} tone="info" /></View>
        {job.status === 'FAILED' && <Notice error>{new ApplicationPreparationError(422, job.failureCode ?? 'DISCOVERY_FAILED').message}</Notice>}
        {job.status === 'UNKNOWN' && <Notice>분석 결과를 아직 확인하지 못했어요. 기존 결과를 조회하며 새 유료 분석을 자동으로 시작하지 않아요.</Notice>}
        {!terminal(job) && <Text style={styles.muted}>다른 화면을 봐도 작업은 이어져요.</Text>}
        {job.result?.warnings.map(warning => <Text key={warning} style={styles.muted}>{warning}</Text>)}
      </Card>}
      {!loading && availability && !forms.length && <Notice>저장된 작성 양식이 없어요. 공식 원문을 확인하거나 입력칸별 분석을 요청할 수 있어요.</Notice>}
      {forms.map(candidate => <Card key={candidate.formVersionId}><View style={styles.row}><Text style={[styles.heading, { flex: 1 }]}>{candidate.formTitle}</Text><StatusBadge label={candidate.formVersionId === formId ? '선택됨' : '작성 양식'} tone={candidate.formVersionId === formId ? 'success' : 'neutral'} /></View>
        <Text style={styles.muted}>{candidate.attachmentFileName}</Text><Button label={candidate.formVersionId === formId ? '선택한 양식' : '이 양식 선택'} variant="secondary" disabled={busy} onPress={() => { setFormId(candidate.formVersionId); setField(candidate.supportedServiceFields[0]) }} /></Card>)}
      {form && form.supportedServiceFields.length > 1 && <ChoiceField label="신청 분야" value={field} options={form.supportedServiceFields.map(value => ({ value, label: applicationServiceFieldLabels[value] }))} onChange={value => setField(value as ApplicationServiceField)} disabled={busy} />}
      <Text style={styles.muted}>양식 분석은 유료 AI를 사용해요. 저장된 양식으로 작성 시작만 하면 AI를 호출하지 않아요.</Text>
      <Button label={pending?.kind === 'discovery' ? '같은 분석 요청으로 확인' : forms.length ? '입력칸별 양식 다시 분석' : '입력칸별 양식 분석하기'} variant="secondary" disabled={!pendingReady || loading || busy || Boolean(job && (!terminal(job) || job.status === 'UNKNOWN'))} onPress={() => void analyze()} />
      {jobs.filter(candidate => candidate.status === 'QUEUED' || candidate.status === 'RUNNING' || candidate.status === 'UNKNOWN').length >= 3 && <Notice>진행 중이거나 확인이 필요한 분석이 3건이에요. 기존 작업을 먼저 확인해 주세요.</Notice>}
    </Page>}
    <View style={[preparationUi.footer, { paddingBottom: 12 + insets.bottom }]}>{step === 'selection'
      ? <Button label="다음 · 양식 확인" disabled={!program || busy} onPress={() => setStep('form')} />
      : <><Button label="이 양식으로 작성 시작" busy={busy} disabled={!form || loading} onPress={() => void create()} /><Button label="목록으로 돌아가기" variant="ghost" disabled={busy} onPress={onList} /></>}
    </View>
  </View>
}
