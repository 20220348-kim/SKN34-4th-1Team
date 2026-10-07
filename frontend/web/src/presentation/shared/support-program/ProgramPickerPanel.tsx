import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { daysUntil, programStatusLabels } from '@govbiz/shared/domain/labels'
import { regionNames } from '../../../domain/entities/Region'
import { supportProgramCategories } from '../../../domain/entities/SupportProgramCategory'
import { catalogSourceCodes, catalogSourceLabels, type SupportProgramCatalogFilters } from '../../../domain/entities/SupportProgramCatalog'
import { MultiSelectField } from '../workspace/MultiSelectField'
import { SelectField } from '../workspace/SelectField'
import { StatusTag } from '../workspace/StatusTag'
import { toFilterChoiceOptions } from '../workspace/filterChoiceOptions'
import { useDelayedFlag } from '../workspace/useDelayedFlag'
import { splitFilterValues } from './catalogSearchParams'
import { programBadgeStyles as b, programPickerStyles as p } from './ProgramPicker.styles'
import {
  programKey,
  useProgramPickerViewModel,
  type PickLookup,
  type ProgramPickLookup,
  type SelectableSupportProgram,
} from './useProgramPickerViewModel'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

type ConditionKey = 'keyword' | 'region' | 'category' | 'sourceCode' | 'status'
const filterStatusLabels: Record<SupportProgramCatalogFilters['status'], string> = { ALL: '전체', ...programStatusLabels }

function sourceLabel(sourceCode: string) {
  return (catalogSourceLabels as Record<string, string>)[sourceCode] ?? sourceCode
}

/** 접수 상태 · D-day(공용 StatusTag) · (선택) 출처 배지 한 줄입니다. 마감일이 없거나 지났거나 접수 중이 아니면 D-day는 두지 않습니다. */
export function ProgramBadges({ program, withSource = false, extra }: {
  program: Pick<SelectableSupportProgram, 'status' | 'applicationEndDate' | 'sourceCode'>
  withSource?: boolean
  extra?: ReactNode
}) {
  return <span className={b.row}>
    <StatusTag status={program.status} daysLeft={daysUntil(program.applicationEndDate)} />
    {withSource && <span className={`${b.badge} ${b.outline}`}>{sourceLabel(program.sourceCode)}</span>}
    {extra}
  </span>
}

/** 누른 버튼 안, 문구 앞에 붙이는 스피너입니다. 버튼 글자색을 따릅니다. */
function ButtonSpinner() {
  return <span className={p.buttonSpinner} aria-hidden="true" />
}

/** 공고 행의 자리입니다. 라디오 · 배지 · 공고명 · 기관과 접수 기간. 막대는 장식이라 낭독하지 않습니다. */
function PickerRowSkeletons() {
  const line = (box: string, bar: string) => <span className={`flex items-center ${box}`}><span className={`${p.bar} ${bar}`} /></span>
  return <div className={p.list} aria-hidden="true">
    {[0, 1, 2, 3].map((index) => <div className={p.row} key={index}>
      <span className="flex items-start gap-2.5">
        <span className={`${p.bar} mt-0.5 size-4 shrink-0 rounded-full`} />
        <span className={p.rowText}>
          <span className={`${p.bar} h-[22px] w-16`} />
          {line('h-[1.23rem]', 'h-3.5 w-4/5')}
          {line('h-[17px]', 'h-3 w-3/5')}
        </span>
      </span>
    </div>)}
  </div>
}

/** 목록을 읽는 동안의 표시입니다. 문구는 낭독기용이고, 행 자리는 300ms가 넘어야(`show`) 그립니다. */
function RowSkeletons({ label, show }: { label: string; show: boolean }) {
  return <>
    <p className="sr-only" role="status">{label}</p>
    {show && <PickerRowSkeletons />}
  </>
}

/** 여러 값 필터 버튼에 보일 글자입니다. 없으면 "전체", 하나면 그 값, 여럿이면 "서울 외 1"입니다. */
function multiValueText(values: string[]) {
  if (values.length === 0) return '전체'
  return values.length === 1 ? values[0]! : `${values[0]} 외 ${values.length - 1}`
}

