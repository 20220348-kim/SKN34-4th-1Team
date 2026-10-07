import { useCallback, useEffect, useRef, useState } from 'react'
import { appContainer } from '../../../app/appContainer'
import type { SupportProgram, SupportProgramDetail } from '../../../domain/entities/SupportProgram'
import type { SupportProgramCatalog, SupportProgramCatalogFilters } from '../../../domain/entities/SupportProgramCatalog'
import { defaultProgramSelectionFilters, joinFilterValues, splitFilterValues } from './catalogSearchParams'
import { useSavedSupportProgramChoices } from './useSavedSupportProgramChoices'

/**
 * 공고를 고르는 화면이 쓰는 필드입니다. 검색 결과·관심 공고·상세 조회 어느 쪽에서 골라도 같습니다.
 * 신청 경로는 상세 조회에서 고른 공고에만 있습니다.
 */
export type SelectableSupportProgram = Omit<SupportProgram, 'matchedReasons' | 'recommendationScore' | 'eligibilityReview'> & {
  applicationRoute?: SupportProgramDetail['applicationRoute']
}

export function programKey(program: { sourceCode: string; id: string }) {
  return `${program.sourceCode}:${program.id}`
}

/** 고른 행의 추가 조회 상태입니다. ready는 결과가 무엇이든 조회를 마친 상태입니다. */
export type PickLookup<T> =
  | { status: 'loading' }
  | { status: 'ready'; result: T }
  | { status: 'failed'; error: Error }

/**
 * 행을 고를 때마다 그 공고를 한 번 더 조회하는 화면(신청 문서의 저장된 양식 조회)이 넘기는 조회입니다.
 * 넘기면 조회를 마쳐야 고른 공고를 확정할 수 있고, 넘기지 않으면 행을 고르기만 하면 확정할 수 있습니다.
 */
export type ProgramPickLookup<T> = {
  load: (program: SelectableSupportProgram, signal: AbortSignal) => Promise<T>
  /** 패널을 열 때 이미 고른 공고(`current`)의 조회 결과입니다. 조회를 마친 결과면 다시 조회하지 않습니다. */
  current?: PickLookup<T> | null
}

type SearchState = { status: 'idle' | 'loading' | 'more' | 'ready' } | { status: 'failed'; error: Error; append: boolean }

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.')
}

/**
 * 공고 고르기 패널의 상태입니다. 패널이 열릴 때마다 새로 만들어지고, 고른 행은 확정 버튼을 누르기 전까지 임시입니다.
 * `initialFilters`는 전체 검색의 기본 조건(필터 초기화가 돌아가는 값)이고, `lookup`이 있으면 행을 고를 때마다 그 공고를 조회합니다.
 * 두 옵션은 패널을 열 때의 값을 씁니다.
 */
