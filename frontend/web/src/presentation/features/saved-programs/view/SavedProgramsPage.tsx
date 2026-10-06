import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { applicationProgressStageLabels, ddayTone, programStatusLabels } from '@govbiz/shared/domain/labels'

import { applicationServiceFieldLabels, type ApplicationPreparationSummary, type ApplicationProgressStage } from '../../../../domain/entities/ApplicationPreparation'
import type { SupportProgramStatus } from '../../../../domain/entities/SupportProgram'
import { regionNames } from '../../../../domain/entities/Region'
import { supportProgramCategories } from '../../../../domain/entities/SupportProgramCategory'
import { assistantCover } from '../../../shared/assistant/assistantPlacement'
import { appPaths, readSavedProgramsViewMode, savedProgramsPath, supportProgramDetailPath, type SavedProgramsViewMode } from '../../../shared/routes/appPaths'
import { EmptyState } from '../../../shared/workspace/EmptyState'
import { ErrorState } from '../../../shared/workspace/ErrorState'
import { ddayToneClassNames } from '../../../shared/workspace/WorkspaceStates.styles'
import { workspacePageStyles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import {
  applicationPipelineStages,
  type ApplicationPipelineListUseCase,
  useApplicationPipelineViewModel,
} from '../viewmodel/useApplicationPipelineViewModel'
import {
  savedSupportProgramMessages,
  type SavedProgramsBrowseUseCase,
  type SavedProgramsSaveUseCases,
  useSavedProgramCalendarViewModel,
} from '../viewmodel/useSavedProgramCalendarViewModel'
import {
  daysUntilDeadline,
  savedProgramTargetOptions,
  type CalendarEvent,
  type CalendarProgram,
  type SavedProgramCalendarFilters,
} from '../viewmodel/savedProgramCalendar'
import { MultiSelectField } from '../../../shared/workspace/MultiSelectField'
import { SelectField } from '../../../shared/workspace/SelectField'
import { toFilterChoiceOptions } from '../../../shared/workspace/filterChoiceOptions'
import { narrowViewportQuery, useMediaQuery } from '../../../shared/workspace/useMediaQuery'
import { WorkspaceToast } from '../../../shared/workspace/WorkspaceToast'
import { workspaceToastActionClassName } from '../../../shared/workspace/WorkspaceToast.styles'
import { savedCalendarStyles as s } from './SavedProgramsPage.styles'

function Arrow({ direction }: { direction: 'left' | 'right' }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={direction === 'right' ? 'rotate-180' : undefined}>
    <path d="M15 6l-6 6 6 6" />
  </svg>
}

function BookmarkIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
}

type SavedProgramsPageProps = {
  initial?: { today: string; programs: readonly CalendarProgram[] }
  browseUseCase?: SavedProgramsBrowseUseCase
  preparationUseCase?: ApplicationPipelineListUseCase
  saveUseCases?: SavedProgramsSaveUseCases
}

/** 세그먼트 아이콘입니다(화면 통일안 kit: list · calendar · board). */
const viewTabIcons = {
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  pipeline: <><rect x="3.5" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="16.5" y="4" width="4" height="7" rx="1.5" /></>,
} as const

const viewTabs: { key: SavedProgramsViewMode; label: string }[] = [
  { key: 'list', label: '목록' },
  { key: 'calendar', label: '달력' },
  { key: 'pipeline', label: '진행 관리' },
]

/**
 * 관심 공고함입니다(화면 통일안 19~21). 머리글 왼쪽 세그먼트로 목록(기본) · 달력 · 진행 관리를 오가고, 필터 막대와 적용 조건 칩은
 * 세 보기가 함께 씁니다. 목록은 표(좁은 폭은 카드), 달력은 옆에 "다가오는 마감", 진행 관리는 5열 보드입니다.
 */
