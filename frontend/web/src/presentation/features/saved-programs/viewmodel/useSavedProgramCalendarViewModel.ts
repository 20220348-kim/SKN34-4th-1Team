import { useEffect, useRef, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import type { SavedSupportProgram } from '../../../../domain/entities/SavedSupportProgram'
import type { BrowseSavedSupportProgramsUseCase, RemoveSavedSupportProgramUseCase, SaveSupportProgramUseCase } from '../../../../domain/usecases/SavedSupportProgramUseCases'
import type { SavedProgramsViewMode } from '../../../shared/routes/appPaths'
import {
  buildCalendarWeeks,
  calendarToday,
  defaultSavedProgramCalendarFilters,
  daysUntilDeadline,
  filterCalendarPrograms,
  firstCalendarYear,
  lastCalendarYear,
  sortByDeadline,
  toCalendarPrograms,
  type CalendarProgram,
  type SavedProgramCalendarFilters,
} from './savedProgramCalendar'

export type { SavedProgramsViewMode } from '../../../shared/routes/appPaths'
export type SavedProgramsBrowseUseCase = Pick<BrowseSavedSupportProgramsUseCase, 'execute'>
export type SavedProgramsSaveUseCases = {
  remove: Pick<RemoveSavedSupportProgramUseCase, 'execute'>
  save: Pick<SaveSupportProgramUseCase, 'execute'>
}

/** 목록·달력에서 뺀 뒤의 안내입니다. [되돌리기]로 다시 담을 수 있습니다. */
export type SavedProgramRemovalNotice = { id: number; text: string; program: CalendarProgram | null }

/** 관심 공고함을 불러오는 중 · 실패 · 비어 있음 안내입니다. 버튼 이름은 공고 상세의 [관심 공고에 담기]와 같게 씁니다. */
export const savedSupportProgramMessages = {
  emptyTitle: '아직 담은 공고가 없어요',
  emptyDescription: '공고 상세에서 [관심 공고에 담기]를 누르면 여기에 모여요.',
  loading: '관심 공고를 불러오는 중이에요.',
  failed: '관심 공고를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
} as const

const savedProgramListPageSize = 8

type LoadState =
  | { phase: 'loading'; items: SavedSupportProgram[] }
  | { phase: 'ready'; items: SavedSupportProgram[] }
  | { phase: 'failed'; items: SavedSupportProgram[] }

/** 서버 공고는 UseCase로 읽고, 월 선택·필터·보기 방식은 화면 로컬 상태로 관리합니다. */
export function useSavedProgramCalendarViewModel(
  input?: { today: string; programs: readonly CalendarProgram[] },
  browseUseCase: SavedProgramsBrowseUseCase = appContainer.resolve('browseSavedSupportProgramsUseCase'),
  /** 주소가 가리키는 탭입니다. 공고 상세에서 돌아올 때 보던 탭 그대로 열리게 합니다. */
  initialViewMode: SavedProgramsViewMode = 'calendar',
  saveUseCases: SavedProgramsSaveUseCases = {
    remove: appContainer.resolve('removeSavedSupportProgramUseCase'),
    save: appContainer.resolve('saveSupportProgramUseCase'),
  },
) {
  const [initial] = useState(() => {
    const today = input?.today ?? calendarToday()
    return { today, programs: input?.programs ?? null }
  })
  const [loadState, setLoadState] = useState<LoadState>({ phase: initial.programs ? 'ready' : 'loading', items: [] })
  const [loadVersion, setLoadVersion] = useState(0)
  const [display, setDisplay] = useState(() => ({ year: Number(initial.today.slice(0, 4)), month: Number(initial.today.slice(5, 7)) }))
  const [filters, setFilters] = useState(defaultSavedProgramCalendarFilters)
  const [viewMode, setViewMode] = useState<SavedProgramsViewMode>(initialViewMode)
  const [listPage, setListPage] = useState(1)
  // 목록·달력에서 뺀 공고는 다시 읽지 않고 화면에서 바로 지웁니다. [되돌리기]로 다시 담으면 되살립니다.
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removalNotice, setRemovalNotice] = useState<SavedProgramRemovalNotice | null>(null)
  const noticeSequence = useRef(0)

  async function removeProgram(program: CalendarProgram) {
    if (!program.sourceCode || !program.sourceProgramId || removingId !== null) return
    const identity = { sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId }
    setRemovingId(program.id)
    try {
      await saveUseCases.remove.execute(identity)
      setRemovedIds((current) => new Set([...current, program.id]))
      noticeSequence.current += 1
      setRemovalNotice({ id: noticeSequence.current, text: '관심 공고함에서 뺐어요.', program })
    } catch {
      noticeSequence.current += 1
      setRemovalNotice({ id: noticeSequence.current, text: '관심 공고에서 빼지 못했어요. 잠시 후 다시 시도해 주세요.', program: null })
    } finally {
      setRemovingId(null)
    }
  }

  async function undoRemoval() {
    const program = removalNotice?.program
    if (!program?.sourceCode || !program.sourceProgramId || removingId !== null) return
    setRemovingId(program.id)
    try {
      const result = await saveUseCases.save.execute({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId })
      if (result.outcome === 'saved') {
        setRemovedIds((current) => { const next = new Set(current); next.delete(program.id); return next })
        setRemovalNotice(null)
      } else {
        noticeSequence.current += 1
        setRemovalNotice({ id: noticeSequence.current, text: '더 이상 제공되지 않는 공고라 다시 담을 수 없어요.', program: null })
      }
    } catch {
      noticeSequence.current += 1
      setRemovalNotice({ id: noticeSequence.current, text: '다시 담지 못했어요. 잠시 후 다시 시도해 주세요.', program })
    } finally {
      setRemovingId(null)
    }
  }

  useEffect(() => {
    if (initial.programs) return
    const controller = new AbortController()
    setLoadState((current) => ({ phase: 'loading', items: current.items }))
    browseUseCase.execute(controller.signal)
      .then((items) => { if (!controller.signal.aborted) setLoadState({ phase: 'ready', items }) })
      .catch(() => { if (!controller.signal.aborted) setLoadState((current) => ({ phase: 'failed', items: current.items })) })
    return () => controller.abort()
  }, [browseUseCase, initial.programs, loadVersion])

  function chooseMonth(year: number, month: number) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || year < firstCalendarYear || year > lastCalendarYear || month < 1 || month > 12) return
    setDisplay({ year, month })
  }

  function moveMonth(offset: number) {
    const next = new Date(Date.UTC(display.year, display.month - 1 + offset, 1))
    chooseMonth(next.getUTCFullYear(), next.getUTCMonth() + 1)
  }

  function goToToday() {
    const today = calendarToday()
    const target = input ? initial.today : today
    setDisplay({ year: Number(target.slice(0, 4)), month: Number(target.slice(5, 7)) })
  }

  const today = input ? initial.today : calendarToday()
  const programs = (initial.programs ?? toCalendarPrograms(loadState.items)).filter((program) => !removedIds.has(program.id))
  const filteredPrograms = filterCalendarPrograms(programs, filters)
  const weeks = buildCalendarWeeks(display.year, display.month, today, filteredPrograms)
  const programsInMonth = new Set(weeks.flatMap(week => week.flatMap(day => day.events.map(event => event.program.id)))).size
  const allProgramsInMonth = new Set(buildCalendarWeeks(display.year, display.month, today, programs)
    .flatMap(week => week.flatMap(day => day.events.map(event => event.program.id)))).size
  const activeFilterCount = (filters.keyword.trim() ? 1 : 0) + filters.region.length + filters.category.length + filters.target.length
  const listTotalPages = Math.max(1, Math.ceil(filteredPrograms.length / savedProgramListPageSize))
  const safeListPage = Math.min(listPage, listTotalPages)
  // 목록은 마감 임박순입니다.
  const sortedPrograms = sortByDeadline(filteredPrograms)
  const listPrograms = sortedPrograms.slice((safeListPage - 1) * savedProgramListPageSize, safeListPage * savedProgramListPageSize)

  function changeFilter<Key extends keyof SavedProgramCalendarFilters>(key: Key, value: SavedProgramCalendarFilters[Key]) {
    setFilters(current => ({ ...current, [key]: value }))
    setListPage(1)
  }

  /** 지역·분야·대상 값 하나를 켜고 끕니다. */
  function toggleFilterValue(key: 'region' | 'category' | 'target', value: string) {
    setFilters(current => {
      const values = current[key]
      return { ...current, [key]: values.includes(value) ? values.filter(item => item !== value) : [...values, value] }
    })
    setListPage(1)
  }

  function clearFilter(key: keyof SavedProgramCalendarFilters) {
    setFilters(current => ({ ...current, [key]: key === 'keyword' ? '' : [] }))
    setListPage(1)
  }

  function resetFilters() {
    setFilters(defaultSavedProgramCalendarFilters)
    setListPage(1)
  }

  function chooseListPage(page: number) {
    if (!Number.isInteger(page) || page < 1 || page > listTotalPages) return
    setListPage(page)
  }

  return {
    ...display, today, phase: loadState.phase, weeks, programsInMonth, allProgramsInMonth, filters, activeFilterCount,
    viewMode, listPage: safeListPage, listTotalPages, listPrograms, programs, filteredPrograms,
    filteredProgramCount: filteredPrograms.length,
    totalProgramCount: programs.length,
    years: selectableYears(),
    canPreviousMonth: display.year > firstCalendarYear || display.month > 1,
    canNextMonth: display.year < lastCalendarYear || display.month < 12,
    canPreviousYear: display.year > firstCalendarYear,
    canNextYear: display.year < lastCalendarYear,
    removingId, removalNotice, removeProgram, undoRemoval, dismissRemovalNotice: () => setRemovalNotice(null),
    daysUntilDeadline: (program: CalendarProgram) => daysUntilDeadline(program, today),
    chooseMonth, moveMonth, goToToday, changeFilter, toggleFilterValue, clearFilter, resetFilters, setViewMode, chooseListPage,
    retry: () => setLoadVersion((value) => value + 1),
  }
}

/** 연도 직접 선택과 월 이동은 같은 2000~2100년 범위를 사용합니다. */
export function selectableYears(): number[] {
  return Array.from({ length: lastCalendarYear - firstCalendarYear + 1 }, (_, i) => firstCalendarYear + i)
}