export function useProgramPickerViewModel<T>(current: SelectableSupportProgram | null, options: {
  initialFilters?: SupportProgramCatalogFilters
  lookup?: ProgramPickLookup<T>
} = {}) {
  const catalogUseCase = appContainer.resolve('browseSupportProgramsUseCase')
  const saved = useSavedSupportProgramChoices(true)
  const [defaults] = useState(() => options.initialFilters ?? defaultProgramSelectionFilters)
  const [lookup] = useState(() => options.lookup ?? null)
  const [tab, setTabState] = useState<'saved' | 'search'>('saved')
  const tabChosen = useRef(false)
  const [keyword, setKeyword] = useState(defaults.keyword)
  /** 마지막으로 검색에 적용한 조건입니다. [필터 (n)] 개수와 조건 칩은 이 값을 따릅니다. */
  const [filters, setFilters] = useState<SupportProgramCatalogFilters>(defaults)
  /** 필터 칸에서 고르는 중인 조건입니다. [검색]·Enter를 눌러야 적용됩니다. */
  const [draft, setDraft] = useState<SupportProgramCatalogFilters>(defaults)
  const [results, setResults] = useState<SupportProgram[]>([])
  const [catalog, setCatalog] = useState<SupportProgramCatalog | null>(null)
  const [search, setSearch] = useState<SearchState>({ status: 'idle' })
  const [picked, setPicked] = useState<SelectableSupportProgram | null>(current)
  const [pickedLookup, setPickedLookup] = useState<PickLookup<T> | null>(
    () => current && lookup?.current?.status === 'ready' ? lookup.current : null)
  const searchController = useRef<AbortController | null>(null)
  const pickController = useRef<AbortController | null>(null)

  useEffect(() => () => { searchController.current?.abort(); pickController.current?.abort() }, [])

  // 관심 공고가 하나도 없으면 전체 검색을 기본으로 엽니다. 사용자가 탭을 직접 고른 뒤에는 바꾸지 않습니다.
  useEffect(() => {
    if (!tabChosen.current && saved.phase === 'ready' && saved.programs.length === 0) setTabState('search')
  }, [saved.phase, saved.programs.length])

  const runSearch = useCallback(async (next: SupportProgramCatalogFilters, append = false) => {
    searchController.current?.abort()
    const controller = new AbortController()
    searchController.current = controller
    // 다시 검색할 때 기존 결과는 남겨 둡니다. 패널이 흐리게 보여 주다가 새 결과로 바꿉니다.
    if (!append) { setFilters(next); setDraft(next); setKeyword(next.keyword) }
    setSearch({ status: append ? 'more' : 'loading' })
    try {
      const result = await catalogUseCase.execute({ ...next, keyword: next.keyword.trim() }, controller.signal)
      if (controller.signal.aborted) return
      setCatalog(result)
      setResults((previous) => {
        if (!append) return result.programs
        const seen = new Set(previous.map(programKey))
        return [...previous, ...result.programs.filter((item) => !seen.has(programKey(item)))]
      })
      setSearch({ status: 'ready' })
    } catch (caught) {
      if (controller.signal.aborted) return
      // 새 조건의 검색에 실패하면 이전 조건의 결과를 지금 조건의 결과처럼 남기지 않습니다. 더 보기 실패는 읽은 결과를 둡니다.
      if (!append) { setResults([]); setCatalog(null) }
      setSearch({ status: 'failed', error: asError(caught), append })
    } finally {
      if (searchController.current === controller) searchController.current = null
    }
  }, [catalogUseCase])

  // 전체 검색 탭을 처음 열면 기본 조건으로 한 번 찾아 둡니다.
  useEffect(() => {
    if (tab === 'search' && search.status === 'idle') void runSearch(defaults)
  }, [defaults, runSearch, search.status, tab])

  const setTab = useCallback((next: 'saved' | 'search') => { tabChosen.current = true; setTabState(next) }, [])

  const runLookup = useCallback((program: SelectableSupportProgram) => {
    if (!lookup) return
    pickController.current?.abort()
    const controller = new AbortController()
    pickController.current = controller
    setPickedLookup({ status: 'loading' })
    lookup.load(program, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setPickedLookup({ status: 'ready', result }) })
      .catch((caught: unknown) => { if (!controller.signal.aborted) setPickedLookup({ status: 'failed', error: asError(caught) }) })
  }, [lookup])

  const pick = useCallback((program: SelectableSupportProgram) => {
    setPicked(program)
    runLookup(program)
  }, [runLookup])

  const retryPick = useCallback(() => { if (picked) runLookup(picked) }, [picked, runLookup])

  /** [검색]·Enter: 검색어와 고르는 중인 필터를 함께 적용합니다. */
  const searchKeyword = useCallback(() => {
    void runSearch({ ...draft, keyword: keyword.trim(), page: 1 })
  }, [draft, keyword, runSearch])
  /** 지역·지원 분야는 여러 값을 쉼표로 이어 담습니다("서울,경기"). 고르기만 하고 적용하지 않습니다. */
  const toggleDraftValue = useCallback((key: 'region' | 'category', value: string) => {
    setDraft((currentDraft) => {
      const values = splitFilterValues(currentDraft[key])
      return { ...currentDraft, [key]: joinFilterValues(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]) }
    })
  }, [])
  const changeDraft = useCallback((next: Partial<SupportProgramCatalogFilters>) => setDraft((currentDraft) => ({ ...currentDraft, ...next })), [])
  /** 조건 칩 해제는 누르는 즉시 적용합니다. 지역·지원 분야는 값 하나만 뺍니다. */
  const removeCondition = useCallback((key: 'keyword' | 'region' | 'category' | 'sourceCode' | 'status', value?: string) => {
    const next = key === 'region' || key === 'category'
      ? joinFilterValues(splitFilterValues(filters[key]).filter((item) => item !== value))
      : defaults[key]
    void runSearch({ ...filters, [key]: next, page: 1 })
  }, [defaults, filters, runSearch])
  const resetFilters = useCallback(() => {
    const { region, category, sourceCode, status } = defaults
    void runSearch({ ...filters, region, category, sourceCode, status, page: 1 })
  }, [defaults, filters, runSearch])
  const loadMore = useCallback(() => {
    if (!catalog || catalog.page >= catalog.totalPages) return
    void runSearch({ ...filters, page: catalog.page + 1 }, true)
  }, [catalog, filters, runSearch])
  const retrySearch = useCallback(() => {
    if (search.status === 'failed' && search.append) loadMore()
    else void runSearch(filters)
  }, [filters, loadMore, runSearch, search])

  return {
    tab,
    setTab,
    saved,
    keyword,
    setKeyword,
    defaults,
    filters,
    draft,
    toggleDraftValue,
    changeDraft,
    removeCondition,
    results,
    catalog,
    search,
    searchKeyword,
    resetFilters,
    loadMore,
    retrySearch,
    picked,
    pickedLookup,
    pick,
    retryPick,
    canConfirm: picked !== null && (lookup === null || pickedLookup?.status === 'ready'),
  }
}