export function SavedProgramsPage({ initial, browseUseCase, preparationUseCase, saveUseCases }: SavedProgramsPageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const vm = useSavedProgramCalendarViewModel(initial, browseUseCase, readSavedProgramsViewMode(searchParams.get('view')), saveUseCases)
  // 목록의 "진행 단계" 열도 신청 준비 건을 읽어야 하므로 달력이 아닐 때 불러옵니다.
  const pipelineVm = useApplicationPipelineViewModel(vm.viewMode !== 'calendar', preparationUseCase)
  const preparationByProgram = new Map(pipelineVm.items.map(item => [`${item.sourceCode}:${item.sourceProgramId}`, item]))
  const preparationFor = (program: CalendarProgram) => preparationByProgram.get(`${program.sourceCode}:${program.sourceProgramId}`) ?? null
  // 진행 단계 바꾸기 옆 패널(모바일 아래 시트). 목록의 배지 버튼과 보드 카드의 [단계 바꾸기]가 같은 패널을 엽니다.
  const [stageTarget, setStageTarget] = useState<{ program: CalendarProgram | null; item: ApplicationPreparationSummary | null } | null>(null)
  // 보던 탭을 주소에 남겨 두면 공고 상세에서 돌아올 때 같은 탭이 열립니다.
  function chooseViewMode(view: SavedProgramsViewMode) {
    vm.setViewMode(view)
    const next = new URLSearchParams(searchParams)
    if (view === 'list') next.delete('view')
    else next.set('view', view)
    setSearchParams(next, { replace: true })
  }
  const monthLabel = `${vm.year}년 ${vm.month}월`
  const isEmpty = vm.phase === 'ready' && vm.totalProgramCount === 0
  // 적용 조건 칩은 값마다 하나씩이고, 칩의 ×는 그 값만 끕니다.
  const activeFilters: { key: keyof SavedProgramCalendarFilters; value: string; label: string }[] = [
    ...(vm.filters.keyword.trim() ? [{ key: 'keyword' as const, value: '', label: `검색 · ${vm.filters.keyword.trim()}` }] : []),
    ...vm.filters.region.map((value) => ({ key: 'region' as const, value, label: `지역 · ${value}` })),
    ...vm.filters.category.map((value) => ({ key: 'category' as const, value, label: `분야 · ${value}` })),
    ...vm.filters.target.map((value) => ({ key: 'target' as const, value, label: `대상 · ${value}` })),
  ]
  const lede = vm.viewMode === 'calendar'
    ? `담은 공고 ${vm.totalProgramCount}건 · ${vm.month}월 일정 ${vm.allProgramsInMonth}건`
    : vm.viewMode === 'pipeline'
      ? `담은 공고 ${vm.totalProgramCount}건 · 신청 준비 ${pipelineVm.items.length}건`
      : `담은 공고 ${vm.totalProgramCount}건 · 마감 임박순`

  return <>
    {/* 보기 전환 세그먼트(알약 묶음 + 아이콘)는 제목 옆 왼쪽에 둡니다. */}
    <WorkspacePageHeader title="관심 공고함" tabs={<div className={workspacePageStyles.segment} role="tablist" aria-label="관심 공고 보기 방식">
      {viewTabs.map((tab) => (
        <button key={tab.key} type="button" role="tab" aria-selected={vm.viewMode === tab.key} className={workspacePageStyles.segmentTab}
          onClick={() => chooseViewMode(tab.key)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{viewTabIcons[tab.key]}</svg>
          {tab.label}
        </button>
      ))}
    </div>} />

    <div className={workspacePageStyles.content}>
      <div className={workspacePageStyles.column}>
        <p className={s.lede}>{lede}</p>

        {/* 검색어·지역·분야·대상은 저장된 공고 안에서 바로 거릅니다. 지역·분야·대상은 드롭다운 안에서 여러 개를 함께 고릅니다. */}
        <form className={s.filterBar} aria-label="관심 공고 필터" onSubmit={event => event.preventDefault()}>
          <label className={s.search}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <input className={s.searchInput} type="search" name="keyword" aria-label="공고명 또는 기관명" placeholder="공고명, 기관명" maxLength={100}
              value={vm.filters.keyword} onChange={event => vm.changeFilter('keyword', event.target.value)} />
          </label>
          <MultiSelectField label="지역" options={toFilterChoiceOptions(regionNames)} selected={vm.filters.region}
            onToggle={value => vm.toggleFilterValue('region', value)} onClearAll={() => vm.clearFilter('region')} />
          <MultiSelectField label="분야" options={toFilterChoiceOptions(supportProgramCategories)} selected={vm.filters.category}
            onToggle={value => vm.toggleFilterValue('category', value)} onClearAll={() => vm.clearFilter('category')} />
          <MultiSelectField label="대상" options={toFilterChoiceOptions(savedProgramTargetOptions)} selected={vm.filters.target}
            onToggle={value => vm.toggleFilterValue('target', value)} onClearAll={() => vm.clearFilter('target')} />
        </form>
        {activeFilters.length > 0 ? (
          <div className={s.appliedFilters} aria-label="적용된 조건">
            {activeFilters.map(filter => <button type="button" className={s.filterChip} key={`${filter.key}:${filter.value}`}
              onClick={() => filter.key === 'keyword' ? vm.clearFilter('keyword') : vm.toggleFilterValue(filter.key, filter.value)}>
              {filter.label}<span aria-hidden="true">×</span><span className="sr-only"> 조건 해제</span>
            </button>)}
            <button type="button" className={s.resetFilters} onClick={vm.resetFilters}>필터 초기화</button>
          </div>
        ) : null}


        {vm.viewMode !== 'pipeline' ? (vm.phase === 'loading' && vm.totalProgramCount === 0 ? (
          <section className={`${s.emptyCard} gap-0 p-0`} aria-label="관심 공고 불러오는 중" aria-busy="true">
            {[0, 1, 2].map((index) => <div key={index} className={`${s.skeletonRow} w-full first:border-t-0`} aria-hidden="true">
              <span className="flex flex-1 flex-col gap-2"><span className={`${s.skeletonBar} w-2/5`} /><span className={`${s.skeletonBar} w-4/5`} /></span>
              <span className={`${s.skeletonBar} w-16`} />
            </div>)}
            <p className="sr-only" role="status">{savedSupportProgramMessages.loading}</p>
          </section>
        ) : vm.phase === 'failed' ? (
          <ErrorState message={savedSupportProgramMessages.failed} onRetry={vm.retry} />
        ) : isEmpty ? (
          <EmptyState icon={<BookmarkIcon />} title={savedSupportProgramMessages.emptyTitle} description={savedSupportProgramMessages.emptyDescription}
            action={{ label: '지원사업 찾기', to: appPaths.chat }} />
        ) : null) : null}

        {vm.viewMode === 'calendar' && !isEmpty && vm.phase !== 'failed' ? <>
          <div className={s.toolbar}>
            <div className={s.navigation}>
              <div className={s.arrowGroup} role="group" aria-label="월 이동">
                <button type="button" className={s.arrow} aria-label="이전 달" title="이전 달" disabled={!vm.canPreviousMonth} onClick={() => vm.moveMonth(-1)}><Arrow direction="left" /></button>
              </div>
              <div className="flex items-center gap-1">
                <SelectField label="달력 연도" className={s.monthSelect} value={String(vm.year)}
                  options={vm.years.map(year => ({ value: String(year), label: `${year}년` }))}
                  onChange={value => vm.chooseMonth(Number(value), vm.month)} />
                <SelectField label="달력 월" className={s.monthSelect} value={String(vm.month)}
                  options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}월` }))}
                  onChange={value => vm.chooseMonth(vm.year, Number(value))} />
              </div>
              <div className={s.arrowGroup}>
                <button type="button" className={s.arrow} aria-label="다음 달" title="다음 달" disabled={!vm.canNextMonth} onClick={() => vm.moveMonth(1)}><Arrow direction="right" /></button>
              </div>
              <button type="button" className={s.smallButton} onClick={vm.goToToday}>오늘</button>
              <span className={s.note} role="status">표시 공고 <strong className="text-ink">{vm.programsInMonth}건</strong> / 전체 {vm.allProgramsInMonth}건</span>
            </div>
            <div className={s.legend} aria-label="일정 범례">
              <span className={s.legendItem}><span className={`${s.legendSwatch} bg-brand-soft border border-brand-line`} aria-hidden="true" />접수 시작</span>
              <span className={s.legendItem}><span className={`${s.legendSwatch} bg-surface-muted border border-line-strong`} aria-hidden="true" />접수 마감</span>
              <span className={s.legendItem}><span className={`${s.legendSwatch} bg-warning-soft border border-warning-line`} aria-hidden="true" />3일 이내</span>
              <span className={s.legendItem}><span className={`${s.legendSwatch} bg-danger-soft border border-danger-line`} aria-hidden="true" />오늘 마감</span>
            </div>
          </div>

          <div className={s.calendarFrame}>
              <table className={s.calendarTable} aria-label={`${monthLabel} 접수 일정`}>
                <thead><tr>{['일', '월', '화', '수', '목', '금', '토'].map((day, index) =>
                  <th key={day} scope="col" className={`${s.weekday} ${index === 0 ? 'text-danger' : index === 6 ? 'text-info' : 'text-ink-muted'}`}>{day}</th>,
                )}</tr></thead>
                <tbody>{vm.weeks.map(week => <tr key={week[0]!.key}>{week.map((day, index) =>
                  <td key={day.key} className={`${s.cell} ${!day.inMonth ? 'bg-[#fafbfc]' : 'bg-white'}`}>
                    <time dateTime={day.key} aria-current={day.isToday ? 'date' : undefined} className={`${s.date} ${day.isToday ? 'bg-brand-primary font-bold text-white' : !day.inMonth ? 'text-[#9ca3af]' : index === 0 ? 'text-danger' : index === 6 ? 'text-info' : 'text-ink-muted'}`}>{day.day}</time>
                    <CalendarEvents date={day.key} today={vm.today} events={day.events} />
                  </td>,
                )}</tr>)}</tbody>
              </table>
          </div>
        </> : vm.viewMode === 'list' && !isEmpty && vm.phase !== 'failed' && !(vm.phase === 'loading' && vm.totalProgramCount === 0)
          ? <SavedProgramList programs={vm.listPrograms} page={vm.listPage} totalPages={vm.listTotalPages} onPageChange={vm.chooseListPage}
            daysUntilDeadline={vm.daysUntilDeadline} removingId={vm.removingId} onRemove={program => void vm.removeProgram(program)}
            filtersActive={vm.activeFilterCount > 0} onResetFilters={vm.resetFilters}
            preparationFor={preparationFor} onOpenStage={(program, item) => setStageTarget({ program, item })} />
          : vm.viewMode === 'pipeline'
            ? <ApplicationPipeline filteredSavedPrograms={vm.filteredPrograms} savedPrograms={vm.programs} today={vm.today}
              filtersActive={vm.activeFilterCount > 0} savedPhase={vm.phase} items={pipelineVm.items} phase={pipelineVm.phase} nextBeforeId={pipelineVm.nextBeforeId}
              loadingMore={pipelineVm.loadingMore} changingId={pipelineVm.changingId} updateError={pipelineVm.updateError}
              onRetry={pipelineVm.retry} onLoadMore={pipelineVm.loadMore} onOpenStage={(item) => setStageTarget({ program: null, item })} />
            : null}
      </div>
    </div>

    {/* 뺀 뒤 안내는 흰 토스트(오른쪽 위, 좁은 폭은 아래)로 뜨고 [되돌리기]로 다시 담습니다. */}
    <WorkspaceToast notice={vm.removalNotice} tone={vm.removalNotice?.program === null && vm.removalNotice?.text.includes('못했') ? 'danger' : 'success'} onClose={vm.dismissRemovalNotice}
      action={vm.removalNotice?.program ? <button type="button" className={workspaceToastActionClassName} disabled={vm.removingId !== null} onClick={() => void vm.undoRemoval()}>되돌리기</button> : null} />

    {stageTarget ? <ProgressStagePanel
      program={stageTarget.program} item={stageTarget.item} changing={pipelineVm.changingId !== null} error={pipelineVm.updateError}
      onClose={() => setStageTarget(null)}
      onSave={async (stage) => {
        if (!stageTarget.item) return
        const ok = await pipelineVm.changeProgress(stageTarget.item, stage)
        if (ok) setStageTarget(null)
      }} /> : null}
  </>
}

/** 마감 D-day 배지입니다. 색은 shared `ddayTone`(7일 이내 빨강 · 30일 이내 노랑 · 그 뒤 초록)입니다. */
function DeadlineBadge({ days }: { days: number | null }) {
  if (days === null) return null
  return <span className={`${s.dday} ${ddayToneClassNames[ddayTone(days)]}`}>{days === 0 ? '오늘 마감' : `D-${days}`}</span>
}

const statusTones: Record<SupportProgramStatus, string> = {
  OPEN: 'bg-brand-soft text-brand-primary', UPCOMING: 'bg-info-soft text-info', CLOSED: 'bg-surface-muted text-ink-muted', UNKNOWN: 'bg-warning-soft text-warning',
}

function StatusBadge({ status }: { status: SupportProgramStatus }) {
  return <span className={`${s.status} ${statusTones[status]}`}><span className={s.statusDot} aria-hidden="true" />{programStatusLabels[status]}</span>
}

/** 5열 보드입니다. 7단계 데이터는 그대로 두고 심사 중(서류 · 발표) · 결과(선정 · 미선정)로 묶어 카드 배지로 세부 단계를 보여 줍니다. */
const pipelineColumns: { key: string; label: string; stages: ApplicationProgressStage[] }[] = [
  { key: 'PREPARING', label: applicationProgressStageLabels.PREPARING, stages: ['PREPARING'] },
  { key: 'APPLIED', label: applicationProgressStageLabels.APPLIED, stages: ['APPLIED'] },
  { key: 'REVIEW', label: '심사 중', stages: ['DOCUMENT_REVIEW', 'PRESENTATION_REVIEW'] },
  { key: 'RESULT', label: '결과', stages: ['SELECTED', 'REJECTED'] },
]

function ApplicationPipeline({ filteredSavedPrograms, savedPrograms, today, filtersActive, savedPhase, items, phase, nextBeforeId, loadingMore, changingId, updateError, onRetry, onLoadMore, onOpenStage }: {
  filteredSavedPrograms: readonly CalendarProgram[]
  savedPrograms: readonly CalendarProgram[]
  today: string
  filtersActive: boolean
  savedPhase: 'loading' | 'ready' | 'failed'
  items: ApplicationPreparationSummary[]
  phase: 'idle' | 'loading' | 'ready' | 'failed'
  nextBeforeId: number | null
  loadingMore: boolean
  changingId: number | null
  updateError: string | null
  onRetry: () => void
  onLoadMore: () => void
  onOpenStage: (item: ApplicationPreparationSummary) => void
}) {
  const [openedColumn, setOpenedColumn] = useState<string | null>(null)
  const [dialogPage, setDialogPage] = useState(1)
  const savedProgramKeys = new Set(savedPrograms.map(program => `${program.sourceCode}:${program.sourceProgramId}`))
  // 신청 준비를 시작하면 서버가 관심 공고함에도 담아 두므로, 여기 남아 있지 않다는 것은 사용자가 관심 공고에서
  // 뺐다는 뜻입니다. 그래서 목록·달력과 마찬가지로 진행 관리에서도 보여 주지 않습니다.
  const keptItems = items.filter(item => savedProgramKeys.has(`${item.sourceCode}:${item.sourceProgramId}`))
  const preparedProgramKeys = new Set(keptItems.map(item => `${item.sourceCode}:${item.sourceProgramId}`))
  const filteredProgramKeys = new Set(filteredSavedPrograms.map(program => `${program.sourceCode}:${program.sourceProgramId}`))
  const visiblePreparationItems = filtersActive
    ? keptItems.filter(item => filteredProgramKeys.has(`${item.sourceCode}:${item.sourceProgramId}`))
    : keptItems
  const interestPrograms = filteredSavedPrograms.filter(program => !preparedProgramKeys.has(`${program.sourceCode}:${program.sourceProgramId}`))
  const visibleInterestPrograms = interestPrograms.slice(0, interestPipelinePreviewSize)
  const openedColumnSpec = pipelineColumns.find(column => column.key === openedColumn)
  const openedStageItems = openedColumnSpec
    ? visiblePreparationItems.filter(item => openedColumnSpec.stages.includes(item.progressStage))
    : []
  const openedTotal = openedColumn === 'INTEREST' ? interestPrograms.length : openedStageItems.length
  const currentDialogPage = safePage(dialogPage, openedTotal, pipelineDialogPageSize)

  function openColumn(key: string) {
    setDialogPage(1)
    setOpenedColumn(key)
  }

  return <div role="tabpanel" aria-label="지원사업 진행 관리" className={s.pipelineSection}>
    {phase === 'failed' ? <ErrorState message="진행 중인 지원사업을 불러오지 못했어요. 잠시 후 다시 시도해 주세요." onRetry={onRetry} /> : null}
    {updateError ? <div className={s.pipelineError} role="alert">
      <span>{updateError}</span>
      <button type="button" className={workspacePageStyles.quietLink} onClick={onRetry}>최신 상태 불러오기</button>
    </div> : null}

    <div className={s.pipelineBoard} aria-label="지원사업 파이프라인" aria-busy={phase === 'loading'}>
      <section className={s.pipelineColumn} aria-labelledby="pipeline-INTEREST">
        <header className={s.pipelineColumnHeader}>
          <h2 id="pipeline-INTEREST" className={s.pipelineColumnTitle}>관심</h2>
          <span className={s.pipelineCount} aria-label={`관심 ${interestPrograms.length}건`}>{interestPrograms.length}</span>
        </header>
        <div className={s.pipelineCards}>
          {visibleInterestPrograms.map(program => <InterestPipelineCard key={program.id} program={program} today={today} />)}
          {savedPhase !== 'loading' && interestPrograms.length === 0 ? <p className={s.pipelineEmpty}>지원 준비 전인 관심 공고가 없어요.</p> : null}
          <PipelineColumnMore total={interestPrograms.length} previewSize={interestPipelinePreviewSize} onClick={() => openColumn('INTEREST')} />
        </div>
      </section>
      {pipelineColumns.map((column) => {
        const stageItems = visiblePreparationItems.filter(item => column.stages.includes(item.progressStage))
        const visibleStageItems = stageItems.slice(0, applicationPipelinePreviewSize)
        return <section key={column.key} className={s.pipelineColumn} aria-labelledby={`pipeline-${column.key}`}>
          <header className={s.pipelineColumnHeader}>
            <h2 id={`pipeline-${column.key}`} className={s.pipelineColumnTitle}>{column.label}</h2>
            <span className={s.pipelineCount} aria-label={`${column.label} ${stageItems.length}건`}>{stageItems.length}</span>
          </header>
          <div className={s.pipelineCards}>
            {phase === 'loading' && items.length === 0 ? [0, 1].map(index => <div key={index} className={s.pipelineCard} aria-hidden="true">
              <span className={`${s.skeletonBar} w-1/3`} /><span className={`${s.skeletonBar} w-full`} /><span className={`${s.skeletonBar} w-2/3`} />
            </div>) : null}
            {visibleStageItems.map(item => <PipelineCard key={item.id} item={item} showStageBadge={column.stages.length > 1} changing={changingId === item.id} onOpenStage={onOpenStage} />)}
            {phase === 'ready' && stageItems.length === 0 ? <p className={s.pipelineEmpty}>해당 단계의 사업이 없어요.</p> : null}
            <PipelineColumnMore total={stageItems.length} previewSize={applicationPipelinePreviewSize} onClick={() => openColumn(column.key)} />
          </div>
        </section>
      })}
    </div>

    {openedColumn !== null ? <div className={s.dialogBackdrop} role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) setOpenedColumn(null)
    }}>
      <section role="dialog" aria-modal="true" aria-labelledby="pipeline-dialog-title" className={s.pipelineDialog}>
        <div className={s.dialogHeader}>
          <div><p className={workspacePageStyles.sectionEyebrow}>진행 단계</p><h2 id="pipeline-dialog-title" className="mt-1 mb-0 text-xl font-bold">
            {openedColumn === 'INTEREST' ? '관심' : openedColumnSpec?.label} · {openedTotal}건
          </h2></div>
          <button type="button" className={s.dialogClose} aria-label="진행 단계 공고 닫기" onClick={() => setOpenedColumn(null)}>×</button>
        </div>
        <div className={s.pipelineDialogCards}>
          {openedColumn === 'INTEREST'
            ? pageItems(interestPrograms, currentDialogPage, pipelineDialogPageSize)
              .map(program => <InterestPipelineCard key={program.id} program={program} today={today} />)
            : pageItems(openedStageItems, currentDialogPage, pipelineDialogPageSize)
              .map(item => <PipelineCard key={item.id} item={item} showStageBadge={(openedColumnSpec?.stages.length ?? 0) > 1} changing={changingId === item.id} onOpenStage={onOpenStage} />)}
        </div>
        <div className={s.dialogPagination}>
          <Pagination label={`${openedColumn === 'INTEREST' ? '관심' : openedColumnSpec?.label} 단계 페이지`} page={currentDialogPage}
            totalPages={pageCount(openedTotal, pipelineDialogPageSize)} onPageChange={setDialogPage} />
        </div>
      </section>
    </div> : null}

    {nextBeforeId !== null && phase !== 'failed' ? <div className={s.pipelineMore}>
      <button type="button" className={workspacePageStyles.secondaryButton} disabled={loadingMore} onClick={onLoadMore}>
        {loadingMore ? '불러오는 중…' : '더 보기'}
      </button>
      <span className={s.note}>신청 준비 {keptItems.length}건 표시</span>
    </div> : null}
  </div>
}

const interestPipelinePreviewSize = 3
const applicationPipelinePreviewSize = 2
const pipelineDialogPageSize = 4

function PipelineColumnMore({ total, previewSize, onClick }: { total: number; previewSize: number; onClick: () => void }) {
  if (total <= previewSize) return null
  return <button type="button" className={s.pipelineColumnMore} onClick={onClick}>
    +{total - previewSize}건 더보기
  </button>
}

function InterestPipelineCard({ program, today }: { program: CalendarProgram; today: string }) {
  const detailPath = getDetailPath(program)
  const startPath = program.sourceCode && program.sourceProgramId
    ? `${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId })}`
    : null
  return <article className={s.pipelineCard}>
    <div className={s.pipelineCardTop}>
      <StatusBadge status={program.status} />
      <DeadlineBadge days={daysUntilDeadline(program, today)} />
    </div>
    <h3 className={s.pipelineCardTitle} title={program.title}>
      {detailPath
        ? <Link className={s.cardTitleLink} to={detailPath} state={{ searchReturnTo: savedProgramsPath('pipeline') }}>{program.title}</Link>
        : program.title}
    </h3>
    <p className={s.pipelineMeta}>{program.organization} · {program.region}</p>
    <div className={s.pipelineFoot}>
      <span className={s.pipelineFootDate}>{program.savedAt ? `${formatShortDate(program.savedAt)} 담음` : ''}</span>
      {startPath ? <Link className={`${workspacePageStyles.secondaryButton} ${s.pipelineCardAction}`} to={startPath}>신청 문서 작성</Link> : null}
    </div>
  </article>
}

function PipelineCard({ item, showStageBadge, changing, onOpenStage }: {
  item: ApplicationPreparationSummary
  showStageBadge: boolean
  changing: boolean
  onOpenStage: (item: ApplicationPreparationSummary) => void
}) {
  return <article className={s.pipelineCard}>
    <div className={s.pipelineCardTop}>
      {showStageBadge ? <span className={workspaceTagClassName(item.progressStage === 'SELECTED' ? 'ok' : item.progressStage === 'REJECTED' ? 'muted' : 'info')}>{applicationProgressStageLabels[item.progressStage]}</span> : null}
      <span className={workspaceTagClassName('muted')}>{applicationServiceFieldLabels[item.serviceField]}</span>
    </div>
    <h3 className={s.pipelineCardTitle} title={item.programTitle}>
      <Link className={s.cardTitleLink} to={supportProgramDetailPath({ sourceCode: item.sourceCode, sourceProgramId: item.sourceProgramId }, true)} state={{ searchReturnTo: savedProgramsPath('pipeline'), fromPipeline: true }}>{item.programTitle}</Link>
    </h3>
    <p className={s.pipelineMeta}>{item.formTitle} · 입력 {item.inputRevision}차</p>
    <div className={s.pipelineFoot}>
      <span className={s.pipelineFootDate}>{formatPipelineDate(item.updatedAt)} 수정</span>
      <button type="button" className={`${workspacePageStyles.secondaryButton} ${s.pipelineCardAction}`} disabled={changing}
        aria-label={`${item.programTitle} 단계 바꾸기`} onClick={() => onOpenStage(item)}>{changing ? '저장 중…' : '단계 바꾸기'}</button>
    </div>
  </article>
}

function formatPipelineDate(value: string): string {
  const date = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(5).replace('-', '.') : value
}

/** "2026-09-23" 또는 "2026-09-23T10:00:00" → "09.23" */
function formatShortDate(value: string | null): string {
  if (!value) return '기간 없음'
  const [, month = '', day = ''] = value.slice(0, 10).split('-')
  return `${month}.${day}`
}

const maximumVisibleEvents = 2
const calendarDialogPageSize = 4

function CalendarEvents({ date, today, events }: { date: string; today: string; events: CalendarEvent[] }) {
  const [showAll, setShowAll] = useState(false)
  const [dialogPage, setDialogPage] = useState(1)
  if (events.length === 0) return null
  const visible = events.slice(0, maximumVisibleEvents)
  const hiddenCount = events.length - visible.length
  const totalDialogPages = pageCount(events.length, calendarDialogPageSize)
  const currentDialogPage = safePage(dialogPage, events.length, calendarDialogPageSize)
  const dialogEvents = pageItems(events, currentDialogPage, calendarDialogPageSize)
  return <>
    <ul className={s.events} aria-label={`${date} 접수 일정 ${events.length}건`}>
      {visible.map(event => <CalendarEventRow key={`${event.program.id}:${event.type}`} event={event} date={date} today={today} />)}
      {hiddenCount > 0 ? <li><button type="button" className={s.overflowCount} onClick={() => { setDialogPage(1); setShowAll(true) }}>+{hiddenCount}건 더보기</button></li> : null}
    </ul>
    {showAll ? <div className={s.dialogBackdrop} role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) setShowAll(false)
    }}>
      <section role="dialog" aria-modal="true" aria-labelledby={`calendar-events-${date}`} className={s.dialog}>
        <div className={s.dialogHeader}>
          <div><p className={workspacePageStyles.sectionEyebrow}>접수 일정</p><h2 id={`calendar-events-${date}`} className="mt-1 mb-0 text-xl font-bold">{date} · {events.length}건</h2></div>
          <button type="button" className={s.dialogClose} aria-label="전체 공고 닫기" onClick={() => setShowAll(false)}>×</button>
        </div>
        <ul className={s.dialogEvents} aria-label={`${date} 전체 접수 일정`}>
          {dialogEvents.map(event => <CalendarEventRow key={`${event.program.id}:${event.type}`} event={event} date={date} today={today} expanded />)}
        </ul>
        <div className={s.dialogPagination}>
          <Pagination label={`${date} 접수 일정 페이지`} page={currentDialogPage} totalPages={totalDialogPages} onPageChange={setDialogPage} />
        </div>
      </section>
    </div> : null}
  </>
}

/** 칸 안 막대의 글자와 색입니다. 접수 시작 brand · 접수 마감 회색 · 3일 이내 warning · 오늘 마감 danger. 색만으로 구분하지 않도록 글자를 붙입니다. */
function calendarEventLabel(event: CalendarEvent, date: string, today: string): { label: string; tone: string } {
  if (event.type === 'START') return { label: '접수 시작', tone: s.eventStart }
  if (date === today) return { label: '오늘 마감', tone: s.eventToday }
  const days = daysUntilDeadline(event.program, today)
  if (days !== null && days <= 3) return { label: `D-${days} 마감`, tone: s.eventSoon }
  return { label: event.type === 'SAME_DAY' ? '당일 접수' : '접수 마감', tone: s.eventEnd }
}

function CalendarEventRow({ event, date, today, expanded = false }: { event: CalendarEvent; date: string; today: string; expanded?: boolean }) {
  const detailPath = getDetailPath(event.program)
  const { label, tone } = calendarEventLabel(event, date, today)
  return <li className={expanded ? s.dialogEvent : `${s.event} ${tone}`} title={event.program.title}>
    <span className={expanded ? `${s.dday} ${tone}` : s.eventBadge}>{label}</span>
    <span className="min-w-0 flex-1">
      {detailPath ? <Link className={expanded ? 'block font-semibold text-ink hover:text-brand-primary' : s.eventTitle}
        to={detailPath} state={{ searchReturnTo: savedProgramsPath('calendar') }}>{event.program.title}</Link>
        : <span className={expanded ? 'block font-semibold text-ink' : s.eventTitle}>{event.program.title}</span>}
      {expanded ? <span className="mt-1 block text-xs text-ink-muted">{event.program.organization} · {event.program.region} · {event.program.category}</span> : null}
    </span>
  </li>
}

/** 목록 보기입니다. 넓은 화면은 표(공고 · 마감 · 담은 날 · 동작), 좁은 화면은 카드입니다. 행마다 [관심 공고에서 빼기][상세 보기]. */
function SavedProgramList({ programs, page, totalPages, onPageChange, daysUntilDeadline: dayCount, removingId, onRemove, filtersActive, onResetFilters, preparationFor, onOpenStage }: {
  programs: CalendarProgram[]; page: number; totalPages: number; onPageChange: (page: number) => void
  daysUntilDeadline: (program: CalendarProgram) => number | null
  removingId: string | null
  onRemove: (program: CalendarProgram) => void
  filtersActive: boolean
  onResetFilters: () => void
  preparationFor: (program: CalendarProgram) => ApplicationPreparationSummary | null
  onOpenStage: (program: CalendarProgram, item: ApplicationPreparationSummary | null) => void
}) {
  const pageStart = Math.max(1, Math.min(page - 2, totalPages - 4))
  const pages = Array.from({ length: Math.min(5, totalPages) }, (_, index) => pageStart + index)
  // 넓은 화면은 표, 좁은 화면은 카드 한 벌만 그립니다(둘 다 그리면 링크·버튼이 두 번 읽힙니다).
  const isNarrow = useMediaQuery(narrowViewportQuery)
  if (!programs.length) {
    return <div role="tabpanel" aria-label="관심 공고 목록">
      <EmptyState title="조건에 맞는 관심 공고가 없어요"
        action={filtersActive ? { label: '필터 초기화', onClick: onResetFilters } : undefined} />
    </div>
  }
  // 행의 동작은 [관심 공고에서 빼기] 하나입니다. 상세는 제목을 누르면 열립니다.
  const rowActions = (program: CalendarProgram) => {
    return <>
      <button type="button" className={s.iconButton} aria-label="관심 공고에서 빼기" title="관심 공고에서 빼기"
        disabled={removingId !== null || !program.sourceCode} onClick={() => onRemove(program)}><BookmarkIcon /></button>
    </>
  }
  return <div role="tabpanel" aria-label="관심 공고 목록" className="flex flex-col gap-4">
    {!isNarrow ? <table className={s.table}>
      <thead><tr>
        <th className={s.th} scope="col">공고</th>
        <th className={s.th} scope="col">마감</th>
        <th className={s.th} scope="col">진행 단계</th>
        <th className={s.th} scope="col">담은 날</th>
        <th className={s.th} scope="col"><span className="sr-only">동작</span></th>
      </tr></thead>
      <tbody>{programs.map(program => {
        const detailPath = getDetailPath(program)
        const days = dayCount(program)
        return <tr key={program.id}>
          <td className={`${s.td} ${s.tdTitle}`}>
            <article aria-label={program.title}>
              <div className={s.rowMeta}><StatusBadge status={program.status} /></div>
              {detailPath
                ? <Link to={detailPath} state={{ searchReturnTo: savedProgramsPath('list') }} className={s.rowTitle}>{program.title}</Link>
                : <span className={s.rowTitle}>{program.title}</span>}
              <span className={s.rowSub}>{program.organization} · {program.region}</span>
            </article>
          </td>
          <td className={`${s.td} ${s.rowDeadline}`}>
            {program.endDate === null ? <span className="text-ink-muted">기간 없음</span> : <span className="inline-flex items-center gap-1.5"><DeadlineBadge days={days} />{days === null ? <span>{formatShortDate(program.endDate)}</span> : <span className="text-[0.72rem]">{formatShortDate(program.endDate)}</span>}</span>}
          </td>
          <td className={s.td}><StageBadgeButton program={program} item={preparationFor(program)} onOpen={onOpenStage} /></td>
          <td className={`${s.td} ${s.rowDate}`}>{program.savedAt ? `${formatShortDate(program.savedAt)} 담음` : '—'}</td>
          <td className={s.td}><div className={s.rowActions}>{rowActions(program)}</div></td>
        </tr>
      })}</tbody>
    </table> : <div className={s.cardList}>
      {programs.map(program => {
        const detailPath = getDetailPath(program)
        return <article key={program.id} className={s.card} aria-label={program.title}>
          <div className={s.rowMeta}><StatusBadge status={program.status} /><DeadlineBadge days={dayCount(program)} /></div>
          {detailPath
            ? <Link to={detailPath} state={{ searchReturnTo: savedProgramsPath('list') }} className={s.rowTitle}>{program.title}</Link>
            : <span className={s.rowTitle}>{program.title}</span>}
          <span className={s.rowSub}>{program.organization} · {program.region}{program.savedAt ? ` · ${formatShortDate(program.savedAt)} 담음` : ''}</span>
          <div className={s.rowMeta}><StageBadgeButton program={program} item={preparationFor(program)} onOpen={onOpenStage} /></div>
          <div className={s.cardFoot}>
            {program.sourceUrl ? <a className={s.cardSourceLink} href={program.sourceUrl} target="_blank" rel="noreferrer">
              원문 보기
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></svg>
            </a> : <span className="mr-auto" />}
            {rowActions(program)}
          </div>
        </article>
      })}
    </div>}
    {totalPages > 1 ? <nav className={s.pagination} aria-label="관심 공고 페이지">
      <button type="button" className={`${s.pageButton} ${s.inactivePageButton}`} disabled={page === 1} onClick={() => onPageChange(page - 1)}>이전</button>
      {pages.map(value => <button type="button" key={value} aria-label={`${value}페이지`} aria-current={value === page ? 'page' : undefined}
        className={`${s.pageButton} ${value === page ? s.activePageButton : s.inactivePageButton}`} onClick={() => onPageChange(value)}>{value}</button>)}
      <button type="button" className={`${s.pageButton} ${s.inactivePageButton}`} disabled={page === totalPages} onClick={() => onPageChange(page + 1)}>다음</button>
    </nav> : null}
  </div>
}

/** 진행 단계 배지 버튼(▾)입니다. 신청 준비가 없는 공고는 "관심"입니다. 누르면 진행 단계 바꾸기 패널이 열립니다. */
function StageBadgeButton({ program, item, onOpen }: {
  program: CalendarProgram
  item: ApplicationPreparationSummary | null
  onOpen: (program: CalendarProgram, item: ApplicationPreparationSummary | null) => void
}) {
  const label = item ? applicationProgressStageLabels[item.progressStage] : '관심'
  const tone = !item ? 'bg-surface-muted text-ink-muted' : item.progressStage === 'SELECTED' ? 'bg-brand-soft text-brand-primary' : item.progressStage === 'REJECTED' ? 'bg-surface-muted text-ink-muted' : 'bg-info-soft text-info'
  return <button type="button" className={`${s.stageButton} ${tone}`} aria-label={`${program.title} 진행 단계: ${label}`} onClick={() => onOpen(program, item)}>
    {label}
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
  </button>
}

/**
 * 진행 단계 바꾸기 옆 패널(좁은 폭은 아래 시트)입니다. 라디오로 단계를 고르고 [저장]해야 바뀝니다.
 * 신청 준비가 없는 관심 공고는 단계를 둘 곳이 없어 안내와 [신청 문서 작성]만 보여 줍니다.
 */
function ProgressStagePanel({ program, item, changing, error, onClose, onSave }: {
  program: CalendarProgram | null
  item: ApplicationPreparationSummary | null
  changing: boolean
  error: string | null
  onClose: () => void
  onSave: (stage: ApplicationProgressStage) => Promise<void>
}) {
  const [selected, setSelected] = useState<ApplicationProgressStage>(item?.progressStage ?? 'PREPARING')
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => { panelRef.current?.focus() }, [])
  const title = item?.programTitle ?? program?.title ?? ''
  const startPath = program?.sourceCode && program.sourceProgramId
    ? `${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId })}`
    : null
  return <>
    <button type="button" className={s.panelScrim} aria-label="닫기" onClick={onClose} />
    <section ref={panelRef} className={s.panel} role="dialog" aria-label="진행 단계 바꾸기" tabIndex={-1} {...assistantCover.always}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <header className={s.panelHeader}>
        <span className={s.panelGrab} aria-hidden="true" />
        <div className={s.panelHeading}>
          <h2 className={s.panelTitle}>진행 단계 바꾸기</h2>
          <p className={s.panelSubtitle}>{title}</p>
        </div>
        <button type="button" className={s.panelClose} onClick={onClose} aria-label="진행 단계 패널 닫기" title="닫기">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div className={s.panelBody}>
        {error ? <p className={s.pipelineError} role="alert">{error}</p> : null}
        {item ? <fieldset className={s.stageList}>
          <legend className="sr-only">진행 단계</legend>
          {applicationPipelineStages.map(stage => <label key={stage.key} className={s.stageOption}>
            <input type="radio" name="progress-stage" value={stage.key} checked={selected === stage.key} disabled={changing} onChange={() => setSelected(stage.key)} />
            <span className={s.stageOptionText}><span className={s.stageOptionLabel}>{stage.label}</span><span className={s.stageOptionHint}>{stage.description}</span></span>
          </label>)}
        </fieldset> : <div className={s.stageNote} role="note">
          <span className="font-bold">아직 신청 준비를 시작하지 않은 공고예요</span>
          <span>신청 문서를 만들면 {applicationProgressStageLabels.PREPARING} · {applicationProgressStageLabels.APPLIED} · 심사 중 · 결과 단계를 이 패널에서 관리할 수 있어요.</span>
        </div>}
      </div>
      <footer className={s.panelFooter}>
        <button type="button" className={s.panelGhostButton} onClick={onClose}>취소</button>
        {item
          ? <button type="button" className={s.panelPrimaryButton} disabled={changing || selected === item.progressStage} onClick={() => void onSave(selected)}>{changing ? '저장 중…' : '저장'}</button>
          : startPath ? <Link className={s.panelPrimaryButton} to={startPath}>신청 문서 작성</Link> : null}
      </footer>
    </section>
  </>
}

function Pagination({ label, page, totalPages, onPageChange, compact = false }: {
  label: string
  page: number
  totalPages: number
  onPageChange: (page: number) => void
  compact?: boolean
}) {
  const maximumPageButtons = compact ? 3 : 5
  const pageStart = Math.max(1, Math.min(page - Math.floor(maximumPageButtons / 2), totalPages - maximumPageButtons + 1))
  const pages = Array.from({ length: Math.min(maximumPageButtons, totalPages) }, (_, index) => pageStart + index)
  const buttonClass = compact ? s.compactPageButton : s.pageButton
  return <nav className={compact ? s.compactPagination : s.pagination} aria-label={label}>
    <button type="button" aria-label="이전 페이지" className={`${buttonClass} ${s.inactivePageButton}`} disabled={page === 1} onClick={() => onPageChange(page - 1)}>‹</button>
    {pages.map(value => <button type="button" key={value} aria-label={`${value}페이지`} aria-current={value === page ? 'page' : undefined}
      className={`${buttonClass} ${value === page ? s.activePageButton : s.inactivePageButton}`} onClick={() => onPageChange(value)}>{value}</button>)}
    <button type="button" aria-label="다음 페이지" className={`${buttonClass} ${s.inactivePageButton}`} disabled={page === totalPages} onClick={() => onPageChange(page + 1)}>›</button>
  </nav>
}

function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

function safePage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, page), pageCount(total, pageSize))
}

function pageItems<Item>(items: readonly Item[], page: number, pageSize: number): Item[] {
  const start = (page - 1) * pageSize
  return items.slice(start, start + pageSize)
}

function getDetailPath(program: CalendarProgram): string | null {
  if (!program.sourceCode || !program.sourceProgramId) return null
  return supportProgramDetailPath({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId }, true)
}
