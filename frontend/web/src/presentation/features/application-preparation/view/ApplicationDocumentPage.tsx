import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import { useAppSelector } from '../../../../app/hooks'
import type { ApplicationDocument, ApplicationDocumentGenerationJob, ApplicationDocumentMigrationNotice, ApplicationPreparation } from '../../../../domain/entities/ApplicationPreparation'
import { ApplicationPreparationError } from '../../../../domain/errors/ApplicationPreparationError'
import { selectCurrentAccount } from '../../../shared/auth/state/authSlice'
import { appPaths } from '../../../shared/routes/appPaths'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { WorkspaceToast, type WorkspaceToastNotice } from '../../../shared/workspace/WorkspaceToast'
import { workspacePageStyles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import { useDelayedFlag } from '../../../shared/workspace/useDelayedFlag'
import { ApplicationPreparationLede } from './ApplicationPreparationLede'
import { ButtonSpinner, DocumentFilesSkeleton } from './ApplicationPreparationSkeletons'
import {
  answerEditorStyles as e,
  applicationPreparationStyles as s,
  documentResultStyles as d,
  newPreparationStyles as n,
} from './ApplicationPreparation.styles'

const pageTitle = '신청 문서 초안'

/** 신청 문서 초안(26) 화면입니다. 주소가 잘못돼도 머리글은 그대로 두고 본문에 오류를 보여 줍니다. */
export function ApplicationDocumentPage() {
  const account = useAppSelector(selectCurrentAccount)
  const { preparationId } = useParams()
  const id = Number(preparationId)
  if (!account) return null
  if (!Number.isSafeInteger(id) || id <= 0) {
    return <>
      <WorkspacePageHeader parent={{ to: appPaths.applicationPreparations, label: '신청 문서 작성' }} title={pageTitle} />
      <main className={workspacePageStyles.content}>
        <div className={`${n.alert} ${n.alertDanger} ${d.body}`} role="alert">
          <div className={n.alertText}><strong className={n.alertTitle}>문서 주소가 올바르지 않아요</strong><p>목록에서 작성 중인 신청 문서를 다시 골라 주세요.</p></div>
          <Link className={n.secondarySm} to={appPaths.applicationPreparations}>목록으로</Link>
        </div>
      </main>
    </>
  }
  return <DocumentResults key={`${account.email}:${id}`} id={id} />
}

/** 서버 작업 표가 기록하는 단계 순서입니다. 화면은 단계를 추측하지 않고 이 값만 표시합니다. */
const generationStages = [
  ['PREPARING', '답변 확인'],
  ['MAPPING', '입력칸 위치 찾기'],
  ['WRITING', '입력칸 기입'],
  ['SAVING', '파일 저장'],
] as const

/**
 * 실패 안내 묶음입니다. 다시 시도로 풀리는 일시 오류(temporary)에만 [다시 시도]를 둡니다.
 * formLimit 양식 한계 · reanalysis 양식 재분석 필요 · userFix 답변을 고치면 풀림 · serviceDown 서비스 중단 · outcomeUnknown 결과 확인 중.
 */
type FailureGroup = 'formLimit' | 'reanalysis' | 'userFix' | 'temporary' | 'serviceDown' | 'outcomeUnknown'

/** 실패 코드(앞의 APPLICATION_DOCUMENT_ 생략) → 묶음입니다. 표에 없는 코드는 일시 오류로 둡니다. */
const failureGroups: Record<string, FailureGroup> = {
  LIMIT_EXCEEDED: 'formLimit', UNSUPPORTED: 'formLimit', UNMAPPED_INPUT: 'formLimit',
  // 기입할 칸이 원래 없어 재분석으로 풀릴 가능성이 낮습니다. 유료 재분석 대신 원본에 직접 작성하게 합니다.
  NO_WRITABLE_INPUT: 'formLimit',
  MAPPING_FAILED: 'reanalysis', SOURCE_CHANGED: 'reanalysis', FORM_REANALYSIS_REQUIRED: 'reanalysis',
  INPUT_REQUIRED: 'userFix', OVERFLOW: 'userFix', APPLICATION_PREPARATION_REVISION_CONFLICT: 'userFix',
  MCP_NOT_READY: 'serviceDown',
  OUTCOME_UNKNOWN: 'outcomeUnknown', RUN_OUTCOME_UNKNOWN: 'outcomeUnknown',
}

function failureCodeOf(job: ApplicationDocumentGenerationJob) {
  return (job.failureCode ?? '').replace(/^APPLICATION_DOCUMENT_/, '')
}

function failureGroupOf(job: ApplicationDocumentGenerationJob): FailureGroup {
  if (job.status === 'UNKNOWN') return 'outcomeUnknown'
  return failureGroups[failureCodeOf(job)] ?? 'temporary'
}

const formatLabels: Record<string, string> = {
  'application/x-hwp': 'HWP',
  'application/hwp+zip': 'HWPX',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/pdf': 'PDF',
}

function formatOf(file: ApplicationDocument) {
  return formatLabels[file.mediaType] ?? file.fileName.split('.').pop()?.toUpperCase() ?? ''
}

function elapsedLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}분 ${seconds % 60}초 지남` : `${seconds}초 지남`
}

/** "09.22 15:40"처럼 묶음 제목에 붙는 만든 시각입니다. */
function madeAtLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const two = (part: number) => String(part).padStart(2, '0')
  return `${two(date.getMonth() + 1)}.${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

function DocumentResults({ id }: { id: number }) {
  const useCase = appContainer.resolve('applicationPreparationUseCase')
  const [search, setSearch] = useSearchParams()
  /** 답변 입력에서 [초안 만들기]로 들어온 버전입니다. 한 번 읽으면 주소에서 지워, 다시 들어와도 같은 버전을 저절로 제출하지 않습니다. */
  const requestedRevision = useRef(search.get('generate'))
  const [preparation, setPreparation] = useState<ApplicationPreparation | null>(null)
  const [files, setFiles] = useState<ApplicationDocument[]>([])
  /** 최근 생성 작업들. 문서 묶음 제목의 만든 시각을 작업의 끝난 시각에서 읽습니다. */
  const [jobs, setJobs] = useState<ApplicationDocumentGenerationJob[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 끝났지만 성공하지 못한 생성 작업. 실패 코드에 따라 알림의 동작이 달라집니다. */
  const [failedJob, setFailedJob] = useState<ApplicationDocumentGenerationJob | null>(null)
  /** 제출 때 계정의 진행 작업 3건이 차 있었는지. 전용 안내와 [다시 시도]를 보여 줍니다. */
  const [capacityFull, setCapacityFull] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [downloading, setDownloading] = useState<number | null>(null)
  const [migration, setMigration] = useState<ApplicationDocumentMigrationNotice | null>(null)
  const [migrationBusy, setMigrationBusy] = useState(false)
  const [regenerationRevision, setRegenerationRevision] = useState<number | null>(null)
  const [migrationMessage, setMigrationMessage] = useState<string | null>(null)
  const [busySince, setBusySince] = useState<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [archiving, setArchiving] = useState(false)
  /** 지금 따라가고 있는 생성 작업. 진행 카드가 서버가 기록한 단계를 보여 준다. */
  const [job, setJob] = useState<ApplicationDocumentGenerationJob | null>(null)
  const [toast, setToast] = useState<WorkspaceToastNotice | null>(null)
  const downloadController = useRef<AbortController | null>(null)
  const migrationController = useRef<AbortController | null>(null)
  const back = `${appPaths.applicationPreparations}/${id}`
  const latestRevision = files.length > 0 ? Math.max(...files.map((file) => file.inputRevision)) : null
  const latestFiles = files.filter((file) => file.inputRevision === latestRevision)
  const previousFiles = files.filter((file) => file.inputRevision !== latestRevision)
  const previousRevisions = [...new Set(previousFiles.map((file) => file.inputRevision))].sort((a, b) => b - a)
  const latestJob = jobs.find((candidate) => candidate.status === 'SUCCEEDED' && candidate.finishedAt
    && latestFiles.some((file) => candidate.fileIds.includes(file.id)))
  const latestMadeAt = latestJob?.finishedAt ? madeAtLabel(latestJob.finishedAt) : null
  // 같은 답변 버전은 기존 파일을 즉시 돌려주므로, 다시 만들기는 답변이 바뀐 뒤(현재 버전 파일 없음)에만 켠다.
  // 지금 버전의 실패 안내가 떠 있으면 끈다. 다시 제출하는 길은 일시 오류 카드의 [다시 시도] 하나뿐이다.
  const canRegenerate = !busy && preparation !== null && failedJob === null && files.length > 0
    && !files.some((file) => file.inputRevision === preparation.inputRevision)
  const unanswered = preparation?.form.sections.flatMap((section) => section.fields
    .filter((field) => field.documentWritable !== false && !section.facts.some((fact) => fact.fieldKey === field.key && fact.status === 'PROVIDED'))
    .map((field) => ({ key: field.key, label: `${section.title} · ${field.label}` }))) ?? []
  const reanalyzeTo = preparation
    ? `${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: preparation.form.sourceCode, sourceProgramId: preparation.form.sourceProgramId })}`
    : appPaths.applicationPreparationNew
  const reasonLabel = (reason: ApplicationDocument['unfilledAnswers'][number]['reason']) => reason === 'AUTO_FILL_UNSUPPORTED' ? '자동 기입 미지원' : '입력 위치 확인 불가'
  const changeTypeLabel: Record<ApplicationDocumentMigrationNotice['changes'][number]['changeType'], string> = {
    TARGET_ADDED: '새 입력칸', TARGET_REMOVED: '입력칸 사라짐', TARGET_CHANGED: '입력칸 변경',
    BOX_CHANGED: '입력 영역 변경', KIND_CHANGED: '입력 방식 변경', SCOPE_CHANGED: '편집 범위 변경',
  }

  useEffect(() => {
    if (!search.has('generate')) return
    setSearch((current) => {
      const next = new URLSearchParams(current)
      next.delete('generate')
      return next
    }, { replace: true })
  }, [search, setSearch])

  useEffect(() => {
    const controller = new AbortController()
    const terminal = (candidate: ApplicationDocumentGenerationJob) => candidate.status === 'SUCCEEDED' || candidate.status === 'FAILED' || candidate.status === 'UNKNOWN'
    const active = (candidates: ApplicationDocumentGenerationJob[]) => candidates.find((candidate) => candidate.status === 'QUEUED' || candidate.status === 'RUNNING') ?? null
    function sleep(ms: number) {
      return new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve() }, ms)
        controller.signal.addEventListener('abort', abort, { once: true })
        if (controller.signal.aborted) abort()
      })
    }
    /** 작업이 끝날 때까지 2초마다 상태를 읽는다. 서버가 30분 뒤 RUNNING을 결과 불명으로 내리므로 그보다 조금 더 기다린다. */
    async function follow(started: ApplicationDocumentGenerationJob) {
      let current = started
      setJob(current)
      const deadline = Date.now() + 35 * 60_000
      while (!terminal(current)) {
        if (Date.now() > deadline) throw new Error('문서 생성이 아직 끝나지 않았습니다. 잠시 후 다시 열면 저장된 결과부터 확인합니다. 답변은 저장되어 있습니다.')
        await sleep(2000)
        current = await useCase.documentJob(id, current.id, controller.signal)
        setJob(current)
      }
      return current
    }
    async function load() {
      setBusy(true); setBusySince(Date.now()); setError(null); setFailedJob(null); setCapacityFull(false); setMigration(null); setJob(null)
      try {
        const [detail, stored, recent] = await Promise.all([
          useCase.get(id, controller.signal),
          useCase.documents(id, controller.signal),
          useCase.documentJobs(id, controller.signal).catch(() => [] as ApplicationDocumentGenerationJob[]),
        ])
        if (controller.signal.aborted) return
        // 새 초안을 만드는 동안에도 이미 만든 문서는 그대로 받을 수 있게 먼저 보여 준다.
        setPreparation(detail); setFiles(stored); setJobs(recent)
        let finished: ApplicationDocumentGenerationJob | null = null
        const running = active(recent)
        if (running) {
          // 화면을 떠났다 돌아와도 진행 중인 작업을 이어받는다. 새 유료 생성을 시작하지 않는다.
          finished = await follow(running)
        } else if (requestedRevision.current !== null) {
          const revision = Number(requestedRevision.current)
          if (!Number.isSafeInteger(revision) || revision !== detail.inputRevision) throw new Error('답변이 변경되었습니다. 답변 입력으로 돌아가 최신 내용을 확인한 뒤 다시 생성해 주세요.')
          if (!stored.some((file) => file.inputRevision === revision)) {
            try {
              finished = await follow(await useCase.submitDocumentJob(id, revision, controller.signal))
            } catch (caught) {
              if (controller.signal.aborted) throw caught
              if (!(caught instanceof ApplicationPreparationError) || caught.code !== 'APPLICATION_PREPARATION_RUN_CONFLICT') throw caught
              // 다른 탭이나 앞선 요청의 작업이 이미 진행 중이면 그 작업을 따라간다.
              const existing = active(await useCase.documentJobs(id, controller.signal))
              if (!existing) throw new Error('이전 문서 생성의 결과를 아직 확인하지 못해 새 생성을 시작하지 않았습니다. 저장된 문서를 확인한 뒤 잠시 후 다시 시도해 주세요.')
              finished = await follow(existing)
            }
          }
        } else if (!stored.some((file) => file.inputRevision === detail.inputRevision)) {
          // 다시 들어왔을 때 지금 답변 버전의 마지막 작업이 실패·결과 불명이면 빈 상태 대신 그 안내를 다시 보여 준다.
          // 새로 제출하지 않는다. 답변이 그 뒤에 바뀌었으면(더 오래된 버전의 작업) 빈 상태의 [초안 만들기]를 둔다.
          const latest = recent.reduce<ApplicationDocumentGenerationJob | null>((newest, candidate) => !newest || candidate.id > newest.id ? candidate : newest, null)
          if (latest && latest.expectedRevision === detail.inputRevision && (latest.status === 'FAILED' || latest.status === 'UNKNOWN')) setFailedJob(latest)
        }
        if (finished) {
          const done = finished
          // 실패·결과 불명이어도 앞서 저장된 파일이 있을 수 있으니 목록은 다시 읽는다.
          const documents = await useCase.documents(id, controller.signal)
          if (controller.signal.aborted) return
          setFiles(documents)
          setJobs((previous) => [done, ...previous.filter((candidate) => candidate.id !== done.id)])
          if (done.status !== 'SUCCEEDED') {
            // 실패·결과 불명 뒤에는 요청한 버전을 비웁니다. 다시 제출하는 길은 일시 오류의 [다시 시도] 하나뿐입니다.
            requestedRevision.current = null
            if (done.mappingMigration) setMigration(done.mappingMigration)
            else setFailedJob(done)
            return
          }
          setToast({ id: done.id, text: '초안을 만들었어요' })
        }
        requestedRevision.current = null
      } catch (caught) {
        if (controller.signal.aborted) return
        // 한도 초과는 작업을 만들지 않았으므로 요청한 버전을 남겨 두고 [다시 시도]로 같은 버전을 제출합니다.
        if (caught instanceof ApplicationPreparationError && caught.code === 'APPLICATION_DOCUMENT_JOB_CAPACITY') setCapacityFull(true)
        else setError(caught instanceof Error ? caught.message : '문서를 생성하지 못했습니다.')
      } finally { if (!controller.signal.aborted) { setBusy(false); setBusySince(null); setJob(null) } }
    }
    void load()
    return () => { controller.abort(); downloadController.current?.abort(); migrationController.current?.abort() }
  }, [id, useCase, attempt])

  useEffect(() => {
    if (busySince === null) { setElapsedSeconds(0); return }
    const tick = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - busySince) / 1000)))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [busySince])

  /** 현재 답변 버전으로 초안을 만든다. 같은 버전의 문서가 이미 있으면 서버를 부르지 않고 그 문서를 보여 준다. */
  function generate(revision: number) {
    requestedRevision.current = String(revision); setAttempt((count) => count + 1)
  }

  async function confirmMigration() {
    if (!migration || migrationController.current) return
    const controller = new AbortController()
    migrationController.current = controller
    setMigrationBusy(true); setError(null)
    try {
      const confirmed = await useCase.confirmDocumentMappingMigration(id, migration.expectedRevision,
        migration.approvalToken, controller.signal)
      if (controller.signal.aborted) return
      setPreparation(await useCase.get(id, controller.signal))
      if (controller.signal.aborted) return
      setMigration(null)
      setRegenerationRevision(confirmed.inputRevision)
      setMigrationMessage('새 입력 위치가 이 작성본에만 적용됐습니다. 기존 답변과 파일은 유지됩니다. 새 초안을 별도로 생성해 주세요.')
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '입력 위치를 적용하지 못했습니다.')
    } finally {
      if (migrationController.current === controller) migrationController.current = null
      if (!controller.signal.aborted) setMigrationBusy(false)
    }
  }

  function saveBlob(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = fileName
    document.body.appendChild(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function downloadArchive(revision: number) {
    if (downloadController.current) return
    const controller = new AbortController()
    downloadController.current = controller
    setArchiving(true); setError(null)
    try {
      const blob = await useCase.downloadDocumentArchive(id, revision, controller.signal)
      if (controller.signal.aborted) return
      saveBlob(blob, `신청 문서_초안_v${revision}.zip`)
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '전체 내려받기에 실패했습니다.')
    } finally {
      if (!controller.signal.aborted) setArchiving(false)
      if (downloadController.current === controller) downloadController.current = null
    }
  }

  async function download(file: ApplicationDocument) {
    if (downloadController.current) return
    const controller = new AbortController()
    downloadController.current = controller
    setDownloading(file.id); setError(null)
    try {
      const blob = await useCase.downloadDocument(id, file.id, controller.signal)
      if (controller.signal.aborted) return
      saveBlob(blob, file.fileName)
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '다운로드하지 못했습니다.')
    } finally {
      if (!controller.signal.aborted) setDownloading(null)
      if (downloadController.current === controller) downloadController.current = null
    }
  }

  function renderFile(file: ApplicationDocument) {
    const format = formatOf(file)
    const filled = file.filledAnswerCount
    const unfilled = file.unfilledAnswerCount
    const total = filled !== null && unfilled !== null ? filled + unfilled : 0
    return <article className={d.file} key={file.id} aria-label={file.fileName}>
      <div className={d.fileHead}>
        <span className={d.format} aria-hidden="true">{format}</span>
        <div className={d.fileText}>
          <p className={d.fileName}>{file.fileName}</p>
          <span className={d.fileMeta}>{format} · {Math.ceil(file.size / 1024)} KB</span>
        </div>
        <div className={d.fileActions}>
          <button type="button" className={n.secondarySm} disabled={downloading !== null || archiving} onClick={() => { void download(file) }}>
            {downloading === file.id && <ButtonSpinner />}받기<span className="sr-only">: {file.fileName}</span>
          </button>
        </div>
      </div>
      {filled !== null && unfilled !== null && total > 0 && <div className={d.fill}>
        <div className={s.progressTrack} aria-hidden="true"><div className={s.progressFill} style={{ width: `${Math.round((filled / total) * 100)}%` }} /></div>
        <p className={d.fillLabel}>{unfilled === 0 ? `${filled}개 모두 기입` : `${filled}개 기입 · ${unfilled}개 미기입`}</p>
      </div>}
      {file.unfilledAnswers.length > 0 && <details className={d.unfilled}>
        <summary className={d.unfilledSummary}>자동 기입 못한 답변 보기 ({file.unfilledAnswers.length})</summary>
        <div aria-label="자동 기입하지 못한 답변">
          <ul>{file.unfilledAnswers.map((answer) => <li key={answer.fieldId}><strong>{answer.fieldLabel}</strong>: {answer.value} — {reasonLabel(answer.reason)}</li>)}</ul>
        </div>
      </details>}
    </article>
  }

  // 머리글 오른쪽과 600px 미만 아래 줄이 같은 두 버튼을 씁니다. 파일이 여러 개면 zip으로, 하나면 그 파일을 바로 받습니다.
  const single = latestFiles.length === 1 ? latestFiles[0] : null
  const downloadPending = archiving || (single !== null && downloading === single.id)
  function downloadLatest() {
    if (single) void download(single)
    else if (latestRevision !== null) void downloadArchive(latestRevision)
  }
  const regenerate = () => { if (preparation) generate(preparation.inputRevision) }
  const changedBadge = canRegenerate ? <span className={d.changedBadge}>답변이 바뀜</span> : null
  const downloadLabel = single ? '내려받기' : '전체 내려받기'

  // 저장된 문서를 읽는 동안(아직 보여 줄 문서가 없을 때) 300ms가 넘으면 문구 대신 파일 카드 자리를 그립니다.
  const checking = busy && !job
  const showFilesSkeleton = useDelayedFlag(checking && files.length === 0)

  // 초안을 만드는 동안 머리글 동작 자리에는 버튼 대신 상태 태그만 둡니다. 진행은 본문 진행 카드가 알립니다.
  const generating = job !== null && (job.status === 'QUEUED' || job.status === 'RUNNING')
  const headerActions = generating
    ? <span className={`${workspaceTagClassName('muted')} gap-1.5`}><ButtonSpinner />초안 만드는 중</span>
    : files.length > 0 ? <>
      {changedBadge && <span className={d.headerOnly}>{changedBadge}</span>}
      <button type="button" className={`${workspacePageStyles.secondaryButton} ${d.headerOnly}`} disabled={!canRegenerate} onClick={regenerate}>다시 만들기</button>
      <button type="button" className={`${workspacePageStyles.primaryButton} ${d.headerOnly}`} disabled={downloading !== null || archiving} onClick={downloadLatest}>
        {downloadPending && <ButtonSpinner />}{downloadLabel}
      </button>
    </> : undefined

  return <>
    <WorkspacePageHeader
      parent={[{ to: appPaths.applicationPreparations, label: '신청 문서 작성' }, { to: back, label: '답변 입력' }]}
      title={pageTitle}
      actions={headerActions}
    />
    <main className={workspacePageStyles.content}>
      {(preparation || busy) && <ApplicationPreparationLede preparation={preparation} />}
      <div className={d.body}>
        {busy && job && <section className={n.progress} role="status" aria-live="polite" aria-label="문서 생성 진행">
          <div className={n.progressHead}>
            <span className={n.spinner} aria-hidden="true" />
            <strong className={n.progressTitle}>답변 버전 {job.expectedRevision}로 초안을 {files.length > 0 ? '다시 ' : ''}만들고 있어요</strong>
            <span className={n.progressTime}>{elapsedLabel(elapsedSeconds)}</span>
          </div>
          <p className={n.muted}>보통 1~3분 걸려요. 양식이 크면 더 걸릴 수 있어요.</p>
          {job.status === 'QUEUED' && <p className={n.muted}>순서를 기다리고 있어요.</p>}
          <StageList job={job} />
          <p className={n.progressNote}>화면을 나가도 계속돼요. 돌아오면 이어서 보여 드려요.</p>
        </section>}
        {checking && <p className="sr-only" role="status">저장된 문서를 확인하고 있어요.</p>}
        {showFilesSkeleton && <DocumentFilesSkeleton />}

        {failedJob && preparation && <FailureCard job={failedJob} sourceUrl={preparation.form.sourceUrl} editorTo={back}
          reanalyzeTo={reanalyzeTo} retryDisabled={busy} onRetry={regenerate} />}
        {capacityFull && <div className={`${n.alert} ${n.alertWarning}`} role="alert">
          <div className={n.alertText}>
            <strong className={n.alertTitle}>진행 중인 초안 만들기가 3건이에요</strong>
            <p>계정당 동시에 3건까지 만들 수 있어요. 다른 문서의 초안이 끝나면 다시 시도해 주세요. 답변은 그대로 저장되어 있어요.</p>
          </div>
          <div className={d.alertActions}>
            <button type="button" className={n.secondarySm} disabled={busy} onClick={() => setAttempt((count) => count + 1)}>다시 시도</button>
            <Link className={n.secondarySm} to={appPaths.applicationPreparations}>목록으로</Link>
          </div>
        </div>}
        {error && <div className={`${n.alert} ${n.alertDanger}`} role="alert">
          <div className={n.alertText}><p>{error}</p></div>
          {!busy && <button type="button" className={n.secondarySm} onClick={() => setAttempt((count) => count + 1)}>다시 시도</button>}
        </div>}

        {migration && <section className={n.card} aria-label="신청서 입력 위치 변경 확인">
          <h2 className={n.cardTitle}>입력 위치가 변경됐습니다</h2>
          <p className={n.muted}>승인 전에는 새 위치를 저장하거나 기존 답변·파일을 수정하지 않습니다. 아래 변경을 확인해 주세요.</p>
          <ul className={s.fieldList}>{migration.changes.map((change, index) => <li className={`${n.summary} ${n.muted}`} key={`${change.fieldLabel}-${index}`}>
            <strong className="text-app-ink">{change.fieldLabel} · {changeTypeLabel[change.changeType]}</strong>
            <span>기존: {change.oldLocation ?? '입력 위치 없음'}</span>
            <span>새 위치: {change.newLocation ?? '입력 위치 없음'}</span>
          </li>)}</ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={n.primary} disabled={migrationBusy} aria-busy={migrationBusy} onClick={() => { void confirmMigration() }}>
              {migrationBusy && <ButtonSpinner />}{migrationBusy ? '적용 중…' : '새 입력 위치 적용'}
            </button>
            <button type="button" className={n.secondary} disabled={migrationBusy} onClick={() => {
              setMigration(null); setMigrationMessage('변경 적용을 취소했습니다. 기존 답변과 파일은 그대로 유지됩니다.')
            }}>취소하고 기존 작성 유지</button>
          </div>
        </section>}
        {migrationMessage && <div className={`${n.alert} ${n.alertNeutral}`} role="status">
          <div className={n.alertText}><p>{migrationMessage}</p></div>
          {regenerationRevision !== null && <button type="button" className={n.secondarySm} onClick={() => {
            const revision = regenerationRevision
            setRegenerationRevision(null); setMigrationMessage(null); generate(revision)
          }}>새 초안 생성</button>}
        </div>}

        {!busy && preparation && files.length === 0 && !error && !failedJob && !capacityFull && !migration && !migrationMessage && <section className={n.card} aria-labelledby="documents-empty-title">
          <div className={n.empty}>
            <h2 className={n.cardTitle} id="documents-empty-title">아직 만든 초안이 없어요</h2>
            <p className={n.muted}>저장된 답변을 공식 양식의 입력칸에 기입해 초안을 만들어요.</p>
            <button type="button" className={n.secondarySm} onClick={() => generate(preparation.inputRevision)}>초안 만들기</button>
          </div>
        </section>}

        {latestRevision !== null && <section className={d.group} aria-labelledby="documents-latest-title">
          <h2 className={d.groupTitle} id="documents-latest-title">
            답변 버전 {latestRevision} 문서<span className={d.groupMeta}>{[latestMadeAt, `${latestFiles.length}개`].filter(Boolean).map((part) => ` · ${part}`).join('')}</span>
          </h2>
          {latestFiles.map(renderFile)}
          {previousFiles.length > 0 && <details className={d.older}>
            <summary className={d.olderSummary}>이전 버전 문서 {previousFiles.length}개</summary>
            <div className="mt-3 flex flex-col gap-3">{previousRevisions.map((revision) => <div className={d.group} key={revision}>
              <h3 className={d.olderTitle}>답변 버전 {revision} 문서</h3>
              {previousFiles.filter((file) => file.inputRevision === revision).map(renderFile)}
            </div>)}</div>
          </details>}
        </section>}

        {files.length > 0 && unanswered.length > 0 && <section className={`${n.alert} ${n.alertWarning}`} aria-labelledby="documents-unanswered-title">
          <div className={n.alertText}>
            <strong className={n.alertTitle} id="documents-unanswered-title">답하지 않은 선택 항목 {unanswered.length}개</strong>
            <p>{unanswered[0].label}{unanswered.length > 1 ? ` 외 ${unanswered.length - 1}개` : ''} — 문서에 빈칸으로 남아요. 제출 전에 채우거나 답을 적고 다시 만들어 주세요.</p>
          </div>
          <Link className={n.secondarySm} to={`${back}?${new URLSearchParams({ question: unanswered[0].key })}`}>답변 입력으로</Link>
        </section>}

        {files.length > 0 && <p className={d.note}>한 원본 파일에 신청서가 여러 개 있으면 한 파일로 드려요. 내려받은 문서의 기입 위치와 줄바꿈을 확인한 뒤 제출해 주세요.</p>}

        {files.length > 0 && <div className={d.mobileBar}>
          {changedBadge && <span className="self-start">{changedBadge}</span>}
          <div className={d.mobileButtons}>
            <button type="button" className={e.prevButton} disabled={!canRegenerate} onClick={regenerate}>다시 만들기</button>
            <button type="button" className={e.nextButton} disabled={downloading !== null || archiving} onClick={downloadLatest}>
              {downloadPending && <ButtonSpinner />}{downloadLabel}
            </button>
          </div>
        </div>}
      </div>
    </main>
    <WorkspaceToast notice={toast} onClose={() => setToast(null)} />
  </>
}

