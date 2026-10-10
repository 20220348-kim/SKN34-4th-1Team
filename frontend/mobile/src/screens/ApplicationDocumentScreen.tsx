import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, AppState, Linking, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import * as Crypto from 'expo-crypto'
import type { ApplicationPreparation, ApplicationDocument, ApplicationDocumentGenerationJob } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import { generationStages, generationFailureTitle, failureGroupOf, applicationDraftMode } from '@govbiz/shared/domain/entities/ApplicationDocumentGeneration'
import { applicationDocumentFileFormat, applicationDocumentFileGroups } from '@govbiz/shared/domain/entities/ApplicationDocumentFiles'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { useAuth } from '../auth/session'
import { applicationPreparationUseCase, discardDeletedPendingPreparation, prepareApplicationDocumentDownload } from '../api/applicationPreparation'
import { getApiBaseUrl, programClient, readProgramDetail } from '../api/client'
import { clearPendingPreparation, readPendingPreparation, savePendingPreparation, type PendingPreparationRequest } from '../auth/preparationPending'
import { PartnerSheet } from '../components/PartnerSheet'
import { PreparationAccess } from '../components/ApplicationPreparationUi'
import { useAppForeground } from '../components/useAppForeground'
import { Button, Card, Notice, Page, StatusBadge, colors, styles } from '../ui'

