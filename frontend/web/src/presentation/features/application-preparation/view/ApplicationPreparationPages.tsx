import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useAppSelector } from '../../../../app/hooks'
import {
  applicationDeadlineDays,
  applicationServiceFieldLabels,
  type ApplicationFormField,
  type ApplicationFormSection,
  type ApplicationPreparationListStatus,
  type ApplicationPreparationSummary,
} from '../../../../domain/entities/ApplicationPreparation'
import { selectCurrentAccount } from '../../../shared/auth/state/authSlice'
import { appPaths, supportProgramDetailPath } from '../../../shared/routes/appPaths'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { WorkspaceModal } from '../../../shared/workspace/WorkspaceModal'
import { WorkspaceToast } from '../../../shared/workspace/WorkspaceToast'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'
import { workspaceToastActionClassName } from '../../../shared/workspace/WorkspaceToast.styles'
import { useFloatingPopover } from '../../../shared/workspace/useFloatingPopover'
import { answerMaxLength, undecidedAnswer, useApplicationPreparationEditorViewModel } from '../viewmodel/useApplicationPreparationEditorViewModel'
import { useApplicationPreparationListViewModel } from '../viewmodel/useApplicationPreparationListViewModel'
import { answerEditorStyles as e, applicationPreparationStyles as s } from './ApplicationPreparation.styles'
import { ApplicationOnlineInputGuide } from './ApplicationOnlineInputGuide'

const listTitle = '신청 문서 작성'
/** 사이드바 항목과 같은 이름입니다. 답변 입력 화면의 상위 경로에 씁니다. */
const featureTitle = '신청 문서 작성'
/** 목록 카드의 날짜. "09.24"처럼 월·일만 보여 준다. */
function shortDate(value: string) {
  const date = new Date(value)
  return `${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`
}

function ErrorNotice({ message, retryLabel, onRetry }: {
  message: string
  retryLabel?: string
  onRetry?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { ref.current?.focus() }, [message])
  return <div className={s.warning} ref={ref} role="alert" tabIndex={-1}>
    <p>{message}</p>
    {onRetry && <div className="mt-3 flex flex-wrap gap-3">
      <button className={s.button} type="button" onClick={onRetry}>{retryLabel ?? '다시 시도'}</button>
    </div>}
  </div>
}

// ── 답변 입력(25) ──

type EditorViewModel = ReturnType<typeof useApplicationPreparationEditorViewModel>
/** 질문 하나입니다. `order`·`sectionSize`는 항목 안에서의 순번과 질문 수입니다("질문 2 / 5"). */
type Question = { section: ApplicationFormSection; field: ApplicationFormField; sectionIndex: number; key: string; order: number; sectionSize: number }

/** 자동 기입할 수 있는 문항만 답변 대상으로 셉니다. 나머지는 원문에서 직접 작성합니다. */
function writable(field: ApplicationFormField) { return field.documentWritable !== false }

