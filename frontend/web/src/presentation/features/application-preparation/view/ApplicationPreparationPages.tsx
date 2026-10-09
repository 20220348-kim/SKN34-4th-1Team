import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { applicationDraftMode } from '@govbiz/shared/domain/entities/ApplicationDocumentGeneration'
import { daysUntil, ddayTone, formatDday, programStatusLabels } from '@govbiz/shared/domain/labels'
import { useAppSelector } from '../../../../app/hooks'
import { assistantCover, assistantLift } from '../../../shared/assistant/assistantPlacement'
import {
  applicationServiceFieldLabels,
  type ApplicationFormField,
  type ApplicationFormSection,
  type ApplicationPreparationListStatus,
  type ApplicationPreparationSummary,
} from '../../../../domain/entities/ApplicationPreparation'
import { selectCurrentAccount } from '../../../shared/auth/state/authSlice'
import { appPaths, supportProgramDetailPath } from '../../../shared/routes/appPaths'
import { EmptyState } from '../../../shared/workspace/EmptyState'
import { DocumentIcon } from '../../../shared/workspace/EmptyStateIcons'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { WorkspaceModal } from '../../../shared/workspace/WorkspaceModal'
import { WorkspaceToast } from '../../../shared/workspace/WorkspaceToast'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'
import { workspaceToastActionClassName } from '../../../shared/workspace/WorkspaceToast.styles'
import { useDelayedFlag } from '../../../shared/workspace/useDelayedFlag'
import { ddayToneClassNames } from '../../../shared/workspace/WorkspaceStates.styles'
import { useFloatingPopover } from '../../../shared/workspace/useFloatingPopover'
import { useMediaQuery } from '../../../shared/workspace/useMediaQuery'
import { answerMaxLength, undecidedAnswer, useApplicationPreparationEditorViewModel } from '../viewmodel/useApplicationPreparationEditorViewModel'
import { useApplicationPreparationListViewModel, type DocumentJobState, type FormAnalysisRow } from '../viewmodel/useApplicationPreparationListViewModel'
import { formAnalysisFailureReason } from '../viewmodel/useApplicationPreparationNewViewModel'
import { answerEditorStyles as e, applicationPreparationStyles as s, loadingStyles as k } from './ApplicationPreparation.styles'
import { generationFailureTitle, generationStages } from './documentGeneration'
import { ApplicationOnlineInputGuide } from './ApplicationOnlineInputGuide'
import { ApplicationPreparationLede } from './ApplicationPreparationLede'
import { AnswerEditorSkeleton, ButtonSpinner, ListCardSkeleton } from './ApplicationPreparationSkeletons'

const listTitle = '신청 문서 작성'
/** 사이드바 항목과 같은 이름입니다. 답변 입력 화면의 상위 경로에 씁니다. */
const featureTitle = '신청 문서 작성'
/** 목록 카드의 날짜. "09.24"처럼 월·일만 보여 준다. */
function shortDate(value: string) {
  const date = new Date(value)
  return `${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`
}

/** 작업을 시작한 시각. "14:03"처럼 시·분만 보여 준다. */
function clockTime(value: string) {
  const date = new Date(value)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
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
/** 질문 하나입니다. 진행 표시는 항목 안 순번이 아니라 전체 기준("질문 8 / 34")입니다. */
type Question = { section: ApplicationFormSection; field: ApplicationFormField; sectionIndex: number; key: string }
/** 섹션이 바뀐 첫 질문 위의 띠입니다. `missingIndex`가 있으면 지나온 항목의 빈 필수 질문으로 가는 버튼을 둡니다. */
type SectionNotice = { text: string; missingIndex: number | null }

/** 이 폭보다 좁으면 이동 버튼을 카드 바닥 대신 아래 고정 바로 그립니다. 스타일의 `max-[599px]`과 같은 경계입니다. */
const narrowEditorQuery = '(max-width: 599px)'
/** 같은 자리의 버튼이 [다음 →]에서 [초안 만들기]로 바뀐 뒤 클릭을 받지 않는 시간입니다(두 번 클릭으로 AI 작업이 시작되지 않게). */
const swappedButtonGuardMs = 400

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

/** 머리글·시트·검토의 [초안 만들기]에 쓰는 선 아이콘입니다. 이름은 버튼의 aria-label이 맡습니다. */
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

/** 비어 있는 필수 질문인지입니다. 원문에서 직접 작성하는 문항은 세지 않습니다. */
function requiredEmpty(question: Pick<Question, 'section' | 'field'>, valueOf: (section: ApplicationFormSection, field: ApplicationFormField) => string) {
  return question.field.required && writable(question.field) && !valueOf(question.section, question.field).trim()
}

/**
 * 항목 목록(PC 왼쪽 · 모바일 시트)입니다. 전체 진행, 항목별 상태, "검토하고 초안 만들기" 링크를 한 벌로 그립니다.
 * 지금 항목보다 앞에 있는(지나온) 항목에 빈 필수 질문이 있으면 "필수 비어 있음"으로 남깁니다. 검토 단계에서는 모든 항목이 지나온 항목입니다.
 */
function SectionNav({ sections, valueOf, activeSectionIndex, onSelect, requiredMissing, reviewing, onReview }: {
  sections: ApplicationFormSection[]
  valueOf: (section: ApplicationFormSection, field: ApplicationFormField) => string
  activeSectionIndex: number
  onSelect: (sectionIndex: number) => void
  requiredMissing: number
  reviewing: boolean
  onReview: () => void
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
        const passedWithGap = index < activeSectionIndex && fields.some((field) => requiredEmpty({ section, field }, valueOf))
        // 지금 보고 있는 항목은 답이 없어도 "진행 중"입니다.
        const status = done ? '완료' : passedWithGap ? '필수 비어 있음' : answered > 0 || active ? '진행 중' : '시작 전'
        const badge = done ? e.badgeDone : passedWithGap ? e.badgeWarning : status === '진행 중' ? e.badgeActive : e.badgeIdle
        return <li key={section.key}>
          <button type="button" className={e.sectionButton} aria-current={active ? 'step' : undefined} onClick={() => onSelect(index)}>
            <span className={`${e.sectionNumber} ${done ? e.sectionNumberDone : active ? e.sectionNumberActive : ''}`} aria-hidden="true">{done ? '✓' : index + 1}</span>
            <span className={e.sectionText}>
              <span className={e.sectionTitle}>{section.title}</span>
              <span className={e.sectionMeta}>{fields.length === 0 ? '원문에서 직접 작성' : `답변 ${answered} / ${fields.length}`}</span>
            </span>
            {fields.length > 0 && <span className={badge}>{status}</span>}
          </button>
        </li>
      })}
    </ol>
    <Link className={e.reviewLink} to="?step=review" aria-current={reviewing ? 'step' : undefined}
      onClick={(event) => { event.preventDefault(); onReview() }}>검토하고 초안 만들기</Link>
  </>
}

