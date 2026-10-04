import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import * as Crypto from 'expo-crypto'
import type { ApplicationPreparation, ApplicationDocument, ApplicationDocumentGenerationJob } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import { generationStages, generationFailureTitle, failureGroupOf, isWritableApplicationAnswer } from '@govbiz/shared/domain/entities/ApplicationDocumentGeneration'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { useAuth } from '../auth/session'
import { applicationPreparationUseCase, discardDeletedPendingPreparation } from '../api/applicationPreparation'
import { getApiBaseUrl } from '../api/client'
import { shareApplicationFile } from '../api/applicationDocumentFiles'
import { clearPendingPreparation, readPendingPreparation, savePendingPreparation, type PendingPreparationRequest } from '../auth/preparationPending'
import { PartnerSheet } from '../components/PartnerSheet'
import { PreparationAccess } from '../components/ApplicationPreparationUi'
import { useAppForeground } from '../components/useAppForeground'
import { Button, Card, Notice, Page, StatusBadge, colors, styles } from '../ui'

type Props = { id: number; jobId?: number; onLogin(): void; onEditor(): void; onReanalyze(identity: { sourceCode: string; sourceProgramId: string }): void; onOnline(): void; onList(): void; onOpenPending(id: number): void }
const running = (job: ApplicationDocumentGenerationJob) => job.status === 'QUEUED' || job.status === 'RUNNING'
export function ApplicationDocumentScreen(props: Props) {
  const auth = useAuth()
  if (auth.status !== 'signedIn' || !auth.session) return <PreparationAccess onLogin={props.onLogin} />
  return <OwnedDocuments key={`${auth.session.accessToken}:${props.id}`} token={auth.session.accessToken} email={auth.session.account.email} {...props} />
}
function OwnedDocuments({ id, jobId, token, email, onEditor, onReanalyze, onOnline, onList, onOpenPending }: Props & { token: string; email: string }) {
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
  const [revision, setRevision] = useState(0)
  const [migrationOpen, setMigrationOpen] = useState(false)
  const [approved, setApproved] = useState(false)
  const action = useRef<AbortController | null>(null)
  const downloadWork = useRef<AbortController | null>(null)
  const focused = useRef(false)
  const mounted = useRef(true)
  const locked = useRef(false)
  const base = getApiBaseUrl(), owner = `${base}:${email}`
  const foreground = useAppForeground()
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
    setLoading(true); setError(null)
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
      setPreparation(detail); setFiles(stored); setPending(record); setJob(null)
      const latest = recent.find(candidate => running(candidate)) ?? recent.slice().sort((a, b) => b.id - a.id)[0]
      const selected = jobId ?? latest?.id
      if (selected) await follow(await useCase.documentJob(id, selected, controller.signal))
    })().catch(cause => { if (!controller.signal.aborted) reportError(cause) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); clearTimeout(timer) }
  }, [foreground, id, jobId, revision, useCase, base, email, reportError]))
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
  async function download(file: ApplicationDocument | null, targetRevision?: number, mode: 'save' | 'share' = 'share') {
    if (locked.current || !preparation || !focused.current) return
    locked.current = true; setBusy(file ? String(file.id) : 'archive'); setError(null)
    const controller = new AbortController(); downloadWork.current = controller
    try {
      const blob = file ? await useCase.downloadDocument(id, file.id, controller.signal) : await useCase.downloadDocumentArchive(id, targetRevision!, controller.signal)
      if (file && blob.size !== file.size) throw new Error('문서 크기가 저장된 결과와 다릅니다. 다시 확인해 주세요.')
      if (controller.signal.aborted || !mounted.current || !focused.current) return
      const extensions: Record<string, string> = { 'application/pdf': 'pdf', 'application/x-hwp': 'hwp', 'application/hwp+zip': 'hwpx', 'application/zip': 'zip',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx' }
      const extension = extensions[blob.type.split(';')[0]]
      if (!file && !extension) throw new Error('묶음 내려받기의 파일 형식을 확인하지 못했어요.')
      await shareApplicationFile(owner, blob, file?.fileName ?? `신청문서-${id}-답변${targetRevision}.${extension}`, () => mounted.current && focused.current && !controller.signal.aborted, controller.signal, mode)
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
    <Button label="다시 확인" disabled={busy !== null} onPress={() => setRevision(value => value + 1)} />
    <Button label="목록으로 돌아가기" variant="ghost" disabled={busy !== null} onPress={onList} /></Page>
  const currentFiles = files.filter(file => file.inputRevision === preparation.inputRevision)
  const previousFiles = files.filter(file => file.inputRevision !== preparation.inputRevision)
  const isRunning = Boolean(job && running(job)), unknown = job?.status === 'UNKNOWN'
  const group = job ? failureGroupOf(job) : null
  const missingRequired = preparation.form.sections.flatMap(section => section.fields.filter(field => field.required && field.documentWritable !== false && !section.facts.some(fact => fact.fieldKey === field.key)))
  const writableAnswers = preparation.form.sections.reduce((count, section) => count + section.fields.filter(field =>
    isWritableApplicationAnswer(field, section.facts.find(fact => fact.fieldKey === field.key && fact.status === 'PROVIDED')?.value)).length, 0)
  const recoveringRequest = pending?.kind === 'document' && pending.preparationId === id
  const canGenerate = !loading && !busy && !isRunning && !unknown && (recoveringRequest ||
    !currentFiles.length && !missingRequired.length && writableAnswers > 0 &&
    (!job || job.expectedRevision !== preparation.inputRevision || approved || job.status === 'FAILED' && group === 'temporary'))
  const renderFile = (file: ApplicationDocument) => <Card key={file.id}><Text style={styles.heading}>{file.fileName}</Text><Text style={styles.muted}>{Math.ceil(file.size / 1024)} KB · 답변 버전 {file.inputRevision}</Text>
    {file.filledAnswerCount !== null && <Text style={styles.muted}>자동 기입 {file.filledAnswerCount}개 · 직접 작성 필요 {file.unfilledAnswerCount}개</Text>}
    {(file.remainingExampleCount ?? 0) > 0 && <Notice>직접 작성할 칸 {file.remainingExampleCount}곳에 예시 문구가 남아 있어요. 제출 전에 지워 주세요.</Notice>}
    {file.unfilledAnswers.map(answer => <View key={answer.fieldId} style={{ gap: 6 }}><Notice>{answer.fieldLabel}: {answer.reason === 'OVERFLOW'
      ? `칸보다 길어 넣지 못했어요.${answer.capacity ? ` 약 ${answer.capacity}자 이내로 줄여 주세요.` : ''}`
      : answer.reason === 'AMBIGUOUS_SLOT' ? '빈칸이 여러 개라 위치를 확인하지 못했어요. 원본 파일에서 직접 작성해 주세요.'
        : answer.reason === 'SLOT_MISMATCH' ? '인쇄된 선택지·날짜와 달라요. 원본 파일에서 직접 작성해 주세요.'
          : '원본 파일에서 직접 작성해 주세요.'}</Notice><Text style={styles.body}>{answer.value}</Text>
      <Button label="답변 복사" accessibilityLabel={`${answer.fieldLabel} 답변 복사`} variant="ghost" onPress={() => void Clipboard.setStringAsync(answer.value).then(() => setNotice('답변을 복사했어요.')).catch(() => setError('답변을 복사하지 못했어요.'))} /></View>)}
    <Button label="기기에 저장" accessibilityLabel={`${file.fileName} 기기에 저장`} variant="secondary" disabled={busy !== null} busy={busy === String(file.id)} onPress={() => void download(file, undefined, 'save')} />
    <Button label="다른 앱으로 공유" accessibilityLabel={`${file.fileName} 공유`} variant="ghost" disabled={busy !== null} onPress={() => void download(file)} />
  </Card>
  return <Page refreshing={loading} onRefresh={() => setRevision(value => value + 1)}>
    <Card><Text style={styles.heading}>{preparation.form.programTitle}</Text><Text style={styles.muted}>{preparation.form.formTitle}</Text></Card>
    {error && <><Notice error>{error}</Notice><Button label="생성 결과 다시 확인" variant="secondary" onPress={() => setRevision(value => value + 1)} /></>}
    {notice && <Notice>{notice}</Notice>}
    {pending && <Notice>결과를 확인하지 못한 보관 요청이 있어요. 같은 요청으로 확인하면 중복 유료 생성을 방지할 수 있어요.</Notice>}
    {pending?.kind === 'document' && <Button label="보관 요청 대상 확인" variant="ghost" busy={busy === 'pending'} disabled={busy !== null} onPress={() => void checkPending()} />}
    {pending?.kind === 'document' && pending.preparationId !== id && <Button label="보관 요청의 문서 열기" variant="secondary" onPress={() => onOpenPending(pending.preparationId)} />}
    {isRunning && <Card><View style={styles.row}><StatusBadge label={job!.status === 'QUEUED' ? '초안 생성 대기' : '초안 만드는 중'} tone="info" /></View><Text style={styles.heading}>공식 양식에 답변을 담고 있어요</Text>
      <Text style={styles.muted}>화면을 떠나도 작업은 이어져요. 기존 작업을 조회하며 새로 시작하지 않아요.</Text>
      {generationStages.map(([stage, label], index) => <Text key={stage} style={[styles.body, job?.stage === stage && { color: colors.primary, fontWeight: '600' }]}>{job?.stage && index < generationStages.findIndex(([code]) => code === job.stage) ? '✓ ' : job?.stage === stage ? '● ' : '○ '}{label}</Text>)}
    </Card>}
    {job && !isRunning && (job.status === 'FAILED' || unknown) && !approved && <Card><Text style={styles.heading}>{generationFailureTitle(job)}</Text><Notice error={!unknown}>{new ApplicationPreparationError(422, job.failureCode ?? 'REQUEST_FAILED', job.mappingMigration).message}</Notice>
      {job.mappingMigration && <Button label="입력 위치 변경 확인" variant="secondary" disabled={busy !== null} onPress={() => setMigrationOpen(true)} />}
      {(group === 'reanalysis' || group === 'formLimit') && <Button label="원문·양식 다시 확인" variant="secondary" onPress={() => onReanalyze({ sourceCode: preparation.form.sourceCode, sourceProgramId: preparation.form.sourceProgramId })} />}
      {group === 'userFix' && <Button label="답변 수정하기" variant="secondary" onPress={onEditor} />}
    </Card>}
    {currentFiles.length > 0 && <View style={styles.row}><StatusBadge label="초안 완료" tone="success" /></View>}
    {currentFiles.map(renderFile)}
    {currentFiles.length > 1 && <Button label="현재 답변 파일 전체 내려받기" disabled={busy !== null} busy={busy === 'archive'} onPress={() => void download(null, preparation.inputRevision)} />}
    {previousFiles.length > 0 && <><Text style={styles.heading}>이전 파일</Text><Notice>답변이 바뀌었어요. 이전 파일은 해당 답변 버전으로 만들어진 초안입니다.</Notice>{previousFiles.map(renderFile)}</>}
    {!isRunning && !currentFiles.length && (missingRequired.length > 0 || writableAnswers === 0) && <Notice>초안을 만들기 전에 작성할 답변을 저장하고 필수 항목을 확인해 주세요.</Notice>}
    {canGenerate && <><Text style={styles.muted}>초안 생성은 유료 AI를 사용해요.</Text><Button label={pending ? '같은 생성 요청으로 확인' : previousFiles.length ? '수정 답변으로 다시 만들기' : job?.status === 'FAILED' ? '초안 생성 다시 시도' : '초안 만들기'} busy={busy === 'generate'} onPress={() => void generate()} /></>}
    <Button label="답변 수정하기" variant="secondary" disabled={busy !== null} onPress={onEditor} />
    <Button label="온라인 신청 입력 도우미" variant="secondary" onPress={onOnline} />
    <Button label="공식 공고 원문" variant="ghost" onPress={() => void Linking.openURL(preparation.form.sourceUrl).catch(() => setError('공식 공고 원문을 열지 못했어요.'))} />
    <Button label="목록으로 돌아가기" variant="ghost" onPress={onList} />
    <Text style={styles.muted}>생성한 초안은 기관 제출이나 검수 완료를 뜻하지 않아요. 내려받아 원본 양식에서 최종 확인해 주세요.</Text>
    <PartnerSheet visible={migrationOpen} title="입력 위치 변경 확인" onClose={() => { if (!busy) setMigrationOpen(false) }} actions={<><Button label="취소" variant="secondary" disabled={busy !== null} onPress={() => setMigrationOpen(false)} /><Button label="새 입력 위치 적용" busy={busy === 'migration'} disabled={busy !== null} onPress={() => void approve()} /></>}>
      <Text style={styles.muted}>기존 답변과 파일을 유지하고 새 양식 위치를 적용해요. 적용만으로 초안을 다시 생성하지 않아요.</Text>
      {job?.mappingMigration?.changes.map((change, index) => <Card key={`${change.fieldLabel}:${index}`}><Text style={styles.heading}>{change.fieldLabel}</Text><Text style={styles.body}>이전: {change.oldLocation ?? '없음'}</Text><Text style={styles.body}>변경: {change.newLocation ?? '없음'}</Text></Card>)}
    </PartnerSheet>
  </Page>
}