/**
 * 공고 1개를 고르는 옆 패널(600px 미만은 전체 높이 시트)입니다. 관심 공고함 · 전체 검색 두 목록의 라디오 행에서 고르고,
 * 확정 버튼(`confirmLabel`)을 눌러야 뒤 화면에 반영합니다. 뒤 화면은 흐린 배경으로 덮고, 흐린 곳 · Esc · ✕ · [취소]는 고른 것을 버리고 닫습니다.
 * - `lookup`이 있으면 행을 고를 때마다 그 공고를 조회해 행 아래에 보여 주고(`lookup.render`), 조회를 마쳐야 확정할 수 있습니다.
 * - `disabledPrograms`(공고 키 → 표시 글자)의 공고는 흐리게 두고 고를 수 없습니다.
 * - `renderRowExtra`는 행 아래에 붙일 한 줄 안내입니다.
 * - `urlProgramKey`는 주소로 들어온 공고로, 목록에서 "지금 공고"로 표시합니다.
 */
export function ProgramPickerPanel<T = never>({
  title = '공고 고르기', subtitle, confirmLabel, current, initialFilters, urlProgramKey = '', disabledPrograms = {},
  renderRowExtra, lookup, onConfirm, onClose,
}: {
  title?: string
  subtitle: string
  confirmLabel: string
  current: SelectableSupportProgram | null
  initialFilters?: SupportProgramCatalogFilters
  urlProgramKey?: string
  disabledPrograms?: Readonly<Record<string, string>>
  renderRowExtra?: (program: SelectableSupportProgram) => ReactNode
  lookup?: ProgramPickLookup<T> & { render: (lookup: PickLookup<T>, retry: () => void) => ReactNode }
  onConfirm: (program: SelectableSupportProgram, result: T | undefined) => void
  onClose: () => void
}) {
  const vm = useProgramPickerViewModel<T>(current, { initialFilters, lookup })
  const dialogRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersId = useId()
  const radioName = useId()
  const sourceId = useId()
  const statusId = useId()
  const pickedDisabled = vm.picked !== null && disabledPrograms[programKey(vm.picked)] !== undefined
  const canConfirm = vm.canConfirm && !pickedDisabled

  // 처음 포커스는 [✕]가 아니라 지금 고른 탭에 둡니다. 바로 화살표·Tab으로 목록을 고를 수 있습니다.
  useEffect(() => {
    ;(dialogRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? dialogRef.current)?.focus()
  }, [])

  // 관심 공고함이 비어 전체 검색으로 저절로 넘어가면, 선택이 풀린 탭에 있던 포커스를 검색칸으로 옮깁니다.
  useEffect(() => {
    const active = document.activeElement
    if (vm.tab === 'search' && active instanceof HTMLElement && dialogRef.current?.contains(active)
      && active.getAttribute('role') === 'tab' && active.getAttribute('aria-selected') !== 'true') searchInputRef.current?.focus()
  }, [vm.tab])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // 드롭다운이 먼저 Esc를 처리했으면(목록 닫기) 패널은 그대로 둡니다.
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab' || dialogRef.current === null) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
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

  function confirm() {
    if (!canConfirm || !vm.picked) return
    onConfirm(vm.picked, vm.pickedLookup?.status === 'ready' ? vm.pickedLookup.result : undefined)
  }

  const renderRows = (programs: SelectableSupportProgram[], label: string) => <div className={p.list} role="radiogroup" aria-label={label}>
    {programs.map((program) => {
      const key = programKey(program)
      const checked = vm.picked !== null && programKey(vm.picked) === key
      const disabledLabel = disabledPrograms[key]
      const tags = [
        ...(key === urlProgramKey ? [<span className={`${b.badge} ${b.outline}`} key="url">지금 공고</span>] : []),
        ...(disabledLabel !== undefined ? [<span className={`${b.badge} ${b.neutral}`} key="disabled">{disabledLabel}</span>] : []),
      ]
      return <div className={p.row} key={key}>
        <label className={p.rowLabel}>
          <input className={p.radio} type="radio" name={radioName} checked={checked} disabled={disabledLabel !== undefined} onChange={() => vm.pick(program)} />
          <span className={p.rowText}>
            <ProgramBadges program={program} extra={tags.length > 0 ? <span className={p.rowTags}>{tags}</span> : null} />
            <span className={p.rowTitle}>{program.title}</span>
            <span className={p.rowMeta}>{[program.organization, program.applicationPeriod].filter(Boolean).join(' · ')}</span>
          </span>
        </label>
        {checked && lookup && vm.pickedLookup && lookup.render(vm.pickedLookup, vm.retryPick)}
        {renderRowExtra?.(program)}
      </div>
    })}
  </div>

  const { filters, draft, catalog, defaults } = vm
  const appliedRegions = splitFilterValues(filters.region)
  const appliedCategories = splitFilterValues(filters.category)
  // [필터 (n)]과 조건 칩은 마지막으로 검색에 적용한 조건을 보여 줍니다. 필터 칸에서 고르는 중인 값은 [검색]을 눌러야 반영됩니다.
  const filterCount = appliedRegions.length + appliedCategories.length + (filters.sourceCode ? 1 : 0)
    + (filters.status !== defaults.status ? 1 : 0)
  const conditions: { key: ConditionKey; value?: string; label: string }[] = [
    ...(filters.keyword.trim() ? [{ key: 'keyword' as const, label: `검색 · ${filters.keyword.trim()}` }] : []),
    ...appliedRegions.map((value) => ({ key: 'region' as const, value, label: `지역 · ${value}` })),
    ...appliedCategories.map((value) => ({ key: 'category' as const, value, label: `분야 · ${value}` })),
    ...(filters.sourceCode ? [{ key: 'sourceCode' as const, label: `출처 · ${catalogSourceLabels[filters.sourceCode]}` }] : []),
    ...(filters.status !== defaults.status ? [{ key: 'status' as const, label: `접수 · ${filterStatusLabels[filters.status]}` }] : []),
  ]
  const choices = (defaultValues: readonly string[], available: string[] = [], selected: string[]) =>
    toFilterChoiceOptions([...new Set([...defaultValues, ...available, ...selected].filter(Boolean))])
  const searching = vm.search.status === 'loading'
  // 300ms 안에 끝나면 행 자리를 그리지 않습니다. 다시 검색할 때는 그동안 기존 결과를 흐리게 두고, 더 걸리면 행 자리로 바꿉니다.
  const showSavedSkeleton = useDelayedFlag(vm.tab === 'saved' && vm.saved.phase !== 'ready' && vm.saved.phase !== 'failed')
  const showSearchSkeleton = useDelayedFlag(vm.tab === 'search' && (searching || vm.search.status === 'idle'))
  const staleResults = searching && vm.results.length > 0 && !showSearchSkeleton

  return <div className={p.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialogRef} className={p.panel} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={handleKeyDown}>
      <div className={p.header}>
        <div className={p.headerText}>
          <h2 className={p.title}>{title}</h2>
          <p className={p.sub}>{subtitle}</p>
        </div>
        <button type="button" className={p.close} aria-label="닫기" onClick={onClose}>✕</button>
      </div>

      <div className={p.body}>
        <div className={p.segment} role="tablist" aria-label="공고 목록">
          <button type="button" role="tab" className={p.segmentTab} aria-selected={vm.tab === 'saved'} onClick={() => vm.setTab('saved')}>관심 공고함</button>
          <button type="button" role="tab" className={p.segmentTab} aria-selected={vm.tab === 'search'} onClick={() => vm.setTab('search')}>전체 검색</button>
        </div>

        {vm.tab === 'saved' ? <div className={p.tabPanel} role="tabpanel" aria-label="관심 공고함">
          {vm.saved.phase === 'failed'
            ? <div className={p.state} role="alert">
              <p className="m-0">관심 공고를 불러오지 못했어요.</p>
              <button type="button" className={p.primarySm} onClick={vm.saved.retry}>다시 시도</button>
            </div>
            : vm.saved.phase !== 'ready'
              ? <RowSkeletons label="관심 공고를 불러오는 중입니다." show={showSavedSkeleton} />
              : vm.saved.programs.length === 0
                ? <div className={p.state}>
                  <p className="m-0">관심 공고함이 비어 있어요</p>
                  <button type="button" className={p.secondarySm} onClick={() => vm.setTab('search')}>전체 검색</button>
                </div>
                : renderRows(vm.saved.programs, '관심 공고 목록')}
        </div> : <div className={p.tabPanel} role="tabpanel" aria-label="전체 검색">
          <div className={p.searchRow}>
            <input ref={searchInputRef} className={p.searchInput} type="search" aria-label="공고명·기관명" placeholder="공고명, 기관명" maxLength={100}
              value={vm.keyword} onChange={(event) => vm.setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); vm.searchKeyword() }
              }} />
            <button type="button" className={p.secondary} disabled={searching} aria-busy={searching} onClick={vm.searchKeyword}>{searching && <ButtonSpinner />}검색</button>
          </div>
          <button type="button" className={p.filterToggle} aria-expanded={filtersOpen} aria-controls={filtersId} onClick={() => setFiltersOpen((open) => !open)}>
            필터 ({filterCount})<span aria-hidden="true">{filtersOpen ? '▴' : '▾'}</span>
          </button>
          {/* 네 필터 모두 칸 위 같은 자리에 같은 글자의 이름표를 두고, 칸에는 고른 값(없으면 "전체")을 보여 줍니다. */}
          {filtersOpen && <div className={p.filters} id={filtersId} role="group" aria-label="공고 검색 필터">
            <div className={p.filterField}>
              <span className={p.filterLabel} aria-hidden="true">지역</span>
              <MultiSelectField label="지역" className={p.multiInput} valueText={multiValueText(splitFilterValues(draft.region))}
                options={choices(regionNames, catalog?.regions, splitFilterValues(draft.region))}
                selected={splitFilterValues(draft.region)} onToggle={(value) => vm.toggleDraftValue('region', value)} onClearAll={() => vm.changeDraft({ region: '' })} />
            </div>
            <div className={p.filterField}>
              <span className={p.filterLabel} aria-hidden="true">지원 분야</span>
              <MultiSelectField label="지원 분야" className={p.multiInput} valueText={multiValueText(splitFilterValues(draft.category))}
                options={choices(supportProgramCategories, catalog?.categories, splitFilterValues(draft.category))}
                selected={splitFilterValues(draft.category)} onToggle={(value) => vm.toggleDraftValue('category', value)} onClearAll={() => vm.changeDraft({ category: '' })} />
            </div>
            <div className={p.filterField}>
              <label className={p.filterLabel} htmlFor={sourceId}>출처</label>
              <SelectField id={sourceId} label="출처" className={p.filterInput} value={draft.sourceCode}
                options={catalogSourceCodes.map((value) => ({ value, label: catalogSourceLabels[value] }))}
                onChange={(value) => vm.changeDraft({ sourceCode: value as SupportProgramCatalogFilters['sourceCode'] })} />
            </div>
            <div className={p.filterField}>
              <label className={p.filterLabel} htmlFor={statusId}>접수 상태</label>
              <SelectField id={statusId} label="접수 상태" className={p.filterInput} value={draft.status}
                options={Object.entries(filterStatusLabels).map(([value, label]) => ({ value, label }))}
                onChange={(value) => vm.changeDraft({ status: value as SupportProgramCatalogFilters['status'] })} />
            </div>
            <p className={p.filterHint}>조건을 고른 뒤 [검색]을 눌러 주세요.</p>
          </div>}
          {conditions.length > 0 && <div className={p.chips} aria-label="적용된 검색 조건">
            {conditions.map(({ key, value, label }) => <button type="button" className={p.chip} key={`${key}:${value ?? ''}`} aria-label={`${label} 조건 해제`}
              onClick={() => vm.removeCondition(key, value)}>{label}<span aria-hidden="true">×</span></button>)}
            {filterCount > 0 && <button type="button" className={p.resetLink} onClick={vm.resetFilters}>필터 초기화</button>}
          </div>}

          {vm.search.status === 'failed' && !vm.search.append
            ? <div className={p.state} role="alert">
              <p className="m-0">{vm.search.error.message}</p>
              <button type="button" className={p.primarySm} onClick={vm.retrySearch}>다시 시도</button>
            </div>
            : (searching || vm.search.status === 'idle') && !staleResults
              ? <RowSkeletons label="공고를 검색하고 있습니다." show={showSearchSkeleton} />
              : vm.results.length === 0
                ? <div className={p.state}><p className="m-0">조건에 맞는 공고가 없어요. 검색어나 필터를 바꿔 보세요.</p></div>
                : <div className={`flex min-w-0 flex-col gap-3 ${staleResults ? p.stale : ''}`} aria-busy={staleResults}>
                  {staleResults && <p className="sr-only" role="status">공고를 검색하고 있습니다.</p>}
                  {catalog && <p className={p.count}>검색 결과 {catalog.total.toLocaleString('ko-KR')}건</p>}
                  {renderRows(vm.results, '공고 검색 결과')}
                  {vm.search.status === 'failed' && <div className={p.state} role="alert">
                    <p className="m-0">{vm.search.error.message}</p>
                    <button type="button" className={p.primarySm} onClick={vm.retrySearch}>다시 시도</button>
                  </div>}
                  {catalog && catalog.page < catalog.totalPages && vm.search.status !== 'failed' && <button type="button" className={`${p.secondarySm} self-center`}
                    disabled={vm.search.status === 'more'} aria-busy={vm.search.status === 'more'} onClick={vm.loadMore}>{vm.search.status === 'more' && <ButtonSpinner />}{vm.search.status === 'more' ? '불러오는 중…' : '더 보기'}</button>}
                </div>}
        </div>}
      </div>

      <div className={p.footer}>
        <button type="button" className={p.ghost} onClick={onClose}>취소</button>
        <button type="button" className={p.primary} disabled={!canConfirm} onClick={confirm}>{confirmLabel}</button>
      </div>
    </div>
  </div>
}
