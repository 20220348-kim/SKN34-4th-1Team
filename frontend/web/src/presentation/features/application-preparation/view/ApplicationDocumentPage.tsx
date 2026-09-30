import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import { useAppSelector } from '../../../../app/hooks'
import type { ApplicationDocument, ApplicationDocumentGenerationJob, ApplicationDocumentMigrationNotice, ApplicationPreparation } from '../../../../domain/entities/ApplicationPreparation'
import { ApplicationPreparationError } from '../../../../domain/errors/ApplicationPreparationError'
import { selectCurrentAccount } from '../../../shared/auth/state/authSlice'
import { appPaths } from '../../../shared/routes/appPaths'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'
import { applicationPreparationStyles as s } from './ApplicationPreparation.styles'

export function ApplicationDocumentPage() {
  const account = useAppSelector(selectCurrentAccount)
  const { preparationId } = useParams()
  const id = Number(preparationId)
  if (!account) return null
  if (!Number.isSafeInteger(id) || id <= 0) return <p role="alert">올바른 신청 준비 주소가 아닙니다.</p>
  return <DocumentResults key={`${account.email}:${id}`} id={id} />
}

/** 서버가 기록한 단계를 사람이 읽는 문장으로 바꾼다. 단계는 서버 작업 표의 값이라 화면이 추측하지 않는다. */
function stageLabel(job: ApplicationDocumentGenerationJob) {
  if (job.status === 'QUEUED') return '순서를 기다리고 있어요.'
  switch (job.stage) {
    case 'MAPPING': return '입력칸 위치를 확인하고 있어요.'
    case 'WRITING': return '답변을 문서에 기입하고 있어요.'
    case 'SAVING': return '파일을 저장하고 있어요.'
    default: return '공식 양식과 저장된 답변을 확인하고 있어요.'
  }
}