/** 시트 안에서 Tab이 오갈 수 있는 요소입니다. WorkspaceModal과 같은 기준입니다. */
const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** "방금 09:41"처럼 지난 시간과 저장 시각을 함께 보여 줍니다. 한 시간이 넘으면 시각만 둡니다. */
function savedTimeLabel(savedAt: number, now: number) {
  const saved = new Date(savedAt)
  const clock = `${String(saved.getHours()).padStart(2, '0')}:${String(saved.getMinutes()).padStart(2, '0')}`
  const elapsed = now - savedAt
  if (elapsed < 60_000) return `방금 ${clock}`
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}분 전 ${clock}`
  return clock
}

/** 머리글·시트·[초안 만들기]에 쓰는 선 아이콘입니다. 이름은 버튼의 aria-label이 맡습니다. */
function EditorIcon({ name, size = 20 }: { name: 'list' | 'more' | 'close' | 'doc'; size?: number }) {
  return <svg className="shrink-0" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'list' && <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <g fill="currentColor" stroke="none"><circle cx="4.5" cy="6" r="1.25" /><circle cx="4.5" cy="12" r="1.25" /><circle cx="4.5" cy="18" r="1.25" /></g>
    </>}
    {name === 'more' && <g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.75" /><circle cx="12" cy="12" r="1.75" /><circle cx="19" cy="12" r="1.75" /></g>}
    {name === 'close' && <path d="M18 6 6 18M6 6l12 12" />}
    {name === 'doc' && <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" />}
  </svg>
}

/** 항목 목록(PC 왼쪽 · 모바일 시트)입니다. 전체 진행, 항목별 상태, [초안 만들기]를 한 벌로 그립니다. */
function SectionNav({ sections, valueOf, activeSectionIndex, onSelect, requiredMissing, generate }: {
  sections: ApplicationFormSection[]
  valueOf: (section: ApplicationFormSection, field: ApplicationFormField) => string
  activeSectionIndex: number
  onSelect: (sectionIndex: number) => void
  requiredMissing: number
  generate: { disabled: boolean; onClick: () => void }
}) {
  const totals = sections.reduce((sum, section) => {
    const fields = section.fields.filter(writable)
    return { answered: sum.answered + fields.filter((field) => valueOf(section, field).trim()).length, total: sum.total + fields.length }
  }, { answered: 0, total: 0 })
  const percent = totals.total === 0 ? 0 : Math.round((totals.answered / totals.total) * 100)
  return <>
    <div className={e.meterCard}>
      <div className={e.progress}>
        <p className={e.progressLabel}><span>전체 답변 {totals.answered} / {totals.total}</span><span className={e.progressPercent}>{percent}%</span></p>
        <div className={e.progressBar} role="progressbar" aria-label="전체 답변 진행" aria-valuemin={0} aria-valuemax={totals.total} aria-valuenow={totals.answered}>
          <span className={e.progressFill} style={{ width: `${percent}%` }} />
        </div>
      </div>
      {requiredMissing > 0 && <p className={e.remaining}>필수 답변 {requiredMissing}개가 남았어요</p>}
    </div>
    <ol className={e.sectionList}>
      {sections.map((section, index) => {
        const fields = section.fields.filter(writable)
        const answered = fields.filter((field) => valueOf(section, field).trim()).length
        const done = fields.length > 0 && answered === fields.length
        const active = index === activeSectionIndex
        // 지금 보고 있는 항목은 답이 없어도 "진행 중"입니다.
        const status = done ? '완료' : answered > 0 || active ? '진행 중' : '시작 전'
        return <li key={section.key}>
          <button type="button" className={e.sectionButton} aria-current={active ? 'step' : undefined} onClick={() => onSelect(index)}>
            <span className={`${e.sectionNumber} ${done ? e.sectionNumberDone : active ? e.sectionNumberActive : ''}`} aria-hidden="true">{done ? '✓' : index + 1}</span>
            <span className={e.sectionText}>
              <span className={e.sectionTitle}>{section.title}</span>
              <span className={e.sectionMeta}>{fields.length === 0 ? '원문에서 직접 작성' : `답변 ${answered} / ${fields.length}`}</span>
            </span>
            {fields.length > 0 && <span className={done ? e.badgeDone : status === '진행 중' ? e.badgeActive : e.badgeIdle}>{status}</span>}
          </button>
        </li>
      })}
    </ol>
    <button type="button" className={e.generateButton} disabled={generate.disabled} onClick={generate.onClick}><EditorIcon name="doc" size={16} />초안 만들기</button>
    {generate.disabled && requiredMissing > 0 && <p className={e.generateHint}>필수 답변을 모두 채우면 만들 수 있어요</p>}
  </>
}

function AnswerEditor({ vm }: { vm: EditorViewModel }) {
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const preparation = vm.preparation!
  const form = preparation.form
  const sections = form.sections
  const questions = useMemo<Question[]>(() => sections.flatMap((section, sectionIndex) =>
    section.fields.map((field, order) => ({ section, field, sectionIndex, key: `${section.key}:${field.key}`, order, sectionSize: section.fields.length }))), [sections])
  const valueOf = (section: ApplicationFormSection, field: ApplicationFormField) => {
    const key = `${section.key}:${field.key}`
    if (vm.deletedAnswerKeys.has(key)) return ''
    if (Object.hasOwn(vm.sectionMessages, key)) return vm.sectionMessages[key]
    const fact = section.facts.find((saved) => saved.fieldKey === field.key)
    return fact?.status === 'UNKNOWN' ? undecidedAnswer : fact?.value ?? ''
  }
  // 들어오면 아직 답하지 않은 첫 필수 질문부터 엽니다(마지막으로 본 질문은 저장하지 않음). 모두 답했으면 첫 질문.
  // 문서 화면의 [답변 입력으로]처럼 주소에 `?question=<항목 키>`가 있으면 그 질문을 엽니다. 모르는 키는 무시합니다.
  const [index, setIndex] = useState(() => {
    const requested = search.get('question')
    const asked = requested ? questions.findIndex(({ field }) => field.key === requested) : -1
    if (asked !== -1) return asked
    const open = questions.findIndex(({ section, field }) => field.required && writable(field) && !valueOf(section, field).trim())
    return open === -1 ? 0 : open
  })
  const [sheetOpen, setSheetOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  /** "아직 정해지지 않았어요"를 고르기 직전에 적어 둔 값입니다. 체크를 풀면 이 값으로 돌려놓습니다. */
  const [typedBeforeUndecided, setTypedBeforeUndecided] = useState<Record<string, string>>({})
  /** 붙여 넣은 글이 2,000자에서 잘린 질문입니다. 칸 아래에 한 줄로 알립니다. */
  const [truncatedKey, setTruncatedKey] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const listButtonRef = useRef<HTMLButtonElement>(null)
  const menu = useFloatingPopover({ open: menuOpen, placement: 'bottom-end' })
  const current = questions[Math.min(index, Math.max(0, questions.length - 1))]
  const currentValue = current ? valueOf(current.section, current.field) : ''
  const undecided = currentValue === undecidedAnswer
  const options = current?.field.options ?? []
  const missingOptions = current ? options.length === 0 && /택\s*1|하나.{0,10}선택|중.{0,10}선택/.test(`${current.field.label} ${current.field.guidance}`) : false
  const requiredMissing = questions.filter(({ section, field }) => field.required && writable(field) && !valueOf(section, field).trim()).length
  const fieldError = current && vm.fieldError?.key === current.key ? vm.fieldError.message : null
  // 지금 질문의 칸 오류는 칸 아래에만 보여 줍니다. 같은 문구를 위쪽 실패 알림으로 겹쳐 띄우지 않습니다.
  const failed = vm.autosave.status === 'failed' && !fieldError ? vm.autosave : null

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

  // 항목 목록 시트: 열리면 시트 안 첫 요소로 포커스를 옮기고, 닫히면 [항목 목록] 버튼으로 돌려줍니다.
  // 항목을 골라 닫을 때는 go()가 이미 질문 제목으로 포커스를 옮겼으므로 그대로 둡니다.
  useEffect(() => {
    if (!sheetOpen) return
    const sheet = sheetRef.current
    const opener = listButtonRef.current
    ;(sheet?.querySelector<HTMLElement>(focusableSelector) ?? sheet)?.focus()
    return () => {
      const active = document.activeElement
      if (!active || active === document.body || sheet?.contains(active)) opener?.focus()
    }
  }, [sheetOpen])

  function onSheetKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      setSheetOpen(false)
      return
    }
    if (event.key !== 'Tab' || sheetRef.current === null) return
    const focusable = Array.from(sheetRef.current.querySelectorAll<HTMLElement>(focusableSelector))
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

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
  function setUndecided(checked: boolean) {
    if (!current) return
    if (checked) {
      setTypedBeforeUndecided((typed) => ({ ...typed, [current.key]: currentValue }))
      vm.setSectionMessage(current.key, undecidedAnswer)
    } else {
      vm.setSectionMessage(current.key, typedBeforeUndecided[current.key] ?? '')
    }
  }
  const generateDisabled = requiredMissing > 0 || questions.length === 0
  const saveStatus = vm.autosave.status === 'saving' ? '저장 중…'
    : vm.autosave.status === 'saved' ? `자동 저장됨 · ${savedTimeLabel(vm.autosave.savedAt, now)}`
      : vm.autosave.status === 'failed' ? '저장 실패' : vm.hasPendingAnswers ? '입력을 멈추면 저장돼요' : '입력하면 자동으로 저장돼요'
  const reanalyzeTo = `${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: form.sourceCode, sourceProgramId: form.sourceProgramId })}`
  const documentsTo = `${appPaths.applicationPreparations}/${preparation.id}/documents`
  const nav = <SectionNav sections={sections} valueOf={valueOf} activeSectionIndex={current?.sectionIndex ?? 0} onSelect={goSection}
    requiredMissing={requiredMissing} generate={{ disabled: generateDisabled, onClick: () => { void generate() } }} />
  const isLast = current ? index >= questions.length - 1 : true
  // 마지막 질문에서 [초안 만들기]가 비활성이면 바의 상태 자리에 남은 필수 답변 수를 둡니다.
  const barStatus = isLast && requiredMissing > 0 ? `필수 답변 ${requiredMissing}개가 남았어요` : saveStatus

  return <>
    <WorkspacePageHeader
      parent={{ to: appPaths.applicationPreparations, label: featureTitle }}
      current={form.programTitle}
      title="답변 입력"
      subtitle={`${form.formTitle} · ${applicationServiceFieldLabels[preparation.serviceField]}`}
      actions={<>
        <button ref={listButtonRef} type="button" className={`${e.iconButton} ${e.iconButtonM}`} aria-label="항목 목록" aria-haspopup="dialog" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)}><EditorIcon name="list" /></button>
        {vm.documentCount > 0 && <Link className={e.headerButton} to={documentsTo}><EditorIcon name="doc" size={16} />문서 보기</Link>}
        <div ref={menuRef} className="relative">
          <button ref={menu.reference} type="button" className={e.iconButton} aria-label="문서 메뉴" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><EditorIcon name="more" /></button>
          {menuOpen && <div ref={menu.floating} style={menu.floatingStyles} className={e.menu} role="menu" aria-label="문서 메뉴">
            {vm.documentCount > 0 && <Link className={`${e.menuItem} min-[600px]:hidden`} role="menuitem" to={documentsTo} onClick={() => setMenuOpen(false)}>문서 보기</Link>}
            <a className={e.menuItem} role="menuitem" href={form.sourceUrl} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}>원문 보기 ↗</a>
            <Link className={e.menuItem} role="menuitem" to={reanalyzeTo} onClick={() => setMenuOpen(false)}>양식 다시 분석해 새로 시작</Link>
          </div>}
        </div>
      </>}
    />
    <main className={workspacePageStyles.content}>
      {form.verificationStatus === 'SOURCE_DOCUMENT_EXTRACTED' && <div className={e.infoAlert} role="note">
        <div className={e.infoText}>
          <strong className={e.infoTitle}>AI가 공식 첨부에서 뽑은 문항이에요</strong>
          원문과 대조해 주세요. 기관 검수 · 선정과 무관하며 자동 제출되지 않아요.
        </div>
        <a className={e.infoLink} href={form.sourceUrl} target="_blank" rel="noreferrer">원문 보기 ↗<span className="sr-only">: {form.programTitle} (새 창)</span></a>
      </div>}

      <div className={e.layout}>
        <aside className={e.aside} aria-label="작성 항목">{nav}</aside>
        <div className="flex min-w-0 flex-col gap-3">
          {current && <div className={e.stepperM}>
            <p className={e.stepperMLabel}><span>{current.section.title}</span><span className="tabular-nums">{current.sectionIndex + 1} / {sections.length}</span></p>
            <div className={e.progressBar} aria-hidden="true"><span className={e.progressFill} style={{ width: `${Math.round(((current.sectionIndex + 1) / sections.length) * 100)}%` }} /></div>
            <p className={e.barStatusM} role="status" aria-live="polite">{saveStatus}</p>
          </div>}
          {failed && <div className={e.dangerAlert} role="alert">
            <p className={e.dangerText}>{failed.conflict
              ? '다른 곳에서 답변이 먼저 바뀌어 최신 답변을 다시 불러왔어요. 입력 중이던 값을 확인한 뒤 다시 저장해 주세요.'
              : `답변을 저장하지 못했어요. ${failed.error.message}`}</p>
            <button type="button" className={e.retryButton} onClick={vm.retryAutosave}>{failed.conflict ? '내 답변으로 다시 저장' : '다시 시도'}</button>
          </div>}
          {current ? <section className={e.question} aria-label={`${current.section.title} 작성`}>
            <div className={e.questionHead}>
              <p className={e.questionEyebrow}>{current.sectionIndex + 1}. {current.section.title} · 질문 {current.order + 1} / {current.sectionSize}</p>
              <span className={current.field.required ? e.requiredTag : e.optionalTag}>{current.field.required ? '필수' : '선택'}</span>
            </div>
            <h3 className={e.questionTitle} ref={headingRef} tabIndex={-1}>{current.field.label}</h3>
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
                  onPaste={(event) => {
                    // maxLength가 붙여 넣은 글을 조용히 자르므로, 잘릴 길이인지 미리 계산해 칸 아래에 알립니다.
                    const target = event.currentTarget
                    const selected = target.selectionEnd - target.selectionStart
                    const next = target.value.length - selected + event.clipboardData.getData('text').length
                    setTruncatedKey(next > answerMaxLength ? current.key : null)
                  }}
                  onChange={(event) => {
                    if (truncatedKey !== null && event.target.value.length < answerMaxLength) setTruncatedKey(null)
                    vm.setSectionMessage(current.key, event.target.value)
                  }}
                  placeholder="확인된 사실만 적어 주세요."
                />
                <p className={`${e.counter} ${[...currentValue].length > answerMaxLength ? e.counterOver : ''}`} aria-hidden="true">
                  {undecided ? 0 : [...currentValue].length} / {answerMaxLength.toLocaleString('ko-KR')}자
                </p>
                {truncatedKey === current.key && <p className={e.fieldNote}>{answerMaxLength.toLocaleString('ko-KR')}자까지만 저장돼요</p>}
              </>}
            {fieldError && <p className={e.fieldError} role="alert">{fieldError}</p>}
            <div className={e.answerActions}>
              <label className={e.undecided}>
                <input type="checkbox" checked={undecided} disabled={!writable(current.field)} onChange={(event) => setUndecided(event.target.checked)} />
                아직 정해지지 않았어요
              </label>
              {writable(current.field) && currentValue && <button type="button" className={e.clearButton} onClick={() => vm.deleteSectionAnswer(current.key)}>답변 지우기</button>}
            </div>
            {missingOptions && <p className={s.warning}>공식 선택지를 확인하지 못했습니다. 공식 공고에서 첨부 양식의 선택지를 확인한 뒤 입력해 주세요. <a className="underline" href={form.sourceUrl} target="_blank" rel="noreferrer">공식 공고 열기</a></p>}
          </section> : <p className={s.notice}>이 양식에는 자동 기입할 문항이 없습니다. 원문 양식에서 직접 작성해 주세요.</p>}
          <ApplicationOnlineInputGuide preparationId={preparation.id} inputRevision={preparation.inputRevision} />
        </div>
      </div>
      <div className={e.bar}>
        <button type="button" className={e.prevButton} disabled={index === 0 || !current} onClick={() => go(index - 1)}>← 이전</button>
        <p className={e.barStatus} role="status" aria-live="polite">{barStatus}</p>
        {isLast
          ? <button type="button" className={e.nextButton} disabled={generateDisabled} onClick={() => { void generate() }}>초안 만들기</button>
          : <button type="button" className={e.nextButton} onClick={() => go(index + 1)}>다음 →</button>}
      </div>
    </main>
    {sheetOpen && <>
      <button type="button" className={e.sheetScrim} aria-label="항목 목록 닫기" tabIndex={-1} onClick={() => setSheetOpen(false)} />
      <div ref={sheetRef} className={e.sheet} role="dialog" aria-modal="true" aria-label="항목 목록" tabIndex={-1} onKeyDown={onSheetKeyDown}>
        <span className={e.sheetGrab} aria-hidden="true" />
        <div className={e.sheetHeader}>
          <h2 className={e.sheetTitle}>항목 목록</h2>
          <button type="button" className={e.iconButton} aria-label="닫기" onClick={() => setSheetOpen(false)}><EditorIcon name="close" /></button>
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
/** 카드의 [⋯] 메뉴입니다. 공고 상세로 가거나(돌아오면 이 목록 · 같은 필터) 삭제 확인을 엽니다. 바깥 클릭·Esc로 닫힙니다. */
function PreparationMenu({ item, returnTo, disabled, onDelete }: { item: ApplicationPreparationSummary; returnTo: string; disabled: boolean; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const floating = useFloatingPopover({ open, placement: 'bottom-end' })
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => { if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', onKey) }
  }, [open])
  return <div ref={ref} className="relative">
    <button ref={floating.reference} type="button" className={s.menuButton} aria-label={`문서 메뉴: ${item.programTitle}`} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen((current) => !current)}>⋯</button>
    {open && <div ref={floating.floating} style={floating.floatingStyles} className={e.menu} role="menu" aria-label="문서 메뉴">
      <Link className={e.menuItem} role="menuitem" to={supportProgramDetailPath({ sourceCode: item.sourceCode, sourceProgramId: item.sourceProgramId }, true)}
        state={{ searchReturnTo: returnTo }} onClick={() => setOpen(false)}>공고 보기</Link>
      <button type="button" className={`${e.menuItem} ${s.menuItemDanger}`} role="menuitem" disabled={disabled} onClick={() => { setOpen(false); onDelete() }}>삭제</button>
    </div>}
  </div>
}

function ApplicationPreparationList() {
  const vm = useApplicationPreparationListViewModel()
  const [confirming, setConfirming] = useState<ApplicationPreparationSummary | null>(null)
  const items = vm.page?.items ?? []
  // 공고 상세에서 돌아올 때 보던 필터를 유지합니다.
  const returnTo = vm.status ? `${appPaths.applicationPreparations}?status=${vm.status}` : appPaths.applicationPreparations
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
          const to = done ? `${appPaths.applicationPreparations}/${item.id}/documents` : `${appPaths.applicationPreparations}/${item.id}`
          return <li className={s.listCard} key={item.id}>
            <div className={s.badgeRow}>
              <span className={done ? s.badgeDone : s.badgeProgress}>{done ? '완료' : '진행 중'}</span>
              {deadline && <span className={deadline.className}>{deadline.label}</span>}
            </div>
            <Link className={`${s.listLink} min-w-0`} to={to}>
              <strong className={s.listTitle}>{item.programTitle}</strong>
              <span className={s.listMeta}>{item.formTitle} · {applicationServiceFieldLabels[item.serviceField]}</span>
            </Link>
            {progress && <div className="flex flex-col gap-1" aria-label={`필수 답변 ${progress.answered} / ${progress.total}`}>
              <span className={s.cardStamp}>필수 답변 {progress.answered} / {progress.total}</span>
              <div className={s.progressTrack}><div className={s.progressFill} style={{ width: `${progress.total === 0 ? 0 : Math.min(100, Math.round(progress.answered / progress.total * 100))}%` }} /></div>
            </div>}
            <div className={s.cardFooter}>
              <span className={s.cardStamp}>{done ? `초안 있음 · ${shortDate(item.updatedAt)}` : `${shortDate(item.updatedAt)} 수정`}</span>
              <div className={s.cardActions}>
                <PreparationMenu item={item} returnTo={returnTo} disabled={vm.deletingId !== null} onDelete={() => setConfirming(item)} />
                <Link className={s.secondarySm} to={to}>{done ? '문서 보기' : '이어서 작성'}</Link>
              </div>
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
    <WorkspaceModal isOpen={confirming !== null} title="신청 문서를 삭제할까요?" tone="danger" onClose={() => setConfirming(null)}
      description={confirming ? `${confirming.programTitle}의 답변${confirming.answeredRequired !== undefined ? ` ${confirming.answeredRequired}개` : ''}와 AI 실행 기록이 모두 지워져요. 되돌릴 수 없어요.` : undefined}>
      <div className="flex flex-wrap justify-end gap-2">
        <button className={s.button} disabled={vm.deletingId !== null} type="button" onClick={() => setConfirming(null)}>취소</button>
        <button className={s.dangerSolid} disabled={vm.deletingId !== null} type="button" onClick={() => {
          if (confirming === null) return
          void vm.deletePreparation(confirming.id).then((deleted) => { if (deleted) setConfirming(null) })
        }}>{vm.deletingId !== null ? '삭제 중…' : '삭제'}</button>
      </div>
    </WorkspaceModal>
    <WorkspaceToast notice={vm.toast} onClose={vm.dismissToast} />
  </>
}

export function ApplicationPreparationEditorPage() {
  const account = useAppSelector(selectCurrentAccount)
  const { preparationId } = useParams()
  const id = Number(preparationId)
  if (!account) return null
  if (!Number.isSafeInteger(id) || id <= 0) {
    return <>
      <WorkspacePageHeader parent={{ to: appPaths.applicationPreparations, label: featureTitle }} title="답변 입력" />
      <main className={workspacePageStyles.content}><ErrorNotice message="올바른 신청 준비 주소가 아닙니다." /></main>
    </>
  }
  return <ApplicationPreparationEditor key={`${account.email}:${id}`} id={id} />
}

function ApplicationPreparationEditor({ id }: { id: number }) {
  const vm = useApplicationPreparationEditorViewModel(id)
  // 답변 입력은 머리글부터 화면 전체를 자기 배치로 그립니다. 불러오는 중·실패는 아래 공용 틀로 보여 줍니다.
  if (vm.preparation) return <AnswerEditor key={vm.preparation.id} vm={vm} />
  return <>
    <WorkspacePageHeader parent={{ to: appPaths.applicationPreparations, label: featureTitle }} title="답변 입력" />
    <main className={workspacePageStyles.content}>
      {vm.loading && <p className={s.status} role="status" aria-live="polite">신청 문서 정보를 불러오는 중입니다.</p>}
      {vm.error && <ErrorNotice message={vm.error.message} onRetry={vm.load} />}
    </main>
  </>
}
