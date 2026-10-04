import { useCallback, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { ApplicationPreparationSummary, ApplicationPreparationListStatus, ApplicationDocumentGenerationJob, ApplicationFormDiscoveryJob } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { generationFailureTitle } from '@govbiz/shared/domain/entities/ApplicationDocumentGeneration'
import { useAuth } from '../auth/session'
import { applicationPreparationUseCase, discardDeletedPendingPreparation } from '../api/applicationPreparation'
import { getApiBaseUrl } from '../api/client'
import { readPendingPreparation, type PendingPreparationRequest } from '../auth/preparationPending'
import { PreparationAccess } from '../components/ApplicationPreparationUi'
import { SegmentedControl } from '../components/SegmentedControl'
import { useAppForeground } from '../components/useAppForeground'
import { Button, Card, Notice, Page, StatusBadge, colors, styles } from '../ui'

type Props = { onLogin(): void; onNew(identity?: { sourceCode: string; sourceProgramId: string }): void; onOpen(id: number, documents: boolean): void }
const active = (status: string) => status === 'QUEUED' || status === 'RUNNING' || status === 'UNKNOWN'
export function ApplicationDocumentsListScreen(props: Props) {
  const auth = useAuth()
  if (auth.status !== 'signedIn' || !auth.session) return <PreparationAccess onLogin={props.onLogin} />
  return <OwnedList key={auth.session.accessToken} token={auth.session.accessToken} email={auth.session.account.email} {...props} />
}
function OwnedList({ token, email, onNew, onOpen }: Props & { token: string; email: string }) {
  const { invalidateSession } = useAuth()
  const useCase = useMemo(() => applicationPreparationUseCase(token), [token])
  const [filter, setFilter] = useState<'all' | ApplicationPreparationListStatus>('all')
  const [items, setItems] = useState<ApplicationPreparationSummary[] | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const [jobs, setJobs] = useState<ApplicationDocumentGenerationJob[]>([])
  const [analysis, setAnalysis] = useState<ApplicationFormDiscoveryJob[]>([])
  const [pending, setPending] = useState<PendingPreparationRequest | null>(null)
  const [management, setManagement] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [checkingPending, setCheckingPending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const mutation = useRef<AbortController | null>(null)
  const foreground = useAppForeground()
  const refresh = () => setRevision(value => value + 1)
  const reportError = useCallback((cause: unknown) => {
    if (cause instanceof ApplicationPreparationError && cause.status === 401) void invalidateSession().catch(() => undefined)
    setError(cause instanceof Error ? cause.message : '신청문서를 확인하지 못했어요.')
  }, [invalidateSession])
  useFocusEffect(useCallback(() => {
    if (!foreground) return
    const controller = new AbortController()
    setLoading(true); setError(null); setItems(null); setCursor(null)
    let timer: ReturnType<typeof setTimeout> | undefined
    const readJobs = async () => {
      const [documents, discovery] = await Promise.all([useCase.recentDocumentJobs(controller.signal), useCase.discoveryJobs(controller.signal)])
      if (controller.signal.aborted) return
      setJobs(documents); setAnalysis(discovery)
      if ([...documents, ...discovery].some(job => active(job.status))) timer = setTimeout(() => { void readJobs().catch(cause => { if (!controller.signal.aborted) reportError(cause) }) },
        [...documents, ...discovery].some(job => job.status === 'QUEUED' || job.status === 'RUNNING') ? 5000 : 30_000)
    }
    void Promise.all([useCase.list(filter === 'all' ? {} : { status: filter }, controller.signal), readJobs(), readPendingPreparation(getApiBaseUrl(), email)]).then(([page, , record]) => {
      if (!controller.signal.aborted) { setItems(page.items); setCursor(page.nextBeforeId); setPending(record) }
    }).catch(cause => { if (!controller.signal.aborted) reportError(cause) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => {
      controller.abort(); mutation.current?.abort(); mutation.current = null
      setDeleting(null); setCheckingPending(false); clearTimeout(timer)
    }
  }, [foreground, filter, revision, reportError, useCase, email]))
  async function checkPending() {
    if (!pending || checkingPending || deleting !== null) return
    const controller = new AbortController(); mutation.current = controller
    setCheckingPending(true); setError(null); setNotice(null)
    try {
      await discardDeletedPendingPreparation(token, email, pending, controller.signal)
      if (!controller.signal.aborted) { setPending(null); setNotice('대상 문서가 없어 보관 요청을 정리했어요. 새 신청문서를 작성할 수 있어요.'); refresh() }
    } catch (cause) { if (!controller.signal.aborted) reportError(cause) }
    finally { if (mutation.current === controller) { mutation.current = null; setCheckingPending(false) } }
  }
  async function more() {
    if (!cursor || loading || deleting || checkingPending) return
    const controller = new AbortController(); mutation.current = controller
    setLoading(true); setError(null)
    try {
      const page = await useCase.list({ beforeId: cursor, ...(filter === 'all' ? {} : { status: filter }) }, controller.signal)
      if (!controller.signal.aborted) { setItems(previous => [...(previous ?? []), ...page.items.filter(item => !previous?.some(existing => existing.id === item.id))]); setCursor(page.nextBeforeId) }
    } catch (cause) { if (!controller.signal.aborted) reportError(cause) }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  function remove(item: ApplicationPreparationSummary) {
    Alert.alert('이 신청문서를 삭제할까요?', `${item.formTitle}\n${item.programTitle}\n\n이 문서의 저장 답변과 생성 파일이 함께 삭제돼요. 관심 공고와 다른 신청 문서는 유지돼요.`, [
      { text: '취소', style: 'cancel' }, { text: '문서 삭제', style: 'destructive', onPress: () => { void (async () => {
        if (deleting || checkingPending) return
        const controller = new AbortController(); mutation.current = controller
        setDeleting(item.id); setError(null)
        try { await useCase.delete(item.id, controller.signal); if (!controller.signal.aborted) { setItems(previous => previous?.filter(row => row.id !== item.id) ?? null); refresh() } }
        catch (cause) { if (!controller.signal.aborted) reportError(cause) }
        finally { if (mutation.current === controller) { mutation.current = null; setDeleting(null) } }
      })() } },
    ])
  }
  return <Page refreshing={loading && items !== null} onRefresh={refresh}>
    <View style={styles.row}><Text style={[styles.muted, { flex: 1 }]}>{items === null ? '신청 문서' : `${items.length}${cursor ? '+' : ''}개의 신청 문서`}</Text>
      <Button label={management ? '관리 완료' : '문서 관리'} variant="ghost" disabled={deleting !== null} onPress={() => setManagement(!management)} /></View>
    <SegmentedControl label="문서 상태" value={filter} onChange={value => setFilter(value)} options={[
      { value: 'all', label: '전체' }, { value: 'in_progress', label: '작성 중' }, { value: 'done', label: '초안 완료' },
    ]} />
    {management && <Notice>각 문서의 삭제 버튼을 누르면 삭제 전에 한 번 더 확인해요.</Notice>}
    {notice && <Notice>{notice}</Notice>}
    {error && <><Notice error>{error}</Notice><Button label="다시 확인" variant="secondary" onPress={refresh} /></>}
    {loading && items === null && <ActivityIndicator accessibilityLabel="신청문서 불러오는 중" color={colors.primary} />}
    {pending && <Card><Text style={styles.heading}>이전 요청 결과를 확인해 주세요</Text><Text style={styles.muted}>접수 여부를 확인하지 못한 요청을 기기에 보관했어요. 같은 요청으로 확인하면 중복 실행을 방지할 수 있어요.</Text>
      <Button label="미확인 요청 이어서 확인" variant="secondary" disabled={checkingPending} onPress={() => pending.kind === 'document' ? onOpen(pending.preparationId, true) : onNew({ sourceCode: pending.sourceCode, sourceProgramId: pending.sourceProgramId })} />
      {pending.kind === 'document' && <Button label="보관 요청 대상 확인" variant="ghost" busy={checkingPending} disabled={deleting !== null} onPress={() => void checkPending()} />}</Card>}
    {analysis.filter(job => active(job.status) || job.seen === false && Date.now() - Date.parse(job.createdAt) < 86_400_000).map(job => <Card key={`analysis-${job.id}`}>
      <View style={styles.row}><StatusBadge label={job.status === 'UNKNOWN' ? '결과 확인 필요' : job.status === 'FAILED' ? '분석 실패' : job.status === 'SUCCEEDED' ? '분석 결과 확인' : '양식 분석 중'} tone="info" /></View>
      <Text style={styles.heading}>{job.programTitle}</Text><Button label="양식 분석 이어서 확인" variant="secondary" onPress={() => onNew({ sourceCode: job.sourceCode, sourceProgramId: job.sourceProgramId })} />
    </Card>)}
    {items?.map(item => {
      const job = jobs.filter(candidate => candidate.preparationId === item.id).sort((a, b) => b.id - a.id)[0]
      const working = job && active(job.status)
      const completed = item.hasCurrentDocument || job?.status === 'SUCCEEDED' && job.expectedRevision === item.inputRevision
      return <Card key={item.id}><View style={styles.row}><StatusBadge label={working ? job.status === 'UNKNOWN' ? '결과 확인 필요' : '초안 만드는 중' : job?.status === 'FAILED' ? '생성 실패' : completed ? '초안 완료' : '작성 중'} tone={completed && !working ? 'success' : working ? 'info' : 'neutral'} /></View>
        <Text style={styles.heading}>{item.formTitle}</Text><Text style={styles.muted}>{item.programTitle}</Text>
        {item.requiredTotal !== undefined && <Text style={styles.muted}>필수 답변 {item.answeredRequired ?? 0} / {item.requiredTotal}</Text>}
        {item.requiredTotal !== undefined && item.requiredTotal > 0 && <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: item.requiredTotal, now: item.answeredRequired ?? 0 }} style={{ height: 5, borderRadius: 8, backgroundColor: colors.track }}>
          <View style={{ height: 5, borderRadius: 8, backgroundColor: colors.primary, width: `${Math.min(100, (item.answeredRequired ?? 0) / item.requiredTotal * 100)}%` }} /></View>}
        {job?.status === 'FAILED' && <Text style={styles.muted}>{generationFailureTitle(job)}</Text>}
        {job?.seen === false && !working && <View style={styles.row}><StatusBadge label="확인하지 않은 결과" tone="info" /></View>}
        <Button label={working || job?.seen === false ? '생성 결과 확인' : completed ? '문서 보기' : '이어서 작성'} variant="secondary" onPress={() => onOpen(item.id, Boolean(working || job?.seen === false || completed))} />
        {management && <Button label="삭제" accessibilityLabel={`${item.formTitle} 삭제`} variant="danger" disabled={deleting !== null || checkingPending || Boolean(working) || loading || Boolean(error)} busy={deleting === item.id} onPress={() => remove(item)} />}
      </Card>
    })}
    {!loading && !error && items?.length === 0 && <Card><Text style={styles.heading}>아직 신청문서가 없어요</Text><Text style={styles.muted}>지원할 공고를 고르면 작성할 양식을 확인할 수 있어요.</Text></Card>}
    {cursor !== null && <Button label="이전 작업 더 보기" variant="secondary" busy={loading} disabled={deleting !== null || Boolean(error)} onPress={() => void more()} />}
    <Button label="새 신청문서" onPress={() => onNew()} />
  </Page>
}
