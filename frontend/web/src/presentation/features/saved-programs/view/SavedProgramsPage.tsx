import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { applicationServiceFieldLabels, type ApplicationPreparationSummary, type ApplicationProgressStage } from '../../../../domain/entities/ApplicationPreparation'
import type { SupportProgramStatus } from '../../../../domain/entities/SupportProgram'
import { regionNames } from '../../../../domain/entities/Region'
import { supportProgramCategories } from '../../../../domain/entities/SupportProgramCategory'
import { appPaths, readSavedProgramsViewMode, savedProgramsPath, supportProgramDetailPath, type SavedProgramsViewMode } from '../../../shared/routes/appPaths'
import { workspaceChipClassName, workspacePageStyles, workspaceTagClassName, type WorkspaceTagTone } from '../../../shared/workspace/WorkspacePage.styles'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { savedSupportProgramMessages } from '../../saved-support-program/viewmodel/useSavedSupportProgramsViewModel'
import {
  applicationPipelineStages,
  type ApplicationPipelineListUseCase,
  useApplicationPipelineViewModel,
} from '../viewmodel/useApplicationPipelineViewModel'
import {
  type SavedProgramsBrowseUseCase,
  useSavedProgramCalendarViewModel,
} from '../viewmodel/useSavedProgramCalendarViewModel'
import {
  savedProgramTargetOptions,
  type CalendarEvent,
  type CalendarEventType,
  type CalendarProgram,
  type SavedProgramCalendarFilters,
} from '../viewmodel/savedProgramCalendar'
import { SelectField } from '../../../shared/workspace/SelectField'
import { savedCalendarStyles as s } from './SavedProgramsPage.styles'

function Arrow({ direction }: { direction: 'left' | 'right' }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={direction === 'right' ? 'rotate-180' : undefined}>
    <path d="M15 6l-6 6 6 6" />
  </svg>
}

type SavedProgramsPageProps = {
  initial?: { today: string; programs: readonly CalendarProgram[] }
  browseUseCase?: SavedProgramsBrowseUseCase
  preparationUseCase?: ApplicationPipelineListUseCase
}

/**
 * 로그인 회원이 실제로 저장한 지원사업을 달력·목록으로, 실제 신청 준비 건을 진행 관리로 보여 줍니다.
 * 머리글·탭·검색 칸·필터·카드는 파트너 관리와 같은 공용 모양을 쓰고, 달력만 이 화면 고유입니다.
 */