type Props = { id: number; jobId?: number; onLogin(): void; onEditor(): void; onReanalyze(identity: { sourceCode: string; sourceProgramId: string }): void; onOnline(): void; onOpenPending(id: number): void }
const running = (job: ApplicationDocumentGenerationJob) => job.status === 'QUEUED' || job.status === 'RUNNING'
export function ApplicationDocumentScreen(props: Props) {
  const auth = useAuth()
  if (auth.status !== 'signedIn' || !auth.session) return <PreparationAccess onLogin={props.onLogin} />
  return <OwnedDocuments key={`${auth.session.accessToken}:${props.id}`} token={auth.session.accessToken} email={auth.session.account.email} {...props} />
}
function OwnedDocuments({ id, jobId, token, email, onEditor, onReanalyze, onOnline, onOpenPending }: Props & { token: string; email: string }) {
  const { invalidateSession } = useAuth()
  const useCase = useMemo(() => applicationPreparationUseCase(token), [token])
  const [preparation, setPreparation] = useState<ApplicationPreparation | null>(null)
  const [files, setFiles] = useState<ApplicationDocument[]>([])
  const [job, setJob] = useState<ApplicationDocumentGenerationJob | null>(null)
  const [pending, setPending] = useState<PendingPreparationRequest | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [googleFormAvailable, setGoogleFormAvailable] = useState(false)
  const [revision, setRevision] = useState(0)
  const [migrationOpen, setMigrationOpen] = useState(false)
  const [approved, setApproved] = useState(false)
  const [previousOpen, setPreviousOpen] = useState(false)
  const action = useRef<AbortController | null>(null)
  const downloadWork = useRef<AbortController | null>(null)
  const focused = useRef(false)
  const mounted = useRef(true)
  const locked = useRef(false)
  const base = getApiBaseUrl()
  const foreground = useAppForeground()
  useEffect(() => {
    if (foreground || !downloadWork.current) return
    downloadWork.current.abort(); downloadWork.current = null
    locked.current = false; setBusy(null)
  }, [foreground])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; action.current?.abort() } }, [])
  useFocusEffect(useCallback(() => {
    focused.current = true
    return () => {
      focused.current = false
      if (downloadWork.current) {
        downloadWork.current.abort(); downloadWork.current = null
        locked.current = false; setBusy(null)
      }
    }
  }, []))
  const reportError = useCallback((cause: unknown) => {
    if (cause instanceof ApplicationPreparationError && cause.status === 401) void invalidateSession().catch(() => undefined)
    setError(cause instanceof Error ? cause.message : '문서 결과를 확인하지 못했어요.')
  }, [invalidateSession])
  useFocusEffect(useCallback(() => {
    if (!foreground) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoading(true); setError(null); setGoogleFormAvailable(false)
    const follow = async (selected: ApplicationDocumentGenerationJob) => {
      if (controller.signal.aborted) return
      setJob(selected)
      if (running(selected) || selected.status === 'UNKNOWN') {
        timer = setTimeout(() => { void useCase.documentJob(id, selected.id, controller.signal).then(follow).catch(cause => { if (!controller.signal.aborted) reportError(cause) }) }, selected.status === 'UNKNOWN' ? 30_000 : 2000)
      } else {
        const output = await useCase.documents(id, controller.signal)
        if (!controller.signal.aborted) setFiles(output)
        await useCase.markDocumentJobsSeen(id, controller.signal)
      }
    }
    void (async () => {
      const record = await readPendingPreparation(base, email)
      if (controller.signal.aborted) return
      setPending(record)
      const [detail, stored, recent] = await Promise.all([useCase.get(id, controller.signal), useCase.documents(id, controller.signal), useCase.documentJobs(id, controller.signal)])
      if (controller.signal.aborted) return
      setPreparation(detail); setFiles(stored); setPending(record)
      // 문서 결과 조회로 외부 폼을 분석하지 않고, 카탈로그의 공식 신청 경로만 확인합니다.
      void readProgramDetail(programClient(token), { sourceCode: detail.form.sourceCode, sourceProgramId: detail.form.sourceProgramId }, controller.signal)
        .then(program => { if (!controller.signal.aborted) setGoogleFormAvailable(program?.applicationRoute.type === 'GOOGLE_FORMS') })
        .catch(() => { if (!controller.signal.aborted) setError('구글폼 신청 여부를 확인하지 못했어요. 다시 확인해 주세요.') })
      const latest = recent.find(candidate => running(candidate)) ?? recent.slice().sort((a, b) => b.id - a.id)[0]
      const selected = jobId ?? latest?.id
      if (selected) {
        const known = recent.find(candidate => candidate.id === selected)
        if (known) setJob(known)
        await follow(await useCase.documentJob(id, selected, controller.signal))
      } else setJob(null)
    })().catch(cause => { if (!controller.signal.aborted) reportError(cause) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); clearTimeout(timer) }
  }, [foreground, id, jobId, revision, useCase, base, email, token, reportError]))
  async function checkPending() {
    if (!pending || locked.current) return
    locked.current = true; setBusy('pending'); setError(null)
    const controller = new AbortController(); action.current = controller
    try {
      await discardDeletedPendingPreparation(token, email, pending, controller.signal)
      if (!controller.signal.aborted) { setPending(null); setNotice('대상 문서가 없어 보관 요청을 정리했어요. 목록에서 새 신청문서를 작성할 수 있어요.') }
    } catch (cause) { if (!controller.signal.aborted) reportError(cause) }
    finally { locked.current = false; if (!controller.signal.aborted && mounted.current) setBusy(null) }
  }
  async function download(file: ApplicationDocument) {
    if (locked.current || !preparation || !focused.current) return
    locked.current = true; setBusy(`save:${file.id}`); setError(null); setNotice(null)
    const controller = new AbortController(); downloadWork.current = controller
    try {
      const url = await prepareApplicationDocumentDownload(token, id, file.id, controller.signal)
      if (controller.signal.aborted || !mounted.current || !focused.current) return
      if (AppState.currentState === 'background' || AppState.currentState === 'inactive') return
      await Linking.openURL(url).catch(() => { throw new Error('다운로드 브라우저를 열지 못했어요. 다시 시도해 주세요.') })
      if (controller.signal.aborted || !mounted.current || !focused.current || downloadWork.current !== controller) return
      setNotice(`${file.fileName} 다운로드를 브라우저에서 열었어요. 브라우저의 다운로드 목록에서 확인해 주세요.`)
    } catch (cause) { if (!controller.signal.aborted) reportError(cause) }
    finally {
      if (downloadWork.current === controller) {
        downloadWork.current = null; locked.current = false
        if (!controller.signal.aborted && mounted.current) setBusy(null)
      }
    }
  }
  async function generate() {
    if (locked.current || !preparation || job && (running(job) || job.status === 'UNKNOWN')) return
    const record = pending ?? { kind: 'document' as const, preparationId: id, expectedRevision: preparation.inputRevision, requestKey: Crypto.randomUUID() }
    if (record.kind !== 'document' || record.preparationId !== id) { setError('미확인 요청의 문서에서 먼저 같은 요청으로 확인해 주세요.'); return }
    locked.current = true; setBusy('generate'); setError(null)
    const controller = new AbortController(); action.current = controller
    try {
      await savePendingPreparation(base, email, record); if (controller.signal.aborted) return
      setPending(record)
      const accepted = await useCase.submitDocumentJob(id, record.expectedRevision, controller.signal, record.requestKey)
      if (controller.signal.aborted) return
      setJob(accepted)
      await clearPendingPreparation(base, email); if (controller.signal.aborted) return
      setPending(null); setApproved(false); setRevision(value => value + 1)
    } catch (cause) { if (!controller.signal.aborted) {
      reportError(cause)
      if (cause instanceof ApplicationPreparationError && cause.status >= 400 && cause.status < 500 && cause.status !== 408) {
        await clearPendingPreparation(base, email).then(() => setPending(null)).catch(reportError)
      }
    } } finally { locked.current = false; if (!controller.signal.aborted && mounted.current) setBusy(null) }
  }
  async function approve() {
    if (!job?.mappingMigration || locked.current) return
    locked.current = true; setBusy('migration'); setError(null)
    const controller = new AbortController(); action.current = controller
    try {
      await useCase.confirmDocumentMappingMigration(id, job.mappingMigration.expectedRevision, job.mappingMigration.approvalToken, controller.signal)
      if (!controller.signal.aborted) { setMigrationOpen(false); setApproved(true); setNotice('새 입력 위치를 적용했어요. 답변을 확인한 뒤 다시 초안을 만들 수 있어요.') }
    } catch (cause) { if (!controller.signal.aborted) reportError(cause) }
    finally { locked.current = false; if (!controller.signal.aborted) setBusy(null) }
  }
  if (loading && !preparation) return <Page><ActivityIndicator accessibilityLabel="생성 결과 불러오는 중" color={colors.primary} /></Page>
  if (!preparation) return <Page><Notice error>{error ?? '신청문서를 확인하지 못했어요.'}</Notice>
    {notice && <Notice>{notice}</Notice>}
    {pending?.kind === 'document' && <Button label="보관 요청 대상 확인" variant="secondary" busy={busy === 'pending'} onPress={() => void checkPending()} />}
    <Button label="다시 확인" disabled={busy !== null} onPress={() => setRevision(value => value + 1)} /></Page>
  const currentFiles = files.filter(file => file.inputRevision === preparation.inputRevision)
  const { latestRevision, latestFiles, previousFiles, previousRevisions } = applicationDocumentFileGroups(files)
  const answersChanged = latestRevision !== null && !currentFiles.length
  const isRunning = Boolean(job && running(job)), unknown = job?.status === 'UNKNOWN'
  const group = job ? failureGroupOf(job) : null
  const missingRequired = preparation.form.sections.flatMap(section => section.fields.filter(field => field.required && field.documentWritable !== false && !section.facts.some(fact => fact.fieldKey === field.key)))
  const draftMode = applicationDraftMode(preparation.form.sections.flatMap(section => section.fields.map(field => ({
    field, value: section.facts.find(fact => fact.fieldKey === field.key && fact.status === 'PROVIDED')?.value,
  }))))
  const recoveringRequest = pending?.kind === 'document' && pending.preparationId === id
  const canGenerate = !loading && !isRunning && !unknown && (recoveringRequest ||
    !currentFiles.length &&
    (!job || job.expectedRevision !== preparation.inputRevision || approved || job.status === 'FAILED' && group === 'temporary'))
  const renderFile = (file: ApplicationDocument) => <Card key={file.id}><Text style={styles.heading}>{file.fileName}</Text><Text style={styles.muted}>{applicationDocumentFileFormat(file)} · {Math.ceil(file.size / 1024)} KB · 답변 버전 {file.inputRevision}</Text>
    {file.filledAnswerCount !== null && <Text style={styles.muted}>자동 기입 {file.filledAnswerCount}개 · 직접 작성 필요 {file.unfilledAnswerCount}개</Text>}
    {(file.remainingExampleCount ?? 0) > 0 && <Notice>직접 작성할 칸 {file.remainingExampleCount}곳에 예시 문구가 남아 있어요. 제출 전에 지워 주세요.</Notice>}
    {file.unfilledAnswers.map(answer => <View key={answer.fieldId} style={{ gap: 6 }}><Notice>{answer.fieldLabel}: {answer.reason === 'OVERFLOW'
      ? `칸보다 길어 넣지 못했어요.${answer.capacity ? ` 약 ${answer.capacity}자 이내로 줄여 주세요.` : ''}`
      : answer.reason === 'AMBIGUOUS_SLOT' ? '빈칸이 여러 개라 위치를 확인하지 못했어요. 원본 파일에서 직접 작성해 주세요.'
        : answer.reason === 'SLOT_MISMATCH' ? '인쇄된 선택지·날짜와 달라요. 원본 파일에서 직접 작성해 주세요.'
          : '원본 파일에서 직접 작성해 주세요.'}</Notice><Text style={styles.body}>{answer.value}</Text>
      <Button label="답변 복사" accessibilityLabel={`${answer.fieldLabel} 답변 복사`} variant="ghost" onPress={() => void Clipboard.setStringAsync(answer.value).then(() => setNotice('답변을 복사했어요.')).catch(() => setError('답변을 복사하지 못했어요.'))} /></View>)}
    <Button label="초안 다운로드" accessibilityLabel={`초안 다운로드: ${file.fileName}`} disabled={busy !== null} busy={busy === `save:${file.id}`} onPress={() => void download(file)} />
  </Card>
  return <Page refreshing={loading} onRefresh={() => setRevision(value => value + 1)}>
    <Card><Text style={styles.heading}>{preparation.form.programTitle}</Text><Text style={styles.muted}>{preparation.form.formTitle}</Text>
      {answersChanged && <View style={styles.row}><StatusBadge label="답변이 바뀜" tone="warning" /></View>}
    </Card>
    {error && <><Notice error>{error}</Notice><Button label="생성 결과 다시 확인" variant="secondary" onPress={() => setRevision(value => value + 1)} /></>}
    {notice && <Notice>{notice}</Notice>}
    {pending && <Notice>접수 결과를 아직 확인하지 못한 요청이 있어요. 새 요청을 만들지 않고 같은 요청으로 확인해요.</Notice>}
    {pending?.kind === 'document' && <Button label="보관 요청 대상 확인" variant="ghost" busy={busy === 'pending'} disabled={busy !== null} onPress={() => void checkPending()} />}
    {pending?.kind === 'document' && pending.preparationId !== id && <Button label="보관 요청의 문서 열기" variant="secondary" onPress={() => onOpenPending(pending.preparationId)} />}
    {isRunning && <Card><View style={styles.row}><StatusBadge label={job!.status === 'QUEUED' ? '초안 생성 대기' : '초안 만드는 중'} tone="info" /></View><Text style={styles.heading}>신청문서 초안을 만들고 있어요</Text>
      <Text style={styles.muted}>화면을 떠나도 작업은 이어져요. 기존 작업을 조회하며 새로 시작하지 않아요.</Text>
      {generationStages.map(([stage, label], index) => <Text key={stage} style={[styles.body, job?.stage === stage && { color: colors.primary, fontWeight: '600' }]}>{job?.stage && index < generationStages.findIndex(([code]) => code === job.stage) ? '✓ ' : job?.stage === stage ? '● ' : '○ '}{label}</Text>)}
    </Card>}
    {job && !isRunning && (job.status === 'FAILED' || unknown) && !approved && <Card><Text style={styles.heading}>{generationFailureTitle(job)}</Text><Notice error={!unknown}>{new ApplicationPreparationError(422, job.failureCode ?? 'REQUEST_FAILED', job.mappingMigration).message}</Notice>
      {unknown && <><Notice>기존 생성 요청의 처리 결과를 아직 확인하지 못했어요. 새 생성을 반복하지 말고 기존 요청의 상태를 확인해 주세요.</Notice>
        <Button label="기존 생성 요청 상태 확인" variant="secondary" busy={loading} disabled={busy !== null || loading} onPress={() => setRevision(value => value + 1)} /></>}
      {job.mappingMigration && <Button label="입력 위치 변경 확인" variant="secondary" disabled={busy !== null} onPress={() => setMigrationOpen(true)} />}
      {(group === 'reanalysis' || group === 'formLimit') && <Button label="원문·양식 다시 확인" variant="secondary" onPress={() => onReanalyze({ sourceCode: preparation.form.sourceCode, sourceProgramId: preparation.form.sourceProgramId })} />}
      {group === 'userFix' && <Button label="답변 수정하기" variant="secondary" onPress={onEditor} />}
    </Card>}
    {currentFiles.length > 0 && <View style={styles.row}><StatusBadge label="초안 완료" tone="success" /></View>}
    {answersChanged && <Notice>저장된 답변과 생성 문서의 버전이 달라요. 가장 최근에 생성한 문서는 답변 버전 {latestRevision}의 초안입니다.</Notice>}
    {latestRevision !== null && <><Text style={styles.heading}>답변 버전 {latestRevision} 문서 · {latestFiles.length}개</Text>{latestFiles.map(renderFile)}</>}
    {previousFiles.length > 0 && <>
      <Button label={`이전 버전 문서 ${previousFiles.length}개 ${previousOpen ? '접기' : '보기'}`} variant="ghost" onPress={() => setPreviousOpen(value => !value)} />
      {previousOpen && previousRevisions.map(fileRevision => <View key={fileRevision} style={{ gap: 12 }}>
        <Text style={styles.heading}>답변 버전 {fileRevision} 문서</Text>
        {previousFiles.filter(file => file.inputRevision === fileRevision).map(renderFile)}
      </View>)}
    </>}
    {!isRunning && !currentFiles.length && missingRequired.length > 0 && <Notice>필수 답변 {missingRequired.length}개가 비어 있어요. 비워 둔 채로도 초안을 만들 수 있으며 문서에는 빈칸으로 남아요.</Notice>}
    {canGenerate && <><Notice>{recoveringRequest ? '보관한 답변 버전의 같은 요청을 확인해요. 새 요청 키를 만들지 않아요.' : draftMode === 'original'
      ? '입력한 답변이 없거나 모두 미정이에요. 초안을 만들면 답변을 기입하지 않은 공식 양식 그대로 저장돼요. AI를 호출하지 않아요.'
      : draftMode === 'manualOnly' ? '저장된 답변 중 양식에 자동으로 기입할 수 있는 것이 없어 초안을 만들지 못할 수 있어요. 원문 양식에 직접 옮겨 적어 주세요.'
        : '저장된 답변만 공식 양식에 기입해요. 비운 질문과 미정은 빈칸으로 남아요.'}</Notice>
      {!recoveringRequest && draftMode !== 'original' && <Text style={styles.muted}>답변 기입에는 유료 AI 호출이 발생할 수 있어요.</Text>}
      <Button label={busy === 'generate' ? '생성 요청 처리 중…' : pending ? '같은 생성 요청으로 확인' : files.length ? '수정 답변으로 다시 만들기' : job?.status === 'FAILED' ? '초안 생성 다시 시도' : '초안 만들기'} busy={busy === 'generate'} disabled={busy !== null} onPress={() => void generate()} /></>}
    <Button label="답변 수정하기" variant="secondary" disabled={busy !== null} onPress={onEditor} />
    {googleFormAvailable && <Button label="구글폼 입력 도우미" variant="secondary" onPress={onOnline} />}
    <Text style={styles.muted}>생성한 초안은 기관 제출이나 검수 완료를 뜻하지 않아요. 내려받아 원본 양식에서 최종 확인해 주세요.</Text>
    <PartnerSheet visible={migrationOpen} title="입력 위치 변경 확인" onClose={() => { if (!busy) setMigrationOpen(false) }} actions={<><Button label="취소" variant="secondary" disabled={busy !== null} onPress={() => setMigrationOpen(false)} /><Button label="새 입력 위치 적용" busy={busy === 'migration'} disabled={busy !== null} onPress={() => void approve()} /></>}>
      <Text style={styles.muted}>기존 답변과 파일을 유지하고 새 양식 위치를 적용해요. 적용만으로 초안을 다시 생성하지 않아요.</Text>
      {job?.mappingMigration?.changes.map((change, index) => <Card key={`${change.fieldLabel}:${index}`}><Text style={styles.heading}>{change.fieldLabel}</Text><Text style={styles.body}>이전: {change.oldLocation ?? '없음'}</Text><Text style={styles.body}>변경: {change.newLocation ?? '없음'}</Text></Card>)}
    </PartnerSheet>
  </Page>
}