function DocumentResults({ id }: { id: number }) {
  const useCase = appContainer.resolve('applicationPreparationUseCase')
  const [search] = useSearchParams()
  const requestedRevision = useRef(search.get('generate'))
  const [preparation, setPreparation] = useState<ApplicationPreparation | null>(null)
  const [files, setFiles] = useState<ApplicationDocument[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
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
  const downloadController = useRef<AbortController | null>(null)
  const migrationController = useRef<AbortController | null>(null)
  const back = `${appPaths.applicationPreparations}/${id}`
  const latestRevision = files.length > 0 ? Math.max(...files.map((file) => file.inputRevision)) : null
  const latestFiles = files.filter((file) => file.inputRevision === latestRevision)
  const previousFiles = files.filter((file) => file.inputRevision !== latestRevision)
  // 같은 답변 버전은 기존 파일을 즉시 돌려주므로, 다시 만들기는 답변이 바뀐 뒤(현재 버전 파일 없음)에만 켠다.
  const canRegenerate = !busy && preparation !== null && !files.some((file) => file.inputRevision === preparation.inputRevision)
  const unanswered = preparation?.form.sections.flatMap((section) => section.fields
    .filter((field) => !section.facts.some((fact) => fact.fieldKey === field.key && fact.status === 'PROVIDED'))
    .map((field) => `${section.title} · ${field.label}`)) ?? []
  const reasonLabel = (reason: ApplicationDocument['unfilledAnswers'][number]['reason']) => reason === 'AUTO_FILL_UNSUPPORTED' ? '자동 기입 미지원' : '입력 위치 확인 불가'
  const changeTypeLabel: Record<ApplicationDocumentMigrationNotice['changes'][number]['changeType'], string> = {
    TARGET_ADDED: '새 입력칸', TARGET_REMOVED: '입력칸 사라짐', TARGET_CHANGED: '입력칸 변경',
    BOX_CHANGED: '입력 영역 변경', KIND_CHANGED: '입력 방식 변경', SCOPE_CHANGED: '편집 범위 변경',
  }

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
      setBusy(true); setBusySince(Date.now()); setError(null); setMigration(null); setJob(null)
      try {
        const [detail, stored, jobs] = await Promise.all([
          useCase.get(id, controller.signal),
          useCase.documents(id, controller.signal),
          useCase.documentJobs(id, controller.signal).catch(() => [] as ApplicationDocumentGenerationJob[]),
        ])
        if (controller.signal.aborted) return
        setPreparation(detail)
        let documents = stored
        let finished: ApplicationDocumentGenerationJob | null = null
        const running = active(jobs)
        if (running) {
          // 화면을 떠났다 돌아와도 진행 중인 작업을 이어받는다. 새 유료 생성을 시작하지 않는다.
          finished = await follow(running)
        } else if (requestedRevision.current !== null) {
          const revision = Number(requestedRevision.current)
          if (!Number.isSafeInteger(revision) || revision !== detail.inputRevision) throw new Error('답변이 변경되었습니다. 답변 입력으로 돌아가 최신 내용을 확인한 뒤 다시 생성해 주세요.')
          if (!documents.some((file) => file.inputRevision === revision)) {
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
        }
        if (finished) {
          // 실패·결과 불명이어도 앞서 저장된 파일이 있을 수 있으니 목록은 다시 읽는다.
          documents = await useCase.documents(id, controller.signal)
          if (controller.signal.aborted) return
          if (finished.status !== 'SUCCEEDED') {
            setFiles(documents)
            if (finished.mappingMigration) { setMigration(finished.mappingMigration); return }
            throw new Error(finished.failureMessage ?? '문서를 생성하지 못했습니다.')
          }
        }
        if (controller.signal.aborted) return
        setFiles(documents)
        requestedRevision.current = null
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '문서를 생성하지 못했습니다.')
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
      saveBlob(blob, `신청문서_초안_v${revision}.zip`)
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

  function renderFile(file: ApplicationDocument, index: number) {
    const extension = file.fileName.split('.').pop()?.toUpperCase() ?? ''
    return <section className={s.card} key={file.id} aria-label={`신청문서 ${index + 1}`}>
      <div className={s.badgeRow}><span className={s.badgeDeadline}>{extension}</span><span className={s.muted}>답변 버전 {file.inputRevision}</span></div>
      <h2 className={s.cardTitle}>{file.unfilledAnswerCount && file.unfilledAnswerCount > 0 ? '일부 항목 미기입 초안' : `신청문서 ${index + 1}`}</h2>
      <p className="break-all font-semibold">{file.fileName}</p>
      <p className={s.muted}>원본과 같은 {extension} 형식 · 답변 버전 {file.inputRevision} · {Math.ceil(file.size / 1024)} KB</p>
      {preparation && <><p className={s.label}>문서에 포함된 작성 항목</p><ul className={s.fieldList}>{preparation.form.sections.map((section) => <li key={section.key}>{section.title}</li>)}</ul></>}
      <button type="button" className={s.primary} disabled={downloading !== null || archiving} onClick={() => { void download(file) }}>{downloading === file.id ? '다운로드 중…' : `신청문서 ${index + 1} 다운로드`}</button>
      {file.filledAnswerCount !== null && file.unfilledAnswerCount !== null && <p className={s.muted}>{file.filledAnswerCount}개 기입 / {file.unfilledAnswerCount}개 미기입</p>}
      {file.unfilledAnswers.length > 0 && <details className={s.warning}>
        <summary className={s.label}>자동 기입 못한 답변 보기 ({file.unfilledAnswers.length})</summary>
        <div aria-label="자동 기입하지 못한 답변">
          <ul>{file.unfilledAnswers.map((answer) => <li key={answer.fieldId}><strong>{answer.fieldLabel}</strong>: {answer.value} — {reasonLabel(answer.reason)}</li>)}</ul>
        </div>
      </details>}
      <p className={s.muted}>문서를 다운로드해 내용을 확인하세요. 내려받은 파일에서 직접 수정하거나, 답변 입력으로 돌아가 정보를 고친 뒤 다시 생성할 수 있습니다.</p>
    </section>
  }

  return <>
    <WorkspacePageHeader parent={[
      { to: appPaths.applicationPreparations, label: '신청 문서 작성 도우미' },
      { to: back, label: '신청 문서 / 답변 입력' },
    ]} title="신청 문서 초안" actions={<>
      <button type="button" className={s.button} disabled={!canRegenerate} title={canRegenerate ? undefined : '답변을 바꾼 뒤에만 새 버전을 만들 수 있어요'} onClick={() => {
        if (!preparation) return
        requestedRevision.current = String(preparation.inputRevision); setAttempt((n) => n + 1)
      }}>다시 만들기</button>
      {latestRevision !== null && latestFiles.length > 1 && <button type="button" className={s.primary} disabled={busy || downloading !== null || archiving} onClick={() => { void downloadArchive(latestRevision) }}>
        {archiving ? '묶는 중…' : '전체 내려받기'}
      </button>}
    </>} />
    <main className={workspacePageStyles.content}>
      {busy && <section className={s.notice} role="status" aria-label="문서 생성 진행">
        <p><strong>{job ? `답변 버전 ${job.expectedRevision}로 만들고 있어요` : requestedRevision.current !== null ? `답변 버전 ${requestedRevision.current}로 만들고 있어요` : '저장된 문서를 확인하고 있어요'}</strong> · 경과 {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')}</p>
        <p>{job ? stageLabel(job) : '저장된 문서와 진행 중인 생성 작업을 확인하고 있어요.'} 화면을 나가도 계속돼요. 돌아오면 진행 중인 작업을 이어서 보여 드려요.</p>
      </section>}
      {error && <div className={s.warning} role="alert"><p>{error}</p>{!busy && <button type="button" className={s.button} onClick={() => setAttempt((n) => n + 1)}>다시 시도</button>}</div>}
      {error && preparation && <Link className={s.button} to={`${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: preparation.form.sourceCode, sourceProgramId: preparation.form.sourceProgramId })}`}>기존 답변을 보관하고 입력칸별 양식 확인</Link>}
      {migration && <section className={s.card} aria-label="신청서 입력 위치 변경 확인">
        <h2 className={s.cardTitle}>입력 위치가 변경됐습니다</h2>
        <p className={s.notice}>승인 전에는 새 위치를 저장하거나 기존 답변·파일을 수정하지 않습니다. 아래 변경을 확인해 주세요.</p>
        <ul className={s.fieldList}>{migration.changes.map((change, index) => <li key={`${change.fieldLabel}-${index}`}>
          <strong>{change.fieldLabel}</strong> · {changeTypeLabel[change.changeType]}
          <p>기존: {change.oldLocation ?? '입력 위치 없음'}</p>
          <p>새 위치: {change.newLocation ?? '입력 위치 없음'}</p>
        </li>)}</ul>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={s.primary} disabled={migrationBusy} onClick={() => { void confirmMigration() }}>
            {migrationBusy ? '적용 중…' : '새 입력 위치 적용'}
          </button>
          <button type="button" className={s.button} disabled={migrationBusy} onClick={() => {
            setMigration(null); setMigrationMessage('변경 적용을 취소했습니다. 기존 답변과 파일은 그대로 유지됩니다.')
          }}>취소하고 기존 작성 유지</button>
        </div>
      </section>}
      {migrationMessage && <div className={s.notice} role="status"><p>{migrationMessage}</p>
        {regenerationRevision !== null && <button type="button" className={s.button} onClick={() => {
          requestedRevision.current = String(regenerationRevision); setRegenerationRevision(null); setMigrationMessage(null); setAttempt((n) => n + 1)
        }}>새 초안 생성</button>}
      </div>}
      {!busy && !error && files.length === 0 && <p className={s.notice}>현재 답변으로 생성된 문서가 없습니다. 답변 입력에서 초안 생성하기를 눌러 주세요.</p>}
      {!busy && latestFiles.map((file, index) => renderFile(file, index))}
      {!busy && previousFiles.length > 0 && <details className={s.card}>
        <summary className={s.label}>이전 버전 {previousFiles.length}개 보기</summary>
        <div className="mt-3 flex flex-col gap-3">{previousFiles.map((file, index) => renderFile(file, latestFiles.length + index))}</div>
      </details>}
      {!busy && files.length > 0 && unanswered.length > 0 && <section className={s.warning} aria-label="답변이 없어 기입하지 않은 항목">
        <h2 className={s.cardTitle}>답변이 없어 기입하지 않은 항목</h2>
        <p>미정으로 저장했거나 답변하지 않은 항목입니다. 아래 항목은 자동으로 채우지 않았으므로 제출 전에 확인해 주세요.</p>
        <ul>{unanswered.map((label) => <li key={label}>{label}</li>)}</ul>
        <Link className={s.button} to={back}>답변 입력으로</Link>
      </section>}
      <p className={s.notice}>한 원본 파일에 여러 신청서가 있으면 한 파일로 제공됩니다. 내려받은 문서의 기입 위치와 내용, 줄바꿈을 확인한 뒤 제출해 주세요.</p>
      <Link className={s.button} to={back}>이전으로 · 답변 수정</Link>
    </main>
  </>
}