export function SavedProgramsPage({ initial, browseUseCase, preparationUseCase }: SavedProgramsPageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const vm = useSavedProgramCalendarViewModel(initial, browseUseCase, readSavedProgramsViewMode(searchParams.get('view')))
  const pipelineVm = useApplicationPipelineViewModel(vm.viewMode === 'pipeline', preparationUseCase)
  // 보던 탭을 주소에 남겨 두면 공고 상세에서 돌아올 때 같은 탭이 열립니다.
  function chooseViewMode(view: SavedProgramsViewMode) {
    vm.setViewMode(view)
    const next = new URLSearchParams(searchParams)
    if (view === 'calendar') next.delete('view')
    else next.set('view', view)
    setSearchParams(next, { replace: true })
  }
  const monthLabel = `${vm.year}년 ${vm.month}월`
  const isEmpty = vm.phase === 'ready' && vm.totalProgramCount === 0
  const activeFilters: { key: keyof SavedProgramCalendarFilters; label: string }[] = [
    ...(vm.filters.keyword.trim() ? [{ key: 'keyword' as const, label: `검색 · ${vm.filters.keyword.trim()}` }] : []),
    ...(vm.filters.region ? [{ key: 'region' as const, label: `지역 · ${vm.filters.region}` }] : []),
    ...(vm.filters.category ? [{ key: 'category' as const, label: `분야 · ${vm.filters.category}` }] : []),
    ...(vm.filters.target ? [{ key: 'target' as const, label: `대상 · ${vm.filters.target}` }] : []),
  ]

  return <>
    <WorkspacePageHeader title="관심 공고함" tabs={<div className={s.viewTabs} role="tablist" aria-label="관심 공고 보기 방식">
      <button type="button" role="tab" aria-selected={vm.viewMode === 'calendar'} className={workspaceChipClassName(vm.viewMode === 'calendar')}
        onClick={() => chooseViewMode('calendar')}>달력 보기</button>
      <button type="button" role="tab" aria-selected={vm.viewMode === 'list'} className={workspaceChipClassName(vm.viewMode === 'list')}
        onClick={() => chooseViewMode('list')}>목록 보기</button>
      <button type="button" role="tab" aria-selected={vm.viewMode === 'pipeline'} className={workspaceChipClassName(vm.viewMode === 'pipeline')}
        onClick={() => chooseViewMode('pipeline')}>진행 관리</button>
    </div>} />

    <div className={workspacePageStyles.content}>
      <div className={workspacePageStyles.column}>
        {/* 검색어·지역·분야·대상은 저장된 공고 안에서 바로 거릅니다. 서버 요청이 없어 조회 버튼을 두지 않습니다. */}
        <form className={s.filterPanel} aria-label="관심 공고 필터" onSubmit={event => event.preventDefault()}>
          <div className={s.filterControls}>
            <label className={s.searchField}>
              <span>검색어</span>
              <span className={s.search}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                </svg>
                <input className={s.searchInput} type="search" name="keyword" aria-label="공고명 또는 기관명" placeholder="공고명, 기관명" maxLength={100}
                  value={vm.filters.keyword} onChange={event => vm.changeFilter('keyword', event.target.value)} />
              </span>
            </label>
            <FilterSelect label="지역" value={vm.filters.region} options={regionNames} onChange={value => vm.changeFilter('region', value)} />
            <FilterSelect label="지원 분야" value={vm.filters.category} options={supportProgramCategories} onChange={value => vm.changeFilter('category', value)} />
            <FilterSelect label="지원 대상" value={vm.filters.target} options={savedProgramTargetOptions} onChange={value => vm.changeFilter('target', value)} />
          </div>
          <div className={s.appliedFilters}>
            <strong className={s.appliedTitle}>적용된 검색조건 <span className="text-brand-primary">{vm.activeFilterCount}</span></strong>
            {activeFilters.map(filter => <button type="button" className={s.filterChip} key={filter.key} onClick={() => vm.clearFilter(filter.key)}>
              {filter.label}<span aria-hidden="true">×</span><span className="sr-only"> 조건 해제</span>
            </button>)}
            {vm.activeFilterCount > 0
              ? <button type="button" className={s.resetFilters} onClick={vm.resetFilters}>전체 초기화</button>
              : <span className={s.resultCount}>관심 공고 {vm.totalProgramCount}건을 모두 표시하고 있습니다.</span>}
          </div>
        </form>

        {vm.viewMode !== 'pipeline' ? (vm.phase === 'loading' && vm.totalProgramCount === 0 ? (
          <section className={workspacePageStyles.card} aria-label="관심 공고 불러오는 중">
            <p className={workspacePageStyles.emptyNote} role="status">{savedSupportProgramMessages.loading}</p>
          </section>
        ) : vm.phase === 'failed' ? (
          <section className={workspacePageStyles.card} aria-label="관심 공고 불러오기 실패">
            <p className={workspacePageStyles.emptyNote}>{savedSupportProgramMessages.failed}</p>
            <button className={workspacePageStyles.quietLink} type="button" onClick={vm.retry}>다시 시도</button>
          </section>
        ) : isEmpty ? (
          <section className={workspacePageStyles.card} aria-label="관심 공고 없음">
            <p className={workspacePageStyles.emptyNote}>{savedSupportProgramMessages.empty}</p>
            <div><Link className={workspacePageStyles.primaryButton} to={appPaths.chat}>지원사업 찾기</Link></div>
          </section>
        ) : null) : null}

        {vm.viewMode === 'calendar' ? <>
          <div className={s.toolbar}>
            <div className={s.navigation}>
              <div className="flex items-center gap-1">
                <SelectField label="달력 연도" className={s.monthSelect} value={String(vm.year)}
                  options={vm.years.map(year => ({ value: String(year), label: `${year}년` }))}
                  onChange={value => vm.chooseMonth(Number(value), vm.month)} />
                <SelectField label="달력 월" className={s.monthSelect} value={String(vm.month)}
                  options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}월` }))}
                  onChange={value => vm.chooseMonth(vm.year, Number(value))} />
              </div>
              <div className={s.arrowGroup} role="group" aria-label="월 이동">
                <button type="button" className={s.arrow} aria-label="이전 달" title="이전 달" disabled={!vm.canPreviousMonth} onClick={() => vm.moveMonth(-1)}><Arrow direction="left" /></button>
                <button type="button" className={s.arrow} aria-label="다음 달" title="다음 달" disabled={!vm.canNextMonth} onClick={() => vm.moveMonth(1)}><Arrow direction="right" /></button>
              </div>
              <span className={s.note} role="status">표시 공고 <strong className="text-app-ink">{vm.programsInMonth}건</strong> / 전체 {vm.allProgramsInMonth}건</span>
            </div>
          </div>

          <div className={s.calendarFrame}>
            <table className={s.table} aria-label={`${monthLabel} 접수 일정`}>
              <thead><tr>{['일', '월', '화', '수', '목', '금', '토'].map((day, index) =>
                <th key={day} scope="col" className={`${s.weekday} ${index === 0 ? 'text-[#b75561]' : index === 6 ? 'text-[#2b5ea8]' : 'text-sample-muted'}`}>{day}</th>,
              )}</tr></thead>
              <tbody>{vm.weeks.map(week => <tr key={week[0]!.key}>{week.map((day, index) =>
                <td key={day.key} className={`${s.cell} ${!day.inMonth ? 'bg-[#fafbfc]' : 'bg-white'}`}>
                  <time dateTime={day.key} aria-current={day.isToday ? 'date' : undefined} className={`${s.date} ${day.isToday ? 'bg-brand-primary font-bold text-white' : !day.inMonth ? 'text-[#9ca3af]' : index === 0 ? 'text-[#b75561]' : index === 6 ? 'text-[#2b5ea8]' : 'text-sample-muted'}`}>{day.day}</time>
                  <CalendarEvents date={day.key} events={day.events} />
                </td>,
              )}</tr>)}</tbody>
            </table>
          </div>
        </> : vm.viewMode === 'list' ? <SavedProgramList programs={vm.listPrograms} page={vm.listPage}
          totalPages={vm.listTotalPages} onPageChange={vm.chooseListPage} />
          : <ApplicationPipeline filteredSavedPrograms={vm.filteredPrograms} savedPrograms={vm.programs}
            filtersActive={vm.activeFilterCount > 0} savedPhase={vm.phase} items={pipelineVm.items} phase={pipelineVm.phase} nextBeforeId={pipelineVm.nextBeforeId}
            loadingMore={pipelineVm.loadingMore} changingId={pipelineVm.changingId} updateError={pipelineVm.updateError}
            onRetry={pipelineVm.retry} onLoadMore={pipelineVm.loadMore} onChangeProgress={pipelineVm.changeProgress} />}
      </div>
    </div>
  </>
}

function ApplicationPipeline({ filteredSavedPrograms, savedPrograms, filtersActive, savedPhase, items, phase, nextBeforeId, loadingMore, changingId, updateError, onRetry, onLoadMore, onChangeProgress }: {
  filteredSavedPrograms: readonly CalendarProgram[]
  savedPrograms: readonly CalendarProgram[]
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
  onChangeProgress: (item: ApplicationPreparationSummary, stage: ApplicationProgressStage) => Promise<boolean>
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
  const openedStage = applicationPipelineStages.find(stage => stage.key === openedColumn)
  const openedStageItems = openedStage
    ? visiblePreparationItems.filter(item => item.progressStage === openedStage.key)
    : []
  const openedTotal = openedColumn === 'INTEREST' ? interestPrograms.length : openedStageItems.length
  const currentDialogPage = safePage(dialogPage, openedTotal, pipelineDialogPageSize)

  function openColumn(key: string) {
    setDialogPage(1)
    setOpenedColumn(key)
  }

  return <div role="tabpanel" aria-label="지원사업 진행 관리" className={s.pipelineSection}>
    {phase === 'loading' && items.length === 0 ? <section className={workspacePageStyles.card}><p className={workspacePageStyles.emptyNote} role="status">진행 중인 지원사업을 불러오고 있습니다.</p></section> : null}
    {phase === 'failed' ? <section className={workspacePageStyles.card} aria-label="진행 관리 불러오기 실패">
      <p className={workspacePageStyles.emptyNote}>진행 중인 지원사업을 불러오지 못했습니다.</p>
      <div><button type="button" className={workspacePageStyles.secondaryButton} onClick={onRetry}>다시 시도</button></div>
    </section> : null}
    {updateError ? <div className={s.pipelineError} role="alert">
      <span>{updateError}</span>
      <button type="button" className={workspacePageStyles.quietLink} onClick={onRetry}>최신 상태 불러오기</button>
    </div> : null}

    <div className={s.pipelineBoard} aria-label="지원사업 파이프라인">
      <section className={`${s.pipelineColumn} ${pipelineColumnTone[0]}`} aria-labelledby="pipeline-INTEREST">
        <header className={s.pipelineColumnHeader}>
          <h2 id="pipeline-INTEREST" className={s.pipelineColumnTitle}>관심</h2>
          <span className={s.pipelineCount} aria-label={`관심 ${interestPrograms.length}건`}>{interestPrograms.length}</span>
        </header>
        <p className={s.pipelineColumnDescription}>저장한 공고 중 아직 지원 준비를 시작하지 않은 사업입니다.</p>
        <div className={s.pipelineCards}>
          {visibleInterestPrograms.map(program => <InterestPipelineCard key={program.id} program={program} />)}
          {savedPhase !== 'loading' && interestPrograms.length === 0 ? <p className={s.pipelineEmpty}>지원 준비 전인 관심 공고가 없습니다.</p> : null}
          <PipelineColumnMore total={interestPrograms.length} previewSize={interestPipelinePreviewSize} onClick={() => openColumn('INTEREST')} />
        </div>
      </section>
      {applicationPipelineStages.map((stage, index) => {
        const stageItems = visiblePreparationItems.filter(item => item.progressStage === stage.key)
        const visibleStageItems = stageItems.slice(0, applicationPipelinePreviewSize)
        return <section key={stage.key} className={`${s.pipelineColumn} ${pipelineColumnTone[index + 1]}`} aria-labelledby={`pipeline-${stage.key}`}>
          <header className={s.pipelineColumnHeader}>
            <h2 id={`pipeline-${stage.key}`} className={s.pipelineColumnTitle}>{stage.label}</h2>
            <span className={s.pipelineCount} aria-label={`${stage.label} ${stageItems.length}건`}>{stageItems.length}</span>
          </header>
          <p className={s.pipelineColumnDescription}>{stage.description}</p>
          <div className={s.pipelineCards}>
            {visibleStageItems.map(item => <PipelineCard key={item.id} item={item} changing={changingId === item.id} onChangeProgress={onChangeProgress} />)}
            {phase === 'ready' && stageItems.length === 0 ? <p className={s.pipelineEmpty}>해당 단계의 사업이 없습니다.</p> : null}
            <PipelineColumnMore total={stageItems.length} previewSize={applicationPipelinePreviewSize} onClick={() => openColumn(stage.key)} />
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
            {openedColumn === 'INTEREST' ? '관심' : openedStage?.label} · {openedTotal}건
          </h2></div>
          <button type="button" className={s.dialogClose} aria-label="진행 단계 공고 닫기" onClick={() => setOpenedColumn(null)}>×</button>
        </div>
        <div className={s.pipelineDialogCards}>
          {openedColumn === 'INTEREST'
            ? pageItems(interestPrograms, currentDialogPage, pipelineDialogPageSize)
              .map(program => <InterestPipelineCard key={program.id} program={program} />)
            : pageItems(openedStageItems, currentDialogPage, pipelineDialogPageSize)
              .map(item => <PipelineCard key={item.id} item={item} changing={changingId === item.id} onChangeProgress={onChangeProgress} />)}
        </div>
        <div className={s.dialogPagination}>
          <Pagination label={`${openedColumn === 'INTEREST' ? '관심' : openedStage?.label} 단계 페이지`} page={currentDialogPage}
            totalPages={pageCount(openedTotal, pipelineDialogPageSize)} onPageChange={setDialogPage} />
        </div>
      </section>
    </div> : null}

    {nextBeforeId !== null && phase !== 'failed' ? <div className={s.pipelineMore}>
      <button type="button" className={workspacePageStyles.secondaryButton} disabled={loadingMore} onClick={onLoadMore}>
        {loadingMore ? '불러오는 중…' : '이전 신청 준비 더 보기'}
      </button>
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

function InterestPipelineCard({ program }: { program: CalendarProgram }) {
  const detailPath = getDetailPath(program)
  const startPath = program.sourceCode && program.sourceProgramId
    ? `${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId })}`
    : null
  return <article className={s.pipelineCard}>
    <div className={s.pipelineCardTop}>
      <span className={workspaceTagClassName('ok')}>{program.category}</span>
      <span className={s.pipelineRevision}>{program.region}</span>
    </div>
    <h3 className={s.pipelineCardTitle} title={program.title}>
      {detailPath
        ? <Link className={s.cardTitleLink} to={detailPath} state={{ searchReturnTo: savedProgramsPath('pipeline') }}>{program.title}</Link>
        : program.title}
    </h3>
    <p className={s.pipelineFormTitle}>{program.organization}</p>
    {startPath ? <Link className={`${workspacePageStyles.secondaryButton} ${s.pipelineCardAction}`} to={startPath}>지원 준비 시작</Link> : null}
  </article>
}

function PipelineCard({ item, changing, onChangeProgress }: {
  item: ApplicationPreparationSummary
  changing: boolean
  onChangeProgress: (item: ApplicationPreparationSummary, stage: ApplicationProgressStage) => Promise<boolean>
}) {
  return <article className={s.pipelineCard}>
    <div className={s.pipelineCardTop}>
      <span className={workspaceTagClassName('ok')}>{applicationServiceFieldLabels[item.serviceField]}</span>
      <span className={s.pipelineRevision}>입력 {item.inputRevision}차</span>
    </div>
    <h3 className={s.pipelineCardTitle} title={item.programTitle}>
      <Link className={s.cardTitleLink} to={supportProgramDetailPath({ sourceCode: item.sourceCode, sourceProgramId: item.sourceProgramId }, true)} state={{ searchReturnTo: savedProgramsPath('pipeline'), fromPipeline: true }}>{item.programTitle}</Link>
    </h3>
    <p className={s.pipelineFormTitle}>{item.formTitle}</p>
    <label className={s.pipelineStageField}>
      <span>단계 변경</span>
      <SelectField label={`${item.programTitle} 단계 변경`} value={item.progressStage} disabled={changing}
        options={applicationPipelineStages.map(stage => ({ value: stage.key, label: stage.label }))}
        onChange={value => void onChangeProgress(item, value as ApplicationProgressStage)} />
    </label>
    <p className={s.pipelineUpdatedAt}>최근 수정 {formatPipelineDate(item.updatedAt)}</p>
  </article>
}

function formatPipelineDate(value: string): string {
  const date = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.replaceAll('-', '.') : value
}

const pipelineColumnTone = [
  'border-[#cfd7df] bg-[#f5f7f9]',
  'border-[#b4ddc7] bg-[#f1faf5]',
  'border-[#c9dcf2] bg-[#f4f8fd]',
  'border-[#ead9a4] bg-[#fffaf0]',
  'border-[#dfd3eb] bg-[#faf7fd]',
  'border-[#b4ddc7] bg-[#f1faf5]',
  'border-[#d7dce1] bg-[#f6f7f8]',
] as const

const maximumVisibleEvents = 3
const calendarDialogPageSize = 4

function CalendarEvents({ date, events }: { date: string; events: CalendarEvent[] }) {
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
      {visible.map(event => <CalendarEventRow key={`${event.program.id}:${event.type}`} event={event} />)}
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
          {dialogEvents.map(event => <CalendarEventRow key={`${event.program.id}:${event.type}`} event={event} expanded />)}
        </ul>
        <div className={s.dialogPagination}>
          <Pagination label={`${date} 접수 일정 페이지`} page={currentDialogPage} totalPages={totalDialogPages} onPageChange={setDialogPage} />
        </div>
      </section>
    </div> : null}
  </>
}

function CalendarEventRow({ event, expanded = false }: { event: CalendarEvent; expanded?: boolean }) {
  const detailPath = getDetailPath(event.program)
  return <li className={expanded ? s.dialogEvent : s.event} title={event.program.title}>
    <span className={`${s.eventBadge} ${eventBadgeStyle[event.type]}`}>{eventBadgeLabel[event.type]}</span>
    <span className="min-w-0 flex-1">
      {detailPath ? <Link className={expanded ? 'block font-semibold text-app-ink hover:text-brand-primary' : s.eventTitle}
        to={detailPath} state={{ searchReturnTo: savedProgramsPath('calendar') }}>{event.program.title}</Link>
        : <span className={expanded ? 'block font-semibold text-app-ink' : s.eventTitle}>{event.program.title}</span>}
      {expanded ? <span className="mt-1 block text-xs text-sample-muted">{event.program.organization} · {event.program.region} · {event.program.category}</span> : null}
    </span>
  </li>
}

function SavedProgramList({ programs, page, totalPages, onPageChange }: {
  programs: CalendarProgram[]; page: number; totalPages: number; onPageChange: (page: number) => void
}) {
  const pageStart = Math.max(1, Math.min(page - 2, totalPages - 4))
  const pages = Array.from({ length: Math.min(5, totalPages) }, (_, index) => pageStart + index)
  return <div role="tabpanel" aria-label="관심 공고 목록" className="flex flex-col gap-4">
    {programs.length ? <div className={s.cardGrid}>{programs.map(program => {
      const status = programStatus(program.status)
      const detailPath = getDetailPath(program)
      return <article key={program.id} className={workspacePageStyles.card}>
        <div className={s.cardTop}>
          <span className={workspaceTagClassName(statusTone[status])}>{status}</span>
          <span className={s.cardPeriod}>{formatPeriod(program)}</span>
        </div>
        <h2 className={s.cardTitle} title={program.title}>
          {detailPath
            ? <Link to={detailPath} state={{ searchReturnTo: savedProgramsPath('list') }} className={s.cardTitleLink}>{program.title}</Link>
            : program.title}
        </h2>
        <p className={s.cardMeta}>{program.organization}</p>
        <div className={s.tagRow}>
          <span className={workspaceTagClassName('muted')} title={program.region}>{program.region}</span>
          <span className={workspaceTagClassName('muted')} title={program.category}>{program.category}</span>
          <span className={workspaceTagClassName('muted')} title={program.target}>{program.target}</span>
        </div>
      </article>
    })}</div> : (
      <section className={workspacePageStyles.card} aria-label="조건에 맞는 관심 공고 없음">
        <p className={workspacePageStyles.emptyNote}>조건에 맞는 관심 공고가 없습니다.</p>
      </section>
    )}
    {totalPages > 1 ? <nav className={s.pagination} aria-label="관심 공고 페이지">
      <button type="button" className={`${s.pageButton} ${s.inactivePageButton}`} disabled={page === 1} onClick={() => onPageChange(page - 1)}>이전</button>
      {pages.map(value => <button type="button" key={value} aria-label={`${value}페이지`} aria-current={value === page ? 'page' : undefined}
        className={`${s.pageButton} ${value === page ? s.activePageButton : s.inactivePageButton}`} onClick={() => onPageChange(value)}>{value}</button>)}
      <button type="button" className={`${s.pageButton} ${s.inactivePageButton}`} disabled={page === totalPages} onClick={() => onPageChange(page + 1)}>다음</button>
    </nav> : null}
    <p className={s.footer}>한 페이지에 8건씩 보여 주며, 공고명을 누르면 지원사업 상세로 갑니다.</p>
  </div>
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

type ProgramStatus = '접수 예정' | '접수 중' | '접수 마감' | '상태 미확인'

function programStatus(status: SupportProgramStatus): ProgramStatus {
  if (status === 'OPEN') return '접수 중'
  if (status === 'UPCOMING') return '접수 예정'
  if (status === 'CLOSED') return '접수 마감'
  return '상태 미확인'
}

/** 공고 상세·검색 결과와 같은 의미의 색을 씁니다. 서버 접수 상태를 화면 라벨과 색으로만 변환합니다. */
const statusTone: Record<ProgramStatus, WorkspaceTagTone> = {
  '접수 중': 'ok',
  '접수 예정': 'info',
  '접수 마감': 'muted',
  '상태 미확인': 'warn',
}

function formatPeriod(program: CalendarProgram): string {
  if (program.startDate === null && program.endDate === null) return '접수일 미확인'
  return `${program.startDate ?? '시작일 미확인'} ~ ${program.endDate ?? '마감일 미확인'}`
}

const eventBadgeLabel: Record<CalendarEventType, string> = {
  START: '시', END: '끝', SAME_DAY: '당일',
}

const eventBadgeStyle: Record<CalendarEventType, string> = {
  START: 'bg-[#dff4e7] text-[#187348]',
  END: 'bg-[#344054] text-white',
  SAME_DAY: 'bg-[#fff0d5] text-[#9a5b00]',
}

function FilterSelect({ label, value, options, onChange }: {
  label: string
  value: string
  options: readonly string[]
  onChange: (value: string) => void
}) {
  return <label className={s.selectField}>
    <span>{label}</span>
    <SelectField label={label} value={value}
      options={[{ value: '', label: '전체' }, ...options.map(option => ({ value: option, label: option }))]}
      onChange={onChange} />
  </label>
}