type FailureCardProps = {
  job: ApplicationDocumentGenerationJob
  /** 공고 원문 주소입니다. 원본 양식은 여기서 받습니다. */
  sourceUrl: string
  /** 답변 입력 화면 주소입니다. */
  editorTo: string
  reanalyzeTo: string
  retryDisabled: boolean
  onRetry: () => void
}

/**
 * 끝났지만 성공하지 못한 초안 작업의 안내 카드입니다. 제목 · 본문 · 버튼은 실패 코드의 묶음으로 고르고,
 * 서버 문장은 아래에 작은 글씨로만 둡니다. 빨간 경고는 다시 시도로 풀리는 일시 오류에만 씁니다.
 */
function FailureCard({ job, sourceUrl, editorTo, reanalyzeTo, retryDisabled, onRetry }: FailureCardProps) {
  const code = failureCodeOf(job)
  const group = failureGroupOf(job)
  const review = `${editorTo}?step=review`
  const toEditor = (to: string) => <Link className={n.secondarySm} to={to}>답변 입력으로</Link>
  let title: string
  let body: string
  let actions: ReactNode = null
  switch (group) {
    case 'formLimit':
      title = '이 양식은 자동으로 채우기 어려워요'
      body = '양식이 크거나 복잡해 입력칸 위치를 찾지 못했어요. 다시 시도해도 결과는 같아요. 저장된 답변을 보며 원본 양식에 직접 옮겨 적어 주세요.'
      actions = <>
        <a className={n.secondarySm} href={sourceUrl} target="_blank" rel="noreferrer">원문에서 양식 받기 ↗<span className="sr-only"> (새 창)</span></a>
        <Link className={n.secondarySm} to={`${review}&helper=open`}>답변 모아 보기</Link>
      </>
      break
    case 'reanalysis':
      title = '양식을 다시 분석해야 해요'
      body = `${code === 'SOURCE_CHANGED' ? '공고의 첨부 파일이 바뀌었어요. 바뀐 양식으로 다시 분석해 주세요.'
        : '양식의 입력칸 위치를 확인하지 못했어요. 양식을 다시 분석하면 해결될 수 있어요.'} 다시 분석하면 새 문서로 시작하고, 지금 문서와 답변은 목록에 그대로 남아요.`
      actions = <Link className={n.secondarySm} to={reanalyzeTo}>양식 다시 분석해 새로 시작</Link>
      break
    case 'userFix':
      if (code === 'INPUT_REQUIRED') {
        title = '저장된 답변이 없어 초안을 만들 수 없어요'
        body = '답변을 먼저 저장해 주세요. 검토 단계에서 비어 있는 필수 질문을 확인할 수 있어요.'
        actions = toEditor(review)
      } else if (code === 'OVERFLOW') {
        title = '답변이 입력칸보다 길어요'
        body = '줄인 뒤 다시 만들어 주세요. 답변은 그대로 저장되어 있어요.'
        actions = toEditor(editorTo)
      } else {
        title = '답변이 바뀌었어요'
        body = '최신 답변으로 다시 만들어 주세요.'
        actions = toEditor(editorTo)
      }
      break
    case 'serviceDown':
      title = '지금은 초안 만들기를 쓸 수 없어요'
      body = '서비스 쪽 문제라 다시 시도해도 해결되지 않아요. 답변은 그대로 있고, 문제가 풀리면 이 화면에서 다시 만들 수 있어요.'
      actions = toEditor(editorTo)
      break
    case 'outcomeUnknown':
      title = '초안 결과를 확인하고 있어요'
      body = '파일이 만들어졌는지 아직 확인하지 못했어요. 같은 초안이 두 번 만들어지지 않도록 확인이 끝날 때까지 새로 만들 수 없어요. 확인이 끝나면 자동으로 풀리고, 이 화면을 다시 열면 결과부터 확인해요. 답변은 그대로 저장되어 있어요.'
      break
    default:
      title = '일시적인 문제로 초안을 만들지 못했어요'
      body = '잠시 후 다시 시도해 주세요. 답변은 그대로 저장되어 있어요.'
      actions = <button type="button" className={n.secondarySm} disabled={retryDisabled} onClick={onRetry}>다시 시도</button>
  }
  return <div className={`${n.alert} ${group === 'temporary' ? n.alertDanger : n.alertWarning}`} role="alert">
    <div className={n.alertText}>
      <strong className={n.alertTitle}>{title}</strong>
      <p>{body}</p>
      {job.failureMessage && <p className={d.failureDetail}>{job.failureMessage}</p>}
    </div>
    {actions && <div className={d.alertActions}>{actions}</div>}
  </div>
}

/** 진행 카드의 서버 단계 목록입니다. 순서를 기다리는 동안은 모두 대기, 실행 중인데 단계가 아직 없으면 첫 단계를 진행 중으로 둡니다. */
function StageList({ job }: { job: ApplicationDocumentGenerationJob }) {
  const current = job.status === 'QUEUED' ? -1 : Math.max(0, generationStages.findIndex(([stage]) => stage === job.stage))
  return <ol className={d.stageList} aria-label="진행 단계">
    {generationStages.map(([stage, label], index) => {
      const state = index < current ? 'done' : index === current ? 'active' : 'idle'
      return <li key={stage} className={state === 'done' ? d.stageDone : state === 'active' ? d.stageActive : d.stage} aria-current={state === 'active' ? 'step' : undefined}>
        <span className={state === 'done' ? d.stageMarkDone : state === 'active' ? d.stageMarkActive : d.stageMark} aria-hidden="true">
          {state === 'done' && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>}
          {state === 'active' && <ButtonSpinner />}
        </span>
        {label}<span className="sr-only"> · {state === 'done' ? '완료' : state === 'active' ? '진행 중' : '대기'}</span>
      </li>
    })}
  </ol>
}
