import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import { useAppSelector } from '../../../../app/hooks'
import type { ApplicationDocument, ApplicationPreparation } from '../../../../domain/entities/ApplicationPreparation'
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
  const downloadController = useRef<AbortController | null>(null)
  const back = `${appPaths.applicationPreparations}/${id}`
  const unanswered = preparation?.form.sections.flatMap((section) => section.fields
    .filter((field) => !section.facts.some((fact) => fact.fieldKey === field.key && fact.status === 'PROVIDED'))
    .map((field) => `${section.title} · ${field.label}`)) ?? []
  const reasonLabel = (reason: ApplicationDocument['unfilledAnswers'][number]['reason']) => reason === 'AUTO_FILL_UNSUPPORTED' ? '자동 기입 미지원' : '입력 위치 확인 불가'

  useEffect(() => {
    const controller = new AbortController()
    async function waitForExistingDocuments(revision: number) {
      // A cancelled browser request does not cancel server-side file generation.
      // Recover its stored result with GET only; never automatically repeat the paid POST.
      // Match the generation request budget: a cold run includes mapping and writing.
      const deadline = Date.now() + 660_000
      while (Date.now() < deadline) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve() }, 3000)
          controller.signal.addEventListener('abort', abort, { once: true })
          if (controller.signal.aborted) abort()
        })
        const documents = await useCase.documents(id, controller.signal)
        if (documents.some((file) => file.inputRevision === revision)) {
          return documents
        }
      }
      throw new Error('기존 문서 생성 결과를 아직 확인하지 못했습니다. 잠시 후 다시 시도해 주세요. 답변은 저장되어 있습니다.')
    }
    async function load() {
      setBusy(true); setError(null)
      try {
        const detail = await useCase.get(id, controller.signal)
        if (controller.signal.aborted) return
        setPreparation(detail)
        let documents = await useCase.documents(id, controller.signal)
        if (controller.signal.aborted) return
        if (requestedRevision.current !== null) {
          const revision = Number(requestedRevision.current)
          if (!Number.isSafeInteger(revision) || revision !== detail.inputRevision) throw new Error('답변이 변경되었습니다. 답변 입력으로 돌아가 최신 내용을 확인한 뒤 다시 생성해 주세요.')
          if (!documents.some((file) => file.inputRevision === revision)) {
            try {
              const generated = await useCase.generateDocuments(id, revision, controller.signal)
              documents = [...generated, ...documents.filter((file) => !generated.some((created) => created.id === file.id))]
            } catch (caught) {
              if (controller.signal.aborted) throw caught
              if (caught instanceof ApplicationPreparationError && caught.code === 'APPLICATION_PREPARATION_RUN_CONFLICT') {
                documents = await waitForExistingDocuments(revision)
              } else if (caught instanceof ApplicationPreparationError && ['REQUEST_TIMEOUT', 'REQUEST_FAILED'].includes(caught.code)) {
                throw new Error('문서 생성 요청의 결과를 확인하지 못했습니다. 답변은 저장되어 있습니다. 잠시 후 다시 시도하면 저장된 결과부터 확인합니다.')
              } else throw caught
            }
          }
        }
        if (controller.signal.aborted) return
        setFiles(documents)
        requestedRevision.current = null
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '문서를 생성하지 못했습니다.')
      } finally { if (!controller.signal.aborted) setBusy(false) }
    }
    void load()
    return () => { controller.abort(); downloadController.current?.abort() }
  }, [id, useCase, attempt])

  async function download(file: ApplicationDocument) {
    if (downloadController.current) return
    const controller = new AbortController()
    downloadController.current = controller
    setDownloading(file.id); setError(null)
    try {
      const blob = await useCase.downloadDocument(id, file.id, controller.signal)
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = file.fileName
      document.body.appendChild(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '다운로드하지 못했습니다.')
    } finally {
      if (!controller.signal.aborted) setDownloading(null)
      if (downloadController.current === controller) downloadController.current = null
    }
  }

  return <>
    <WorkspacePageHeader parent={[
      { to: appPaths.applicationPreparations, label: '신청 문서 작성 도우미' },
      { to: back, label: '신청 문서 / 답변 입력' },
    ]} title="신청 문서 초안" />
    <main className={workspacePageStyles.content}>
      {busy && <p className={s.notice} role="status">공식 양식을 확인하고 저장된 답변으로 문서를 준비하고 있습니다…</p>}
      {error && <div className={s.warning} role="alert"><p>{error}</p>{!busy && <button type="button" className={s.button} onClick={() => setAttempt((n) => n + 1)}>다시 시도</button>}</div>}
      {error && preparation && <Link className={s.button} to={`${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: preparation.form.sourceCode, sourceProgramId: preparation.form.sourceProgramId })}`}>기존 답변을 보관하고 입력칸별 양식 확인</Link>}
      {!busy && !error && files.length === 0 && <p className={s.notice}>현재 답변으로 생성된 문서가 없습니다. 답변 입력에서 초안 생성하기를 눌러 주세요.</p>}
      {!busy && files.map((file, index) => <section className={s.card} key={file.id} aria-label={`신청문서 ${index + 1}`}>
        <h2 className={s.cardTitle}>{file.unfilledAnswerCount && file.unfilledAnswerCount > 0 ? '일부 항목 미기입 초안' : `신청문서 ${index + 1}`}</h2>
        <p className="break-all font-semibold">{file.fileName}</p>
        <p className={s.muted}>원본과 같은 {file.fileName.split('.').pop()?.toUpperCase()} 형식 · 답변 버전 {file.inputRevision} · {Math.ceil(file.size / 1024)} KB</p>
        {preparation && <><p className={s.label}>문서에 포함된 작성 항목</p><ul className={s.fieldList}>{preparation.form.sections.map((section) => <li key={section.key}>{section.title}</li>)}</ul></>}
        <button type="button" className={s.primary} disabled={downloading !== null} onClick={() => { void download(file) }}>{downloading === file.id ? '다운로드 중…' : `신청문서 ${index + 1} 다운로드`}</button>
        {file.filledAnswerCount !== null && file.unfilledAnswerCount !== null && <p className={s.muted}>{file.filledAnswerCount}개 기입 / {file.unfilledAnswerCount}개 미기입</p>}
        {file.unfilledAnswers.length > 0 && <div className={s.warning} aria-label="자동 기입하지 못한 답변">
          <p className={s.label}>자동 기입하지 못한 답변</p>
          <ul>{file.unfilledAnswers.map((answer) => <li key={answer.fieldId}><strong>{answer.fieldLabel}</strong>: {answer.value} — {reasonLabel(answer.reason)}</li>)}</ul>
        </div>}
        <p className={s.muted}>문서를 다운로드해 내용을 확인하세요. 내려받은 파일에서 직접 수정하거나, 답변 입력으로 돌아가 정보를 고친 뒤 다시 생성할 수 있습니다.</p>
      </section>)}
      {!busy && files.length > 0 && unanswered.length > 0 && <section className={s.warning} aria-label="답변이 없어 기입하지 않은 항목">
        <h2 className={s.cardTitle}>답변이 없어 기입하지 않은 항목</h2>
        <p>미정으로 저장했거나 답변하지 않은 항목입니다. 아래 항목은 자동으로 채우지 않았으므로 제출 전에 확인해 주세요.</p>
        <ul>{unanswered.map((label) => <li key={label}>{label}</li>)}</ul>
      </section>}
      <p className={s.notice}>한 원본 파일에 여러 신청서가 있으면 한 파일로 제공됩니다. 내려받은 문서의 기입 위치와 내용, 줄바꿈을 확인한 뒤 제출해 주세요.</p>
      <Link className={s.button} to={back}>이전으로 · 답변 수정</Link>
    </main>
  </>
}
