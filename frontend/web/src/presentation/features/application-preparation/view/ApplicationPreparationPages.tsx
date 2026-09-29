import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SelectField } from '../../../shared/workspace/SelectField'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useAppSelector } from '../../../../app/hooks'
import {
  applicationDeadlineDays,
  applicationServiceFieldLabels,
  type ApplicationForm,
  type ApplicationFormField,
  type ApplicationFormSection,
  type ApplicationPreparationListStatus,
  type ApplicationPreparationSummary,
} from '../../../../domain/entities/ApplicationPreparation'
import { catalogSourceLabels } from '../../../../domain/entities/SupportProgramCatalog'
import { ApplicationPreparationError } from '../../../../domain/errors/ApplicationPreparationError'
import { selectCurrentAccount } from '../../../shared/auth/state/authSlice'
import { appPaths } from '../../../shared/routes/appPaths'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { WorkspaceModal } from '../../../shared/workspace/WorkspaceModal'
import { WorkspaceToast } from '../../../shared/workspace/WorkspaceToast'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'
import { workspaceToastActionClassName } from '../../../shared/workspace/WorkspaceToast.styles'
import { useFloatingPopover } from '../../../shared/workspace/useFloatingPopover'
import { SavedSupportProgramPickerDialog } from '../../../shared/support-program/SavedSupportProgramPickerDialog'
import { SupportProgramSearchFilters } from '../../../shared/support-program/SupportProgramSearchFilters'
import { answerMaxLength, undecidedAnswer, useApplicationPreparationEditorViewModel } from '../viewmodel/useApplicationPreparationEditorViewModel'
import { useApplicationPreparationListViewModel } from '../viewmodel/useApplicationPreparationListViewModel'
import { answerEditorStyles as e, applicationPreparationStyles as s } from './ApplicationPreparation.styles'


import { ApplicationOnlineInputGuide } from './ApplicationOnlineInputGuide'