function AnswerEditor({ vm }: { vm: EditorViewModel }) {
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const narrow = useMediaQuery(narrowEditorQuery)
  // 마지막 "검토" 단계는 질문 카드 자리에 그리고 주소(`?step=review`)로 남겨 새로고침 · 뒤로 가기에도 유지합니다.
  const reviewing = search.get('step') === 'review'
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
  const [sectionNotice, setSectionNotice] = useState<SectionNotice | null>(null)
  /** 이동할 때마다 1씩 오릅니다. 새 질문을 그린 뒤 스크롤 · 포커스를 옮기는 신호입니다. */
  const [moveCount, setMoveCount] = useState(0)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const listButtonRef = useRef<HTMLButtonElement>(null)
  /** [다음 →]이 검토의 [초안 만들기]로 바뀐 시각입니다. */
  const reviewShownAt = useRef(0)
  const menu = useFloatingPopover({ open: menuOpen, placement: 'bottom-end' })
  const current = questions[Math.min(index, Math.max(0, questions.length - 1))]
  const currentValue = current ? valueOf(current.section, current.field) : ''
  const undecided = currentValue === undecidedAnswer
  const options = current?.field.options ?? []
  const missingOptions = current ? options.length === 0 && /택\s*1|하나.{0,10}선택|중.{0,10}선택/.test(`${current.field.label} ${current.field.guidance}`) : false
  const missingRequired = questions.filter((question) => requiredEmpty(question, valueOf))
  const requiredMissing = missingRequired.length
  const missingOptional = questions.filter(({ section, field }) => !field.required && writable(field) && !valueOf(section, field).trim())
  const optionalMissing = missingOptional.length
  const draftMode = applicationDraftMode(questions.map(({ section, field }) => ({ field, value: valueOf(section, field) })))
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
  // 항목을 골라 닫을 때는 move()가 이미 질문 제목으로 포커스를 옮겼으므로 그대로 둡니다.
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

  /**
   * 질문 카드 윗변이 머리글 밑으로 들어가 있으면 작업 영역 스크롤 칸을 "카드 윗변 − 머리글 높이 − 16px"로 직접 스크롤합니다.
   * 포커스의 부수 효과로 스크롤하지 않도록 포커스는 호출하는 쪽이 `preventScroll`로 줍니다.
   */
  function revealCard() {
    const scroller = mainRef.current?.parentElement
    const card = cardRef.current
    if (!scroller || !card || typeof scroller.scrollTo !== 'function') return
    const headerHeight = Number.parseFloat(getComputedStyle(scroller).getPropertyValue('--workspace-header-h')) || 0
    const offset = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - headerHeight - 16
    if (offset < 0) scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + offset) })
  }

  // 이동한 뒤: 새 질문(또는 검토)을 그린 다음 카드를 머리글 바로 아래로 올리고 제목에 포커스를 줍니다.
  useLayoutEffect(() => {
    if (moveCount === 0) return
    revealCard()
    headingRef.current?.focus({ preventScroll: true })
  }, [moveCount])

  /** 검토 단계를 주소에 넣거나 뺍니다. 질문 주소(`?question=`)는 그대로 둡니다. */
  function setReviewStep(on: boolean) {
    if (on === reviewing) return
    setSearch((previous) => {
      const next = new URLSearchParams(previous)
      if (on) next.set('step', 'review')
      else next.delete('step')
      return next
    })
  }

  /** 자동 저장을 먼저 비운 뒤 질문(또는 검토)을 바꿉니다. 섹션 띠는 이동마다 새로 정합니다. */
  function move(target: number | 'review', notice: SectionNotice | null = null) {
    void vm.flushAutosave()
    if (target === 'review') setReviewStep(true)
    else {
      setIndex(Math.max(0, Math.min(questions.length - 1, target)))
      setReviewStep(false)
    }
    setSectionNotice(notice)
    setSheetOpen(false)
    setMoveCount((count) => count + 1)
  }
  /** 마지막 질문의 [다음 →]은 검토 단계로 갑니다. 섹션을 넘어가면 앞 항목의 결과를 띠와 status로 한 번 알립니다. */
  function goNext() {
    if (!current) return
    if (index >= questions.length - 1) {
      reviewShownAt.current = Date.now()
      move('review')
      return
    }
    const target = questions[index + 1]!
    if (target.sectionIndex === current.sectionIndex) {
      move(index + 1)
      return
    }
    const gaps = questions.filter((question) => question.sectionIndex === current.sectionIndex && requiredEmpty(question, valueOf))
    move(index + 1, gaps.length > 0
      ? { text: `${current.section.title}에 비어 있는 필수 질문이 ${gaps.length}개 있어요 → ${target.section.title}`, missingIndex: questions.indexOf(gaps[0]!) }
      : { text: `${current.section.title} 완료 → ${target.section.title}`, missingIndex: null })
  }
  function goPrevious() {
    if (reviewing) move(questions.length - 1)
    else if (index > 0) move(index - 1)
  }
  function goSection(sectionIndex: number) {
    const inSection = questions.filter((question) => question.sectionIndex === sectionIndex)
    const open = inSection.find(({ section, field }) => writable(field) && !valueOf(section, field).trim()) ?? inSection[0]
    if (open) move(questions.indexOf(open))
    else setSheetOpen(false)
  }
  /** Ctrl/⌘ + Enter는 다음, Ctrl/⌘ + Shift + Enter는 이전입니다. 한글 조합 중에는 무시하고, 그냥 Enter는 줄바꿈 그대로입니다. */
  function onQuestionKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    if (event.shiftKey) goPrevious()
    else goNext()
  }
  /**
   * 검토의 [초안 만들기]입니다. 비어 있는 질문이 있어도(아무것도 입력하지 않았어도) 막지 않습니다. 비어 있는 필수 질문은 위 요약이 알리고,
   * 초안에는 저장된 답변만 기입됩니다. 입력 중인 답변을 먼저 저장하고 그 입력 버전으로 초안 화면에 갑니다.
   */
  async function createDraft() {
    if (Date.now() - reviewShownAt.current < swappedButtonGuardMs) return
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
  const saveStatus = vm.autosave.status === 'saving' ? '저장 중…'
    : vm.autosave.status === 'saved' ? `자동 저장됨 · ${savedTimeLabel(vm.autosave.savedAt, now)}`
      : vm.autosave.status === 'failed' ? '저장 실패' : vm.hasPendingAnswers ? '입력을 멈추면 저장돼요' : '입력하면 자동으로 저장돼요'
  const reanalyzeTo = `${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: form.sourceCode, sourceProgramId: form.sourceProgramId })}`
  const documentsTo = `${appPaths.applicationPreparations}/${preparation.id}/documents`
  // 검토 단계에서는 모든 항목을 지나온 항목으로 봅니다(빈 필수 질문이 있으면 "필수 비어 있음").
  const nav = <SectionNav sections={sections} valueOf={valueOf} activeSectionIndex={reviewing ? sections.length : current?.sectionIndex ?? 0} onSelect={goSection}
    requiredMissing={requiredMissing} reviewing={reviewing} onReview={() => move('review')} />
  const hasQuestions = questions.length > 0
  // [← 이전] · 자동 저장 상태 · [다음 →](검토에서는 [초안 만들기]). PC는 카드 바닥 줄, 600px 미만은 아래 고정 바입니다.
  // 600px 미만에서는 자동 저장 상태를 위쪽 진행 줄에 두므로 바에는 버튼만 둡니다. 아래 고정 바일 때는 도우미 런처를 그 위로 올립니다.
  const moveButtons = hasQuestions ? <div className={narrow ? e.bar : e.cardFooter} {...(narrow ? assistantLift.narrow : {})}>
    <button type="button" className={e.prevButton} disabled={!reviewing && index === 0} aria-keyshortcuts="Control+Shift+Enter" onClick={goPrevious}>← 이전</button>
    {!narrow && <p className={e.footerStatus} role="status" aria-live="polite">{saveStatus}</p>}
    {reviewing
      ? <button type="button" className={e.nextButton} onClick={() => { void createDraft() }}><EditorIcon name="doc" size={16} />초안 만들기</button>
      : <button type="button" className={e.nextButton} aria-keyshortcuts="Control+Enter" onClick={goNext}>다음 →</button>}
  </div> : null
  // 검토 단계("Check answers"): 비어 있는 필수 질문 요약(각 질문으로 가는 링크) · 항목별 답변 수 · 선택 질문 안내 · 주 버튼 하나.
  const reviewCard = <section className={e.question} aria-labelledby="answer-review-title">
    <p className={e.questionEyebrow}>검토 · 질문 {questions.length}개를 모두 지났어요</p>
    <h3 className={e.questionTitle} id="answer-review-title" ref={headingRef} tabIndex={-1}>초안을 만들기 전에 확인해 주세요</h3>
    {requiredMissing > 0
      ? <div className={e.errorSummary} role="alert" aria-labelledby="answer-review-missing">
        <p className={e.errorSummaryTitle} id="answer-review-missing">필수 질문 {requiredMissing}개가 비어 있어요</p>
        <p className="m-0">비워 둔 채로도 초안을 만들 수 있어요. 비운 질문은 문서에 빈칸으로 남아요.</p>
        <ul className={e.errorList}>
          {missingRequired.map((question) => <li key={question.key}>
            <Link className={e.errorLink} to={`?question=${encodeURIComponent(question.field.key)}`}
              onClick={(event) => { event.preventDefault(); move(questions.indexOf(question)) }}>{question.section.title} · {question.field.label}</Link>
          </li>)}
        </ul>
        <button type="button" className={`${e.retryButton} self-start`} onClick={() => move(questions.indexOf(missingRequired[0]))}>첫 빈 필수 질문으로</button>
      </div>
      : <p className={e.successNote}>필수 질문을 모두 채웠어요</p>}
    <ol className={e.reviewRows} aria-label="항목별 답변">
      {sections.map((section, sectionIndex) => {
        const fields = section.fields.filter(writable)
        const answered = fields.filter((field) => valueOf(section, field).trim()).length
        const requiredLeft = fields.filter((field) => requiredEmpty({ section, field }, valueOf)).length
        const optionalLeft = fields.length - answered - requiredLeft
        const badge = fields.length === 0 ? null
          : requiredLeft > 0 ? { label: `필수 ${requiredLeft}`, className: e.badgeWarning }
            : optionalLeft > 0 ? { label: `선택 ${optionalLeft}`, className: e.badgeIdle } : { label: '완료', className: e.badgeDone }
        return <li key={section.key}>
          <button type="button" className={e.sectionButton} onClick={() => goSection(sectionIndex)}>
            <span className={e.sectionText}>
              <span className={e.sectionTitle}>{sectionIndex + 1}. {section.title}</span>
              <span className={e.sectionMeta}>{fields.length === 0 ? '원문에서 직접 작성' : `답변 ${answered} / ${fields.length}`}</span>
            </span>
            {badge && <span className={badge.className}>{badge.label}</span>}
          </button>
        </li>
      })}
    </ol>
    {optionalMissing > 0 && <p className={e.reviewNote}>
      선택 질문 {optionalMissing}개는 비워 두면 문서에 빈칸으로 남아요.
      {requiredMissing === 0 && <> <button type="button" className={e.retryButton} onClick={() => move(questions.indexOf(missingOptional[0]))}>첫 빈 선택 질문으로</button></>}
    </p>}
    <p className={e.reviewNote}>{draftMode === 'writing'
      ? 'AI가 공식 양식에 답변을 기입해요 · 보통 1~3분'
      : draftMode === 'manualOnly'
        ? '저장된 답변 중 양식에 자동으로 기입할 수 있는 것이 없어 초안을 만들지 못할 수 있어요. 원문 양식에 직접 옮겨 적어 주세요.'
        : '입력한 답변이 없어요. 지금 초안을 만들면 답변을 기입하지 않은 공식 양식 그대로 저장돼요.'}</p>
    {!narrow && moveButtons}
  </section>

  return <>
    <WorkspacePageHeader
      parent={{ to: appPaths.applicationPreparations, label: featureTitle }}
      title="답변 입력"
      actions={<>
        <button ref={listButtonRef} type="button" className={`${e.iconButton} ${e.iconButtonM}`} aria-label="항목 목록" aria-haspopup="dialog" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)}><EditorIcon name="list" /></button>
        {vm.documentCount > 0 && <Link className={`${workspacePageStyles.secondaryButton} max-[599px]:hidden`} to={documentsTo}><EditorIcon name="doc" size={16} />문서 보기</Link>}
        <div ref={menuRef} className="relative">
          <button ref={menu.reference} type="button" className={e.iconButton} aria-label="문서 메뉴" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><EditorIcon name="more" /></button>
          {/* assistantCover.narrow: 600px 미만에서 열려 있는 동안 도우미 런처를 숨깁니다(assistantPlacement 참고). */}
          {menuOpen && <div ref={menu.floating} style={menu.floatingStyles} className={e.menu} role="menu" aria-label="문서 메뉴" {...assistantCover.narrow}>
            {vm.documentCount > 0 && <Link className={`${e.menuItem} min-[600px]:hidden`} role="menuitem" to={documentsTo} onClick={() => setMenuOpen(false)}>문서 보기</Link>}
            <a className={e.menuItem} role="menuitem" href={form.sourceUrl} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}>원문 보기 ↗</a>
            <Link className={e.menuItem} role="menuitem" to={reanalyzeTo} onClick={() => setMenuOpen(false)}>양식 다시 분석해 새로 시작</Link>
          </div>}
        </div>
      </>}
    />
    <main className={workspacePageStyles.content} ref={mainRef}>
      <ApplicationPreparationLede preparation={preparation} />
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
          {narrow && current && <div className={e.stepperM}>
            {/* 카드와 같은 전체 기준 진행("질문 8 / 34")입니다. 항목 번호("섹션 1/3")를 섞지 않습니다. */}
            <p className={e.stepperMLabel}>
              <span className="min-w-0 truncate">{reviewing ? '검토하고 초안 만들기' : current.section.title}</span>
              <span className="shrink-0 tabular-nums">{reviewing ? `질문 ${questions.length}개` : `질문 ${index + 1} / ${questions.length}`}</span>
            </p>
            <div className={e.progressBar} aria-hidden="true"><span className={e.progressFill} style={{ width: `${reviewing ? 100 : Math.round(((index + 1) / questions.length) * 100)}%` }} /></div>
            <p className={e.barStatusM} role="status" aria-live="polite">{saveStatus}</p>
          </div>}
          {failed && <div className={e.dangerAlert} role="alert">
            <p className={e.dangerText}>{failed.conflict
              ? '다른 곳에서 답변이 먼저 바뀌어 최신 답변을 다시 불러왔어요. 입력 중이던 값을 확인한 뒤 다시 저장해 주세요.'
              : `답변을 저장하지 못했어요. ${failed.error.message}`}</p>
            <button type="button" className={e.retryButton} onClick={vm.retryAutosave}>{failed.conflict ? '내 답변으로 다시 저장' : '다시 시도'}</button>
          </div>}
          <div ref={cardRef} className="flex min-w-0 flex-col gap-3">
            {/* 섹션 경계 알림. status는 늘 두고(내용이 바뀔 때 한 번 읽힘), 띠는 섹션이 바뀐 첫 질문에서만 보입니다. */}
            <div className={sectionNotice ? (sectionNotice.missingIndex === null ? e.sectionBand : e.sectionBandWarning) : 'contents'}>
              <p className={sectionNotice ? e.sectionBandText : 'sr-only'} role="status" aria-live="polite">{sectionNotice?.text ?? ''}</p>
              {sectionNotice && sectionNotice.missingIndex !== null && <button type="button" className={e.retryButton} onClick={() => move(sectionNotice.missingIndex!)}>그 질문으로</button>}
            </div>
            {!hasQuestions ? <p className={s.notice}>이 양식에는 자동 기입할 문항이 없습니다. 원문 양식에서 직접 작성해 주세요.</p>
              : reviewing ? reviewCard : current && <section className={e.question} aria-label={`${current.section.title} 작성`} onKeyDown={onQuestionKeyDown}>
              <div className={e.questionHead}>
                {/* 600px 미만은 위 진행 줄이 "질문 n / m"을 알리므로 카드에는 섹션 이름만 둡니다. */}
                <p className={e.questionEyebrow}>{narrow ? current.section.title : `${current.section.title} · 질문 ${index + 1} / ${questions.length}`}</p>
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
              {!narrow && moveButtons}
            </section>}
          </div>
          {/* 온라인 신청 입력 도우미(답변 복사 · TXT 받기)는 평소에는 숨기고, 초안 실패 카드의 [답변 모아 보기](`?helper=open`)로 들어올 때만 펼쳐 보여 줍니다. */}
          {search.get('helper') === 'open' && <ApplicationOnlineInputGuide preparationId={preparation.id} inputRevision={preparation.inputRevision} defaultOpen />}
        </div>
      </div>
      {narrow && moveButtons}
    </main>
    {sheetOpen && <>
      <button type="button" className={e.sheetScrim} aria-label="항목 목록 닫기" tabIndex={-1} onClick={() => setSheetOpen(false)} />
      <div ref={sheetRef} className={e.sheet} role="dialog" aria-modal="true" aria-label="항목 목록" tabIndex={-1} onKeyDown={onSheetKeyDown} {...assistantCover.narrow}>
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
  const days = daysUntil(item.applicationEndDate)
  if (days === null) return null
  if (days < 0) return { label: programStatusLabels.CLOSED, className: s.badgeDeadline }
  return { label: formatDday(days), className: `${s.badgeDday} ${ddayToneClassNames[ddayTone(days)]}` }
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

/**
 * 분석 상태별 배지 · 한 줄 설명 · 버튼입니다. 버튼은 그 공고의 새 문서 화면으로 가고, 거기서 할 일을 이름으로 알립니다:
 * 분석 중은 진행 카드, 결과 확인 중은 확인 안내, 완료·결과 확인됨은 조회한 양식입니다. 실패는 이유를 카드에 바로 적고 [다시 분석]을
 * 둡니다(새 문서 화면에서 누를 때만 시작). 작성할 양식을 얻지 못한 분석은 실패가 아니라 "원문 참고"로 보이고 공식 원문(`sourceUrl`, 새 창)을 엽니다.
 */
function analysisCardView({ job, state }: FormAnalysisRow): { badge: string; tone: string; note: string; action: string; sourceUrl?: string } {
  if (state === 'active') return job.status === 'QUEUED'
    ? { badge: '분석 대기', tone: s.badgeProgress, note: '차례를 기다리고 있어요. 곧 분석을 시작해요', action: '이어서 보기' }
    : { badge: '분석 중', tone: s.badgeWorking, note: '공식 첨부에서 신청 양식을 분석하고 있어요', action: '이어서 보기' }
  if (state === 'unknown') return { badge: '결과 확인 중', tone: s.badgeChecking, note: '분석 결과를 확인하고 있어요. 늦어도 30분 안에 정리돼요', action: '상태 보기' }
  if (state === 'done') return { badge: '분석 완료', tone: s.badgeDone, note: '양식을 확인하고 작성을 시작할 수 있어요', action: '양식 보기' }
  if (state === 'settled') return { badge: '결과 확인됨', tone: s.badgeDeadline, note: '분석 결과가 확인됐어요. 양식이 있는지 확인해 주세요', action: '결과 보기' }
  if (state === 'source') {
    const view = { badge: '원문 참고', tone: s.badgeDeadline, note: formAnalysisFailureReason(job.failureCode) }
    return job.programSourceUrl ? { ...view, action: '원문 보기 ↗', sourceUrl: job.programSourceUrl } : { ...view, action: '자세히 보기' }
  }
  return { badge: '분석 실패', tone: s.badgeUrgent, note: formAnalysisFailureReason(job.failureCode), action: '다시 분석' }
}

/**
 * 초안 만들기 상태를 입힌 문서 카드의 배지 · 진행 줄 · 버튼 이름입니다. 버튼은 모두 초안 화면으로 가서 진행·확인·실패 안내를 봅니다.
 * 만드는 중은 서버가 기록한 단계(4단계)를 그대로 보여 주고, 실패는 결과 화면의 실패 카드와 같은 제목을 씁니다.
 */
function documentJobView({ kind, job }: DocumentJobState): { badge: string; tone: string; line: string; step: number | null; action: string } {
  if (kind === 'unknown') return { badge: '결과 확인 중', tone: s.badgeChecking, line: '초안 결과를 확인하고 있어요. 확인이 끝나면 자동으로 풀려요', step: null, action: '상태 보기' }
  if (kind === 'failed') return { badge: '초안 실패', tone: s.badgeFailed, line: generationFailureTitle(job), step: null, action: '자세히 보기' }
  if (job.status === 'QUEUED') return { badge: '초안 대기', tone: s.badgeProgress, line: '차례를 기다리고 있어요', step: 0, action: '진행 보기' }
  const index = generationStages.findIndex(([stage]) => stage === job.stage)
  return {
    badge: '초안 만드는 중', tone: s.badgeWorking, step: index + 1, action: '진행 보기',
    line: index >= 0 ? `${index + 1} / ${generationStages.length} 단계 · ${generationStages[index][1]}` : '곧 시작해요',
  }
}

/**
 * 목록 안의 양식 분석 카드입니다. 새 문서에서 시작한 분석은 아직 신청 문서가 아니므로 "양식 분석" 배지로 구분하고,
 * 신청 문서 카드와 같은 틀에 공고명 · 상태 · 분석한 날을 둡니다. 누르면 그 공고의 새 문서 화면으로 가서 양식을 확인하고 작성을 시작합니다.
 */
/** 끝났지만 아직 결과 화면을 열지 않은 카드의 표시입니다. 배지 줄 오른쪽 끝에 둡니다. */
function NewResultMark() {
  return <span className={s.newResult}><span className={s.newResultDot} aria-hidden="true" />새 결과</span>
}

function FormAnalysisCard({ row, readAt, unseen }: { row: FormAnalysisRow; readAt: number; unseen: boolean }) {
  const { job, state } = row
  const view = analysisCardView(row)
  const to = `${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: job.sourceCode, sourceProgramId: job.sourceProgramId })}`
  // 작업 중인 카드는 테두리 색 · 배지 스피너 · 진행 줄로 다른 카드와 구분합니다. 분석은 서버가 단계를 알려 주지 않아 경과 시간만 보입니다.
  const analyzing = state === 'active' && job.status === 'RUNNING'
  const minutes = Math.max(0, Math.floor((readAt - Date.parse(job.createdAt)) / 60_000))
  const frame = state === 'active' ? s.listCardWorking : state === 'unknown' ? s.listCardChecking : unseen ? s.listCardUnseen : ''
  return <li className={`${s.listCard} ${frame}`}>
    <div className={s.badgeRow}>
      <span className={s.badgeAnalysis}>양식 분석</span>
      <span className={view.tone}>{analyzing && <ButtonSpinner />}{view.badge}</span>
      {unseen && <NewResultMark />}
    </div>
    <Link className={`${s.listLink} min-w-0`} to={to}>
      <strong className={s.listTitle}>{job.programTitle}</strong>
      <span className={s.listMeta}>{view.note}</span>
    </Link>
    {analyzing && <div className="flex flex-col gap-1">
      <span className={s.cardStamp}>{Number.isNaN(minutes) || minutes < 1 ? '방금 시작했어요' : `${minutes}분 지남`} · 보통 1~3분</span>
      <div className={s.workTrack} aria-hidden="true"><div className={s.workSweep} /></div>
    </div>}
    <div className={s.cardFooter}>
      <span className={s.cardStamp}>{state === 'active' || state === 'unknown' ? `${clockTime(job.createdAt)} 시작` : `${shortDate(job.createdAt)} 분석`}</span>
      <div className={s.cardActions}>
        {view.sourceUrl
          ? <a className={s.secondarySm} href={view.sourceUrl} target="_blank" rel="noreferrer">{view.action}<span className="sr-only">: {job.programTitle} (새 창)</span></a>
          : <Link className={s.secondarySm} to={to}>{view.action}<span className="sr-only">: {job.programTitle}</span></Link>}
      </div>
    </div>
  </li>
}

function ApplicationPreparationList() {
  const vm = useApplicationPreparationListViewModel()
  const [confirming, setConfirming] = useState<ApplicationPreparationSummary | null>(null)
  // 스켈레톤은 보여 줄 목록이 아직 없을 때(처음 들어왔을 때)만, 300ms가 넘으면 띄웁니다.
  // 필터를 바꿨을 때는 기존 카드를 흐리게 둔 채 새 결과로 바로 바꿉니다. 화면이 한 번만 바뀌고, 탭에는 따로 표시를 붙이지 않습니다.
  const refreshing = vm.isInitialLoading && vm.page !== null
  const showSkeleton = useDelayedFlag(vm.isInitialLoading && vm.page === null)
  const items = vm.page?.items ?? []
  // 공고 상세에서 돌아올 때 보던 필터를 유지합니다.
  const returnTo = vm.status ? `${appPaths.applicationPreparations}?status=${vm.status}` : appPaths.applicationPreparations
  return <>
    <WorkspacePageHeader
      title={listTitle}
      tabs={<div className={workspacePageStyles.segment} role="tablist" aria-label="작성 상태 필터">
        {listStatusTabs.map((tab) => <button className={workspacePageStyles.segmentTab} key={tab.label} type="button" role="tab"
          aria-selected={vm.status === tab.value} onClick={() => vm.setStatus(tab.value)}>{tab.label}</button>)}
      </div>}
      actions={<Link className={workspacePageStyles.primaryButton} to={appPaths.applicationPreparationNew}>새 문서</Link>}
    />
    <main className={workspacePageStyles.content}>
      {vm.error && <ErrorNotice message={vm.error.message} retryLabel="목록 다시 불러오기" onRetry={vm.retry} />}
      {vm.isInitialLoading && <p className="sr-only" role="status" aria-live="polite">신청 준비 목록을 불러오는 중입니다.</p>}
      {showSkeleton && <div className={s.cardGrid} aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((index) => <div className={s.listCard} key={index}><ListCardSkeleton /></div>)}
      </div>}
      {/* 다른 작업 화면과 같은 공용 빈 화면(회색 아이콘 · 제목 · 설명 · 초록 버튼)을 씁니다. 버튼은 머리글 [새 문서]와 같은 화면으로 갑니다. */}
      {vm.page && items.length === 0 && vm.analyses.length === 0 && !vm.isInitialLoading && <EmptyState
        icon={<DocumentIcon />}
        title={vm.status === undefined ? '아직 시작한 신청 문서가 없어요' : vm.status === 'done' ? '완료한 신청 문서가 없어요' : '진행 중인 신청 문서가 없어요'}
        description="지원할 공고를 고르면 공식 양식과 지원 분야를 확인한 뒤 바로 작성할 수 있어요."
        action={{ label: '신청 문서 시작하기', to: appPaths.applicationPreparationNew }} />}
      {items.length + vm.analyses.length > 0 && <ul className={`${s.cardGrid} ${refreshing ? k.stale : ''}`} aria-label="신청 준비 목록" aria-busy={refreshing || vm.isLoadingMore}>
        {/* 양식만 분석해 둔 공고는 신청 문서 카드 앞에 "양식 분석" 카드로 둡니다. */}
        {vm.analyses.map((row) => <FormAnalysisCard key={`analysis-${row.job.id}`} row={row} readAt={vm.analysesReadAt} unseen={vm.isAnalysisUnseen(row.job)} />)}
        {items.map((item) => {
          const deadline = deadlineBadge(item)
          const done = item.hasCurrentDocument === true
          const progress = item.requiredTotal !== undefined && item.answeredRequired !== undefined ? { answered: item.answeredRequired, total: item.requiredTotal } : null
          // 초안을 만드는 중 · 결과 확인 중 · 실패한 문서는 카드에서 바로 알 수 있게 하고, 누르면 초안 화면으로 갑니다.
          const jobState = vm.documentJobStateOf(item)
          const job = jobState ? documentJobView(jobState) : null
          const working = jobState?.kind === 'active'
          const making = working && jobState.job.status === 'RUNNING'
          // 끝났지만 아직 열어 보지 않은 결과는 "새 결과"로 알리고, 초안 화면을 열면(거기서 확인 처리) 사라집니다.
          const unseen = vm.isDocumentResultUnseen(item)
          const to = done || jobState || unseen ? `${appPaths.applicationPreparations}/${item.id}/documents` : `${appPaths.applicationPreparations}/${item.id}`
          const frame = working ? s.listCardWorking : jobState?.kind === 'unknown' ? s.listCardChecking : unseen ? s.listCardUnseen : ''
          return <li className={`${s.listCard} ${frame}`} key={item.id}>
            <div className={s.badgeRow}>
              {job
                ? <span className={job.tone}>{making && <ButtonSpinner />}{job.badge}</span>
                : <span className={done ? s.badgeDone : s.badgeProgress}>{done ? '완료' : '작성 중'}</span>}
              {deadline && <span className={deadline.className}>{deadline.label}</span>}
              {unseen && <NewResultMark />}
            </div>
            <Link className={`${s.listLink} min-w-0`} to={to}>
              <strong className={s.listTitle}>{item.programTitle}</strong>
              <span className={s.listMeta}>{unseen && done && !job ? '초안을 만들었어요. 열어서 확인해 주세요' : `${item.formTitle} · ${applicationServiceFieldLabels[item.serviceField]}`}</span>
            </Link>
            {job
              ? <div className="flex flex-col gap-1">
                <span className={s.cardStamp}>{job.line}</span>
                {job.step !== null && <div className={s.workSteps} aria-hidden="true">
                  {generationStages.map(([stage], index) => <span key={stage} className={index < (job.step ?? 0) ? s.workStepOn : s.workStep} />)}
                </div>}
              </div>
              : progress && <div className="flex flex-col gap-1" aria-label={`필수 답변 ${progress.answered} / ${progress.total}`}>
              <span className={s.cardStamp}>필수 답변 {progress.answered} / {progress.total}</span>
              <div className={s.progressTrack}><div className={s.progressFill} style={{ width: `${progress.total === 0 ? 0 : Math.min(100, Math.round(progress.answered / progress.total * 100))}%` }} /></div>
            </div>}
            <div className={s.cardFooter}>
              <span className={s.cardStamp}>{jobState && jobState.kind !== 'failed' ? `${clockTime(jobState.job.createdAt)} 시작`
                : done ? `초안 있음 · ${shortDate(item.updatedAt)}` : `${shortDate(item.updatedAt)} 수정`}</span>
              <div className={s.cardActions}>
                {/* 초안을 만드는 중이거나 결과를 확인하는 중에는 삭제를 막습니다. 끝나면 다시 지울 수 있습니다. */}
                <PreparationMenu item={item} returnTo={returnTo} disabled={vm.deletingId !== null || working || jobState?.kind === 'unknown'} onDelete={() => setConfirming(item)} />
                <Link className={s.secondarySm} to={to}>{job ? job.action : done ? '문서 보기' : unseen ? '결과 보기' : '이어서 작성'}{job && <span className="sr-only">: {item.programTitle}</span>}</Link>
              </div>
            </div>
          </li>
        })}
        {/* 더 불러오는 동안 목록 끝에 카드 자리를 덧붙입니다. */}
        {vm.isLoadingMore && [0, 1, 2].map((index) => <li className={s.listCard} key={`more-${index}`} aria-hidden="true"><ListCardSkeleton /></li>)}
      </ul>}
      {vm.page && vm.page.nextBeforeId !== null && !vm.error && !vm.isInitialLoading && <div className={s.moreActions}>
        <button className={s.button} disabled={vm.isLoadingMore} aria-busy={vm.isLoadingMore} type="button" onClick={() => { vm.loadMore() }}>
          {vm.isLoadingMore && <ButtonSpinner />}{vm.isLoadingMore ? '이전 작업 불러오는 중…' : '이전 작업 더 보기'}
        </button>
        <span className={s.muted}>{items.length}건 표시</span>
        {vm.isLoadingMore && <p className="sr-only" role="status" aria-live="polite">이전 신청 준비를 불러오는 중입니다.</p>}
      </div>}
    </main>
    <WorkspaceModal isOpen={confirming !== null} title="신청 문서를 삭제할까요?" tone="danger" onClose={() => setConfirming(null)}
      description={confirming ? `${confirming.programTitle}의 답변${confirming.answeredRequired !== undefined ? ` ${confirming.answeredRequired}개` : ''}와 AI 실행 기록이 모두 지워져요. 되돌릴 수 없어요.` : undefined}>
      <div className="flex flex-wrap justify-end gap-2">
        <button className={s.button} disabled={vm.deletingId !== null} type="button" onClick={() => setConfirming(null)}>취소</button>
        <button className={s.dangerSolid} disabled={vm.deletingId !== null} aria-busy={vm.deletingId !== null} type="button" onClick={() => {
          if (confirming === null) return
          void vm.deletePreparation(confirming.id).then((deleted) => { if (deleted) setConfirming(null) })
        }}>{vm.deletingId !== null && <ButtonSpinner />}{vm.deletingId !== null ? '삭제 중…' : '삭제'}</button>
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
  // 300ms 안에 끝나면 스켈레톤을 띄우지 않고, 더 걸리면 실제 배치(왼쪽 항목 목록 + 질문 카드)와 같은 틀을 먼저 그립니다.
  const showSkeleton = useDelayedFlag(vm.loading && !vm.preparation)
  // 답변 입력은 머리글부터 화면 전체를 자기 배치로 그립니다. 불러오는 중·실패는 아래 공용 틀로 보여 줍니다.
  if (vm.preparation) return <AnswerEditor key={vm.preparation.id} vm={vm} />
  return <>
    <WorkspacePageHeader parent={{ to: appPaths.applicationPreparations, label: featureTitle }} title="답변 입력" />
    <main className={workspacePageStyles.content}>
      {vm.loading && <p className="sr-only" role="status" aria-live="polite">신청 문서 정보를 불러오는 중입니다.</p>}
      {showSkeleton && <>
        <ApplicationPreparationLede preparation={null} />
        <AnswerEditorSkeleton />
      </>}
      {vm.error && <ErrorNotice message={vm.error.message} onRetry={vm.load} />}
    </main>
  </>
}