const listTitle = '신청 문서 작성'
/** 사이드바 항목과 같은 이름입니다. 답변 입력·새 문서 화면의 상위 경로에 씁니다. */
const featureTitle = '신청 문서 작성'
const programStatusLabels = {
  OPEN: '접수 중',
  UPCOMING: '접수 예정',
  CLOSED: '접수 종료',
  UNKNOWN: '접수 상태 미확인',
} as const
function readableTime(value: string) {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function ErrorNotice({ message, retryLabel, onRetry, officialSource }: {
  message: string
  retryLabel?: string
  onRetry?: () => void
  officialSource?: { title: string; url: string }
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { ref.current?.focus() }, [message])
  return <div className={s.warning} ref={ref} role="alert" tabIndex={-1}>
    <p>{message}</p>
    {(onRetry || officialSource) && <div className="mt-3 flex flex-wrap gap-3">
      {onRetry && <button className={s.button} type="button" onClick={onRetry}>{retryLabel ?? '다시 시도'}</button>}
      {officialSource && <a className={s.officialLink} href={officialSource.url} target="_blank" rel="noreferrer">
        공고 원문 열기<span className="sr-only">: {officialSource.title} (새 창)</span>
      </a>}
    </div>}
  </div>
}

function OfficialFormSummary({ form }: { form: ApplicationForm }) {
  return <section className={s.card} aria-labelledby="official-form-summary-title">
    <h2 className={s.cardTitle} id="official-form-summary-title">공고 및 공식 양식</h2>
    <dl className={s.details}>
      <div><dt>공고명</dt><dd>{form.programTitle}</dd></div>
      <div><dt>공식 첨부</dt><dd>{form.attachmentFileName}</dd></div>
    </dl>
    <p className={s.muted}>{form.verificationStatus === 'SOURCE_DOCUMENT_EXTRACTED'
      ? '공식 첨부에서 AI가 추출한 작성 문항입니다. 작성 문항과 원문을 직접 대조해 주세요.'
      : '공식 첨부와 작성 문항을 확인한 양식입니다.'} 기관 검수 완료나 선정 가능성을 뜻하지 않습니다.</p>
    <a className={s.officialLink} href={form.sourceUrl} target="_blank" rel="noreferrer">
      공식 공고 열기<span className="sr-only">: {form.programTitle} (새 창)</span>
    </a>
  </section>
}

// ── 답변 입력(25) ──

type EditorViewModel = ReturnType<typeof useApplicationPreparationEditorViewModel>
type Question = { section: ApplicationFormSection; field: ApplicationFormField; sectionIndex: number; key: string }

/** 자동 기입할 수 있는 문항만 답변 대상으로 셉니다. 나머지는 원문에서 직접 작성합니다. */
function writable(field: ApplicationFormField) { return field.documentWritable !== false }

function savedTimeLabel(savedAt: number, now: number) {
  const elapsed = now - savedAt
  if (elapsed < 60_000) return '방금'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}분 전`
  return new Intl.DateTimeFormat('ko-KR', { timeStyle: 'short' }).format(new Date(savedAt))
}

/** 항목 목록(PC 왼쪽 · 모바일 시트)입니다. 전체 진행, 항목별 상태, [초안 만들기]를 한 벌로 그립니다. */
function SectionNav({ sections, valueOf, activeSectionIndex, onSelect, generate }: {
  sections: ApplicationFormSection[]
  valueOf: (section: ApplicationFormSection, field: ApplicationFormField) => string
  activeSectionIndex: number
  onSelect: (sectionIndex: number) => void
  generate: { disabled: boolean; hint: string | null; onClick: () => void }
}) {
  const totals = sections.reduce((sum, section) => {
    const fields = section.fields.filter(writable)
    return { answered: sum.answered + fields.filter((field) => valueOf(section, field).trim()).length, total: sum.total + fields.length }
  }, { answered: 0, total: 0 })
  return <>
    <div className={e.progress}>
      <p className={e.progressLabel}><span>답변</span><span className={e.progressCount}>{totals.answered} / {totals.total}</span></p>
      <div className={e.progressBar} role="progressbar" aria-label="전체 답변 진행" aria-valuemin={0} aria-valuemax={totals.total} aria-valuenow={totals.answered}>
        <span className={e.progressFill} style={{ width: `${totals.total === 0 ? 0 : Math.round((totals.answered / totals.total) * 100)}%` }} />
      </div>
    </div>
    <ol className={e.sectionList}>
      {sections.map((section, index) => {
        const fields = section.fields.filter(writable)
        const answered = fields.filter((field) => valueOf(section, field).trim()).length
        const status = fields.length === 0 ? '원문에서 직접 작성' : answered === fields.length ? '완료' : answered > 0 ? '진행 중' : '시작 전'
        const done = fields.length > 0 && answered === fields.length
        const active = index === activeSectionIndex
        return <li key={section.key}>
          <button type="button" className={e.sectionButton} aria-current={active ? 'step' : undefined} onClick={() => onSelect(index)}>
            <span className={`${e.sectionNumber} ${done ? e.sectionNumberDone : active ? e.sectionNumberActive : ''}`} aria-hidden="true">{done ? '✓' : index + 1}</span>
            <span className={e.sectionText}>
              <span className={e.sectionTitle}>{index + 1}. {section.title}</span>
              <span className={e.sectionMeta} aria-label={`작성 상태: ${status}`}>{fields.length === 0 ? status : `답변 ${answered} / ${fields.length} · ${status}`}</span>
            </span>
          </button>
        </li>
      })}
    </ol>
    <button type="button" className={e.generateButton} disabled={generate.disabled} onClick={generate.onClick}>초안 만들기</button>
    {generate.hint && <p className={e.generateHint}>{generate.hint}</p>}
  </>
}

function AnswerEditor({ vm }: { vm: EditorViewModel }) {
  const navigate = useNavigate()
  const preparation = vm.preparation!
  const form = preparation.form
  const sections = form.sections
  const questions = useMemo<Question[]>(() => sections.flatMap((section, sectionIndex) =>
    section.fields.map((field) => ({ section, field, sectionIndex, key: `${section.key}:${field.key}` }))), [sections])
  const valueOf = (section: ApplicationFormSection, field: ApplicationFormField) => {
    const key = `${section.key}:${field.key}`
    if (vm.deletedAnswerKeys.has(key)) return ''
    if (Object.hasOwn(vm.sectionMessages, key)) return vm.sectionMessages[key]
    const fact = section.facts.find((saved) => saved.fieldKey === field.key)
    return fact?.status === 'UNKNOWN' ? undecidedAnswer : fact?.value ?? ''
  }
  // 들어오면 아직 답하지 않은 첫 필수 질문부터 엽니다(마지막으로 본 질문은 저장하지 않음). 모두 답했으면 첫 질문.
  const [index, setIndex] = useState(() => {
    const open = questions.findIndex(({ section, field }) => field.required && writable(field) && !valueOf(section, field).trim())
    return open === -1 ? 0 : open
  })
  const [sheetOpen, setSheetOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menu = useFloatingPopover({ open: menuOpen, placement: 'bottom-end' })
  const current = questions[Math.min(index, Math.max(0, questions.length - 1))]
  const currentValue = current ? valueOf(current.section, current.field) : ''
  const undecided = currentValue === undecidedAnswer
  const options = current?.field.options ?? []
  const missingOptions = current ? options.length === 0 && /택\s*1|하나.{0,10}선택|중.{0,10}선택/.test(`${current.field.label} ${current.field.guidance}`) : false
  const requiredMissing = questions.filter(({ section, field }) => field.required && writable(field) && !valueOf(section, field).trim()).length
  const failed = vm.autosave.status === 'failed' ? vm.autosave : null
  const fieldError = current && vm.fieldError?.key === current.key ? vm.fieldError.message : null

  // "자동 저장됨 · 방금"이 시간이 지나면 "n분 전"으로 바뀌도록 30초마다 다시 그립니다.
  useEffect(() => {
    if (vm.autosave.status !== 'saved') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [vm.autosave])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: Event) => { if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) setMenuOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  function go(next: number) {
    void vm.flushAutosave()
    setIndex(Math.max(0, Math.min(questions.length - 1, next)))
    setSheetOpen(false)
    headingRef.current?.focus()
  }
  function goSection(sectionIndex: number) {
    const inSection = questions.filter((question) => question.sectionIndex === sectionIndex)
    const open = inSection.find(({ section, field }) => writable(field) && !valueOf(section, field).trim()) ?? inSection[0]
    if (open) go(questions.indexOf(open))
    else setSheetOpen(false)
  }
  async function generate() {
    if (!(await vm.flushAutosave())) return
    const revision = vm.latestRevision()
    if (revision !== null) navigate(`${appPaths.applicationPreparations}/${preparation.id}/documents?generate=${revision}`)
  }
  const generateHint = requiredMissing > 0 ? `필수 답변 ${requiredMissing}개가 남았어요. 모르는 값은 "아직 정해지지 않았어요"로 둘 수 있어요.` : null
  const statusLabel = vm.autosave.status === 'saving' ? '저장 중…'
    : vm.autosave.status === 'saved' ? `자동 저장됨 · ${savedTimeLabel(vm.autosave.savedAt, now)}`
      : vm.autosave.status === 'failed' ? '저장 실패' : vm.hasPendingAnswers ? '입력을 멈추면 저장돼요' : '입력하면 자동으로 저장돼요'
  const reanalyzeTo = `${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: form.sourceCode, sourceProgramId: form.sourceProgramId })}`
  const documentsTo = `${appPaths.applicationPreparations}/${preparation.id}/documents`
  const nav = <SectionNav sections={sections} valueOf={valueOf} activeSectionIndex={current?.sectionIndex ?? 0} onSelect={goSection}
    generate={{ disabled: requiredMissing > 0 || questions.length === 0, hint: generateHint, onClick: () => { void generate() } }} />
  const isLast = current ? index >= questions.length - 1 : true

  return <>
    <WorkspacePageHeader
      parent={{ to: appPaths.applicationPreparations, label: featureTitle }}
      title="답변 입력"
      actions={<>
        <button type="button" className={`${e.iconButton} ${e.iconButtonM}`} aria-label="항목 목록" aria-haspopup="dialog" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)}>☰</button>
        {vm.documentCount > 0 && <Link className={e.headerButton} to={documentsTo}>문서 보기</Link>}
        <div ref={menuRef} className="relative">
          <button ref={menu.reference} type="button" className={e.iconButton} aria-label="문서 메뉴" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>⋯</button>
          {menuOpen && <div ref={menu.floating} style={menu.floatingStyles} className={e.menu} role="menu" aria-label="문서 메뉴">
            <a className={e.menuItem} role="menuitem" href={form.sourceUrl} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}>원문 보기 ↗</a>
            <Link className={e.menuItem} role="menuitem" to={reanalyzeTo} onClick={() => setMenuOpen(false)}>양식 다시 분석해 새로 시작</Link>
            {vm.documentCount > 0 && <Link className={`${e.menuItem} min-[600px]:hidden`} role="menuitem" to={documentsTo} onClick={() => setMenuOpen(false)}>문서 보기</Link>}
          </div>}
        </div>
      </>}
    />
    <main className={workspacePageStyles.content}>
      <div className={e.infoAlert} role="note">
        <div className={e.infoText}>
          <strong className={e.infoTitle}>{form.programTitle}</strong>
          <span>{form.attachmentFileName}</span> · {form.verificationStatus === 'SOURCE_DOCUMENT_EXTRACTED'
            ? '공식 첨부에서 AI가 추출한 문항입니다. 원문과 직접 대조해 주세요.'
            : '공식 첨부와 작성 문항을 확인한 양식입니다.'} 기관 검수나 선정 가능성을 뜻하지 않으며, 저장한 답변은 기관에 자동 제출되지 않습니다.
        </div>
        <a className={e.infoLink} href={form.sourceUrl} target="_blank" rel="noreferrer">원문 보기 ↗<span className="sr-only">: {form.programTitle} (새 창)</span></a>
      </div>

      <div className={e.layout}>
        <aside className={e.aside} aria-label="신청 문서 작성 항목 목록">{nav}</aside>
        <div className="flex min-w-0 flex-col gap-3">
          {current && <div className={e.stepperM}>
            <p className={e.stepperMLabel}><span>{current.section.title}</span><span className="tabular-nums">{index + 1} / {questions.length}</span></p>
            <div className={e.progressBar} aria-hidden="true"><span className={e.progressFill} style={{ width: `${Math.round(((index + 1) / questions.length) * 100)}%` }} /></div>
          </div>}
          {failed && <div className={e.dangerAlert} role="alert">
            <p className={e.dangerText}>{failed.conflict
              ? '다른 곳에서 답변이 먼저 바뀌어 최신 답변을 다시 불러왔어요. 입력 중이던 값을 확인한 뒤 다시 저장해 주세요.'
              : `답변을 저장하지 못했어요. ${failed.error.message}`}</p>
            <button type="button" className={e.retryButton} onClick={vm.retryAutosave}>다시 시도</button>
          </div>}
          {current ? <section className={e.question} aria-label={`${current.section.title} 작성`}>
            <p className={e.questionEyebrow}>항목 {current.sectionIndex + 1} / {sections.length} · 질문 {index + 1} / {questions.length}</p>
            <h3 className={e.questionTitle} ref={headingRef} tabIndex={-1}>
              {current.field.label}
              <span className={current.field.required ? e.requiredTag : e.optionalTag}>{current.field.required ? '필수' : '선택'}</span>
            </h3>
            {current.field.guidance && <p className={e.guidance}>{current.field.guidance}</p>}
            {!writable(current.field) && <p className={s.warning}>이 항목은 자동 기입할 수 없습니다. 내려받은 원본 문서에서 직접 작성해 주세요.</p>}
            {options.length > 0
              ? <fieldset className={e.choiceList} disabled={!writable(current.field) || undecided}>
                <legend className="sr-only">공식 선택지 중 하나를 선택하세요</legend>
                {options.map((option) => <label className={e.choice} key={option}>
                  <input type="radio" name={`choice-${current.key}`} value={option} checked={currentValue === option} onChange={() => vm.setSectionMessage(current.key, option)} />
                  {option}
                </label>)}
              </fieldset>
              : <>
                <textarea
                  className={e.textarea}
                  aria-label="답변 입력"
                  aria-invalid={fieldError ? true : undefined}
                  disabled={!writable(current.field) || undecided}
                  id={`section-answer-${current.section.key}`}
                  maxLength={answerMaxLength}
                  value={undecided ? '' : currentValue}
                  onChange={(event) => vm.setSectionMessage(current.key, event.target.value)}
                  placeholder="확인된 사실만 적어 주세요."
                />
                <p className={`${e.counter} ${[...currentValue].length > answerMaxLength ? e.counterOver : ''}`} aria-hidden="true">
                  {undecided ? 0 : [...currentValue].length} / {answerMaxLength.toLocaleString('ko-KR')}
                </p>
              </>}
            {fieldError && <p className={e.fieldError} role="alert">{fieldError}</p>}
            <div className={e.answerActions}>
              <label className={e.undecided}>
                <input type="checkbox" checked={undecided} disabled={!writable(current.field)}
                  onChange={(event) => vm.setSectionMessage(current.key, event.target.checked ? undecidedAnswer : '')} />
                아직 정해지지 않았어요
              </label>
              {writable(current.field) && currentValue && <button type="button" className={e.clearButton} onClick={() => vm.deleteSectionAnswer(current.key)}>답변 지우기</button>}
            </div>
            {missingOptions && <p className={s.warning}>공식 선택지를 확인하지 못했습니다. 공식 공고에서 첨부 양식의 선택지를 확인한 뒤 입력해 주세요. <a className="underline" href={form.sourceUrl} target="_blank" rel="noreferrer">공식 공고 열기</a></p>}
          </section> : <p className={s.notice}>이 양식에는 자동 기입할 문항이 없습니다. 원문 양식에서 직접 작성해 주세요.</p>}
          <div className={e.bar}>
            <button type="button" className={e.prevButton} disabled={index === 0 || !current} onClick={() => go(index - 1)}>← 이전</button>
            <p className={e.barStatus} role="status" aria-live="polite">{statusLabel}</p>
            {isLast
              ? <button type="button" className={e.nextButton} disabled={requiredMissing > 0 || questions.length === 0} onClick={() => { void generate() }}>초안 만들기</button>
              : <button type="button" className={e.nextButton} onClick={() => go(index + 1)}>다음 →</button>}
          </div>
          <p className={e.barStatusM} role="status" aria-live="polite">{statusLabel}</p>
          <ApplicationOnlineInputGuide preparationId={preparation.id} inputRevision={preparation.inputRevision} />
        </div>
      </div>
    </main>
    {sheetOpen && <>
      <button type="button" className={e.sheetScrim} aria-label="항목 목록 닫기" onClick={() => setSheetOpen(false)} />
      <div className={e.sheet} role="dialog" aria-modal="true" aria-label="항목 목록">
        <span className={e.sheetGrab} aria-hidden="true" />
        <div className={e.sheetHeader}>
          <h2 className={e.sheetTitle}>항목 목록</h2>
          <button type="button" className={e.iconButton} aria-label="닫기" onClick={() => setSheetOpen(false)}>✕</button>
        </div>
        {nav}
      </div>
    </>}
    <WorkspaceToast
      notice={vm.deletedAnswerNotice ? { id: vm.deletedAnswerNotice.id, text: `${vm.deletedAnswerNotice.label} 답변을 지웠어요` } : null}
      action={<button type="button" className={workspaceToastActionClassName} onClick={vm.undoDeletedAnswer}>되돌리기</button>}
      onClose={vm.dismissDeletedAnswerNotice}
    />
  </>
}

export function ApplicationPreparationListPage() {
  const account = useAppSelector(selectCurrentAccount)
  return account ? <ApplicationPreparationList key={account.email} /> : null
}

const listStatusTabs: { value: ApplicationPreparationListStatus | undefined; label: string }[] = [
  { value: undefined, label: '전체' }, { value: 'in_progress', label: '진행 중' }, { value: 'done', label: '완료' },
]
function deadlineBadge(item: ApplicationPreparationSummary) {
  const days = applicationDeadlineDays(item.applicationEndDate)
  if (days === null) return null
  if (days < 0) return { label: '접수 마감', className: s.badgeDeadline }
  return { label: days === 0 ? 'D-Day' : `D-${days}`, className: days <= 7 ? s.badgeUrgent : s.badgeDeadline }
}
function sourceLabel(sourceCode: string) {
  return (catalogSourceLabels as Record<string, string>)[sourceCode] ?? sourceCode
}

function ApplicationPreparationList() {
  const vm = useApplicationPreparationListViewModel()
  const [confirming, setConfirming] = useState<ApplicationPreparationSummary | null>(null)
  const items = vm.page?.items ?? []
  return <>
    <WorkspacePageHeader
      title={listTitle}
      tabs={<div className={s.chipRow} role="group" aria-label="작성 상태 필터">
        {listStatusTabs.map((tab) => <button className={vm.status === tab.value ? s.chipActive : s.chip} key={tab.label} type="button"
          aria-pressed={vm.status === tab.value} onClick={() => vm.setStatus(tab.value)}>{tab.label}</button>)}
      </div>}
      actions={<Link className={workspacePageStyles.primaryButton} to={appPaths.applicationPreparationNew}>새 문서</Link>}
    />
    <main className={workspacePageStyles.content}>
      <p className={s.muted}>검수된 공식 양식과 지원 분야를 선택해 신청 준비를 시작하고, 저장한 작업을 다시 열 수 있습니다.</p>
      {vm.error && <ErrorNotice message={vm.error.message} retryLabel="목록 다시 불러오기" onRetry={vm.retry} />}
      {vm.isInitialLoading && <>
        <p className={s.status} role="status" aria-live="polite">신청 준비 목록을 불러오는 중입니다.</p>
        <div className={s.cardGrid} aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((index) => <div className={s.skeleton} key={index} />)}</div>
      </>}
      {vm.page && items.length === 0 && !vm.isInitialLoading && <section className={s.card} aria-labelledby="empty-preparations-title">
        <h2 className={s.cardTitle} id="empty-preparations-title">{vm.status === undefined ? '아직 시작한 신청 문서가 없습니다.' : vm.status === 'done' ? '완료한 신청 문서가 없습니다.' : '진행 중인 신청 문서가 없습니다.'}</h2>
        <p className={s.muted}>새 문서에서 공식 양식과 지원 분야를 확인한 뒤 시작해 주세요.</p>
      </section>}
      {items.length > 0 && <ul className={s.cardGrid} aria-label="신청 준비 목록">
        {items.map((item) => {
          const deadline = deadlineBadge(item)
          const done = item.hasCurrentDocument === true
          const progress = item.requiredTotal !== undefined && item.answeredRequired !== undefined ? { answered: item.answeredRequired, total: item.requiredTotal } : null
          return <li className={s.listCard} key={item.id}>
            <div className={s.badgeRow}>
              {done && <span className={s.badgeDone}>완료</span>}
              {deadline && <span className={deadline.className}>{deadline.label}</span>}
              <span className={s.muted}>{sourceLabel(item.sourceCode)}</span>
            </div>
            <Link className={`${s.listLink} min-w-0`} to={`${appPaths.applicationPreparations}/${item.id}`}>
              <strong>{item.programTitle}</strong>
              <span className={s.muted}>{item.formTitle} · {applicationServiceFieldLabels[item.serviceField]}</span>
            </Link>
            {progress && <div className="flex flex-col gap-1" aria-label={`필수 답변 ${progress.answered} / ${progress.total}`}>
              <span className={s.muted}>필수 답변 {progress.answered} / {progress.total}</span>
              <div className={s.progressTrack}><div className={s.progressFill} style={{ width: `${progress.total === 0 ? 0 : Math.min(100, Math.round(progress.answered / progress.total * 100))}%` }} /></div>
            </div>}
            <span className={s.muted}>입력 버전 {item.inputRevision} · {readableTime(item.updatedAt)} 수정</span>
            <div className={s.cardActions}>
              {done
                ? <Link className={s.primary} to={`${appPaths.applicationPreparations}/${item.id}/documents`}>문서 보기</Link>
                : <Link className={s.primary} to={`${appPaths.applicationPreparations}/${item.id}`}>이어서 작성</Link>}
              <button className={s.danger} disabled={vm.deletingId !== null} type="button" onClick={() => setConfirming(item)}>삭제</button>
            </div>
          </li>
        })}
      </ul>}
      {vm.page && vm.page.nextBeforeId !== null && !vm.error && <div className={s.moreActions}>
        <button className={s.button} disabled={vm.isLoadingMore} type="button" onClick={() => { vm.loadMore() }}>
          {vm.isLoadingMore ? '이전 작업 불러오는 중…' : '이전 작업 더 보기'}
        </button>
        <span className={s.muted}>{items.length}건 표시</span>
        {vm.isLoadingMore && <p className={s.status} role="status" aria-live="polite">이전 신청 준비를 불러오는 중입니다.</p>}
      </div>}
    </main>
    <WorkspaceModal isOpen={confirming !== null} title="작성 중인 문서를 삭제할까요?" tone="danger" onClose={() => setConfirming(null)}
      description={confirming ? `${confirming.programTitle}의 답변${confirming.answeredRequired !== undefined ? ` ${confirming.answeredRequired}개` : ''}와 AI 실행 기록이 함께 삭제되며 되돌릴 수 없습니다.` : undefined}>
      <div className="flex flex-wrap justify-end gap-2">
        <button className={s.button} disabled={vm.deletingId !== null} type="button" onClick={() => setConfirming(null)}>취소</button>
        <button className={s.danger} disabled={vm.deletingId !== null} type="button" onClick={() => {
          if (confirming === null) return
          void vm.deletePreparation(confirming.id).then((deleted) => { if (deleted) setConfirming(null) })
        }}>{vm.deletingId !== null ? '삭제 중…' : '정말 삭제'}</button>
      </div>
    </WorkspaceModal>
    <WorkspaceToast notice={vm.toast} onClose={vm.dismissToast} />
  </>
}

export function ApplicationPreparationEditorPage({ create = false }: { create?: boolean }) {
  const account = useAppSelector(selectCurrentAccount)
  const { preparationId } = useParams()
  const [searchParams] = useSearchParams()
  const id = create ? null : Number(preparationId)
  if (!account) return null
  if (!create && (id === null || !Number.isSafeInteger(id) || id <= 0)) {
    return <>
      <WorkspacePageHeader parent={{ to: appPaths.applicationPreparations, label: featureTitle }} title="답변 입력" />
      <main className={workspacePageStyles.content}><ErrorNotice message="올바른 신청 준비 주소가 아닙니다." /></main>
    </>
  }
  const requestedSourceCode = create ? searchParams.get('sourceCode') ?? '' : ''
  const initialSourceCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(requestedSourceCode) ? requestedSourceCode : ''
  const initialSourceProgramId = initialSourceCode ? searchParams.get('sourceProgramId') ?? '' : ''
  return <ApplicationPreparationEditor
    key={`${account.email}:${id ?? `new:${initialSourceCode}:${initialSourceProgramId}`}`}
    id={id}
    initialSourceCode={initialSourceCode}
    initialSourceProgramId={initialSourceProgramId}
  />
}

function ApplicationPreparationEditor({ id, initialSourceCode, initialSourceProgramId }: {
  id: number | null
  initialSourceCode: string
  initialSourceProgramId: string
}) {
  const [savedProgramsOpen, setSavedProgramsOpen] = useState(false)
  const savedProgramsButtonRef = useRef<HTMLButtonElement>(null)
  const vm = useApplicationPreparationEditorViewModel(id, initialSourceCode, initialSourceProgramId, savedProgramsOpen)
  const detail = id === null ? null : vm.preparation
  const resultHeading = useRef<HTMLHeadingElement>(null)
  const closeSavedPrograms = () => { setSavedProgramsOpen(false); savedProgramsButtonRef.current?.focus() }
  useLayoutEffect(() => {
    if (vm.creationStep === 'FORM') { setSavedProgramsOpen(false); resultHeading.current?.focus() }
  }, [vm.creationStep])
  const noDiscoveredForm = vm.error instanceof ApplicationPreparationError && vm.error.code === 'APPLICATION_FORM_NO_FORM'
  const canOpenOfficialSource = vm.error instanceof ApplicationPreparationError
    && ['APPLICATION_FORM_NO_FORM', 'APPLICATION_FORM_SOURCE_UNSUPPORTED'].includes(vm.error.code)
  const officialSource = vm.selectedProgram
    ? { title: vm.selectedProgram.title, url: vm.selectedProgram.sourceUrl }
      : undefined
  // 답변 입력은 머리글부터 화면 전체를 자기 배치로 그립니다. 불러오는 중·실패는 아래 공용 틀로 보여 줍니다.
  if (detail) return <AnswerEditor key={detail.id} vm={vm} />
  return <>
    <WorkspacePageHeader
      parent={{ to: appPaths.applicationPreparations, label: id === null ? listTitle : featureTitle }}
      title={id === null ? '새 신청 문서' : '답변 입력'}
    />
    <main className={workspacePageStyles.content}>
      {vm.loading && <p className={s.status} role="status" aria-live="polite">
        {id === null ? '지원 가능한 공식 양식을 불러오는 중입니다.' : '신청 문서 정보를 불러오는 중입니다.'}
      </p>}

      {vm.error && <ErrorNotice
        message={vm.error.message}
        onRetry={noDiscoveredForm || vm.submitting || vm.discovering ? undefined : id === null ? (vm.selectedProgram ? vm.retryAvailability : undefined) : vm.load}
        officialSource={canOpenOfficialSource ? officialSource : undefined}
      />}

      {id === null && <form className={s.form} aria-labelledby="create-preparation-title" onSubmit={(event) => {
        event.preventDefault()
        if (vm.selectedForm) void vm.create()
      }}>
        {vm.discoveryWarnings.length > 0 && <section className={s.notice} aria-label="신청 양식 확인 결과" role="status" aria-live="polite">
          <ul className="list-disc space-y-1 pl-5">{vm.discoveryWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </section>}

        <ol className={s.steps} aria-label="신청 문서 작성 준비 단계">
          <li className={vm.creationStep === 'PROGRAM' ? s.activeStep : s.inactiveStep} aria-current={vm.creationStep === 'PROGRAM' ? 'step' : undefined}>1. 지원 공고 선택</li>
          <li className={vm.creationStep === 'FORM' ? s.activeStep : s.inactiveStep} aria-current={vm.creationStep === 'FORM' ? 'step' : undefined}>2. 신청 문서 확인</li>
        </ol>

        {vm.creationStep === 'PROGRAM' && <>
        {vm.selectedProgram && <section className={s.card} aria-labelledby="selected-application-program-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className={s.cardTitle} id="selected-application-program-title">선택한 공고</h2>
              <strong>{vm.selectedProgram.title}</strong>
              <p className={s.muted}>{catalogSourceLabels[vm.selectedProgram.sourceCode as keyof typeof catalogSourceLabels] ?? vm.selectedProgram.sourceName} · {vm.selectedProgram.organization} · {programStatusLabels[vm.selectedProgram.status]}</p>
              <p className={s.muted}>{vm.selectedProgram.applicationPeriod}</p>
            </div>
            <button className={`${s.button} shrink-0`} disabled={vm.discovering || vm.submitting} type="button" onClick={vm.clearProgramSelection}>선택 취소</button>
          </div>
          {vm.checkingAvailability && <p className={s.status} role="status" aria-live="polite">저장된 신청 양식을 확인하는 중입니다.</p>}
          {!vm.checkingAvailability && !vm.discovering && vm.availabilityStatus && <p className={s.label} data-testid="availability-summary">
            {vm.availabilityStatus === 'AVAILABLE'
              ? `양식 ${vm.forms.length}개 · 바로 작성할 수 있어요`
              : ['PENDING', 'STALE', 'RETRY_WAITING'].includes(vm.availabilityStatus)
                ? '분석이 필요해요'
                : '이 공고에서는 작성할 양식을 찾지 못했어요'}
          </p>}
          {vm.discovering && <section className={s.notice} role="status" aria-live="polite" aria-label="양식 분석 진행">
            <p><strong>양식을 분석하고 있어요</strong> · 경과 {Math.floor(vm.discoveryElapsedSeconds / 60)}:{String(vm.discoveryElapsedSeconds % 60).padStart(2, '0')}</p>
            <p className={s.muted}>화면을 나가도 계속돼요. 돌아오면 이 공고를 다시 선택해 진행 상태를 이어서 볼 수 있어요.</p>
          </section>}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <p className={`${s.muted} min-w-0 flex-1`}>{vm.availabilityStatus === 'AVAILABLE'
              ? '표의 여러 칸이 한 질문으로 묶여 있다면 입력칸별로 다시 분석할 수 있어요. 기존 작성본과 답변은 유지됩니다.'
              : '저장된 양식이 없으면 공식 첨부를 분석해요. 처음에는 시간이 걸릴 수 있어요.'}</p>
            <button className={`${s.button} ml-auto shrink-0`} disabled={vm.discovering || vm.submitting || vm.checkingAvailability} type="button" onClick={() => { void vm.discoverForms() }}>
              {vm.discovering ? '분석 중…' : vm.availabilityStatus === 'AVAILABLE' ? '입력칸별로 다시 분석' : '입력칸별로 분석'}
            </button>
          </div>
        </section>}

        <section className={s.card}>
          <h2 className={s.cardTitle} id="create-preparation-title">전체 공고 검색</h2>
          <button ref={savedProgramsButtonRef} type="button" className="flex w-full cursor-pointer items-center justify-between rounded-xl border border-slate-300 bg-white px-4 py-3 text-left text-sm font-semibold hover:border-emerald-400 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-emerald-700" aria-label="관심 공고함에서 선택" aria-haspopup="dialog" aria-expanded={savedProgramsOpen} onClick={() => setSavedProgramsOpen(true)}><span>관심 공고함에서 선택</span><span className="text-emerald-800">열기 ›</span></button>
          <SavedSupportProgramPickerDialog
            open={savedProgramsOpen}
            phase={vm.savedProgramChoices.phase}
            programs={vm.savedProgramChoices.programs}
            selectedProgramKeys={vm.selectedProgram ? [`${vm.selectedProgram.sourceCode}:${vm.selectedProgram.id}`] : []}
            selectionLimit={1}
            description="신청 문서를 작성할 공고를 1개 선택하세요."
            listLabel="신청 문서 관심 공고 목록"
            isSupported={() => true}
            unsupportedLabel="문서 지원 준비 중"
            onToggle={(program) => {
              const selected = vm.selectedProgram?.sourceCode === program.sourceCode && vm.selectedProgram.id === program.id
              if (selected) vm.clearProgramSelection()
              else vm.selectProgram(program)
            }}
            onRetry={vm.savedProgramChoices.retry}
            onClose={closeSavedPrograms}
          />
          <SupportProgramSearchFilters filters={vm.catalogFilters} appliedFilters={vm.appliedCatalogFilters} catalog={vm.catalog}
            disabled={vm.discovering || vm.submitting} loading={vm.catalogLoading} onChange={vm.setCatalogFilters}
            onSearch={(filters) => { void vm.searchPrograms(1, filters) }} />
          <p className={s.muted}>공고명·기관명과 필터로 공고를 검색하고 공고별 양식 준비 상태를 확인할 수 있습니다.</p>
          {vm.catalogLoading && <p className={s.status} role="status" aria-live="polite">전체 제공처의 공고를 검색하고 있습니다.</p>}
          {vm.catalogError && <ErrorNotice message={vm.catalogError.message} retryLabel="공고 다시 검색" onRetry={() => { void vm.searchPrograms(vm.appliedCatalogFilters.page, vm.appliedCatalogFilters) }} />}
          {vm.catalog?.programs.length === 0 && <p className={s.notice}>검색 결과가 없습니다. 검색어나 필터를 바꿔 다시 검색해 주세요.</p>}
          {vm.catalog && vm.catalog.programs.length > 0 && <>
            <p className={s.muted}>검색 결과 {vm.catalog.total}건 · {vm.catalog.page}/{vm.catalog.totalPages}페이지</p>
            {/* 8건(한 건 약 7rem)까지 보이고 그 이상은 목록 안에서 스크롤합니다. */}
            <ul className="max-h-[56rem] divide-y divide-slate-200 overflow-y-auto" aria-label="신청 문서 공고 검색 결과">
              {vm.catalog.programs.map((program) => {
                const selected = vm.selectedProgram?.sourceCode === program.sourceCode && vm.selectedProgram.id === program.id
                return <li className="py-3" key={`${program.sourceCode}:${program.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <strong>{program.title}</strong>
                      <p className={s.muted}>{catalogSourceLabels[program.sourceCode as keyof typeof catalogSourceLabels] ?? program.sourceName} · {program.organization} · {programStatusLabels[program.status]}</p>
                      <p className={s.muted}>{program.applicationPeriod}</p>
                    </div>
                    <button className={s.button} disabled={selected || vm.discovering || vm.submitting} type="button" onClick={() => vm.selectProgram(program)}>
                      {selected ? '선택됨' : '선택'}
                    </button>
                  </div>
                </li>
              })}
            </ul>
            {vm.catalog.totalPages > 1 && <div className={s.moreActions}>
              <button className={s.button} disabled={vm.catalogLoading || vm.catalog.page <= 1} type="button" onClick={() => { void vm.searchPrograms(vm.catalog!.page - 1, vm.appliedCatalogFilters) }}>이전</button>
              <button className={s.button} disabled={vm.catalogLoading || vm.catalog.page >= vm.catalog.totalPages} type="button" onClick={() => { void vm.searchPrograms(vm.catalog!.page + 1, vm.appliedCatalogFilters) }}>다음</button>
            </div>}
          </>}
        </section>

        </>}

        {vm.creationStep === 'FORM' && <>
        <section className={s.card} aria-labelledby="discovered-application-forms-title">
          <h2 className={s.cardTitle} id="discovered-application-forms-title" ref={resultHeading} tabIndex={-1}>신청 문서를 찾았습니다</h2>
          <p className={s.muted}>발견한 공식 첨부와 작성 문항을 확인한 뒤 작성을 시작하세요.</p>
        </section>


        {vm.selectedForm && <>
        <section className={s.card}>
          <h2 className={s.cardTitle}>작성 문서 선택</h2>
          <label className={s.label} htmlFor="application-form">작성할 공식 첨부</label>
          <SelectField
            id="application-form"
            describedBy="application-form-hint"
            className={s.input}
            disabled={vm.submitting}
            value={vm.selectedFormVersionId}
            options={vm.forms.map((form) => ({ value: form.formVersionId, label: `${form.programTitle} — ${form.formTitle}` }))}
            onChange={vm.selectForm}
          />
          <p className={s.muted} id="application-form-hint">발견한 문서와 문항 위치를 원문에서 확인한 뒤 시작해 주세요.</p>
        </section>

        <OfficialFormSummary form={vm.selectedForm} />

        <section className={s.card} aria-labelledby="service-field-title">
          <h2 className={s.cardTitle} id="service-field-title">작성 시작</h2>
          {!(vm.selectedForm.supportedServiceFields.length === 1 && vm.selectedForm.supportedServiceFields[0] === 'GENERAL') && <>
          <label className={s.label} htmlFor="application-service-field">작성할 지원 분야</label>
          <SelectField
            id="application-service-field"
            className={s.input}
            disabled={vm.submitting}
            value={vm.serviceField}
            options={vm.selectedForm.supportedServiceFields.map((field) => ({ value: field, label: applicationServiceFieldLabels[field] }))}
            onChange={(value) => vm.setServiceField(value as typeof vm.serviceField)}
          />
          </>}
          <p className={s.muted}>추출된 문항을 확인했습니다. 작성 시작은 신청 준비 건만 만들며 추가 AI 호출은 하지 않습니다.</p>
          {vm.submitting && <p className={s.status} role="status" aria-live="polite">신청 준비를 생성하고 있습니다. 잠시만 기다려 주세요.</p>}
        </section>
        </>}
        </>}

        <div className={s.stepBar} role="group" aria-label="단계 이동">
          {vm.creationStep === 'PROGRAM'
            ? <>
              <Link className={s.button} to={appPaths.applicationPreparations}>취소</Link>
              <button className={s.primary} disabled={!vm.canProceedToForm || vm.submitting} type="button" onClick={vm.goToFormStep}>다음 단계</button>
            </>
            : <>
              <button className={s.button} disabled={vm.submitting} type="button" onClick={vm.backToProgramSelection}>이전 단계</button>
              <button className={s.primary} disabled={vm.submitting || !vm.selectedForm} type="submit">
                {vm.submitting ? '신청 준비 생성 중…' : '작성 시작'}
              </button>
            </>}
        </div>
      </form>}
    </main>
  </>
}
