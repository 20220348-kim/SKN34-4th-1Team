import { useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'

import type { SupportProgram } from '../../../../domain/entities/SupportProgram'
import { catalogSourceCodes, catalogSourceLabels, type SupportProgramCatalogFilters } from '../../../../domain/entities/SupportProgramCatalog'
import { isAppPath, supportProgramDetailPath } from '../../../shared/routes/appPaths'
import { defaultCatalogFilters, readCatalogFilters, writeCatalogFilters } from '../../../shared/support-program/catalogSearchParams'
import { FilterChoices } from '../../../shared/workspace/FilterChoices'
import { SelectField } from '../../../shared/workspace/SelectField'
import { toFilterChoiceOptions } from '../../../shared/workspace/filterChoiceOptions'
import { useSupportProgramCatalogViewModel } from '../viewmodel/useSupportProgramCatalogViewModel'

const inputStyle = 'min-h-11 w-full min-w-0 rounded-xl border border-sample-border bg-white px-3 text-sm text-app-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary'
const buttonStyle = 'min-h-11 cursor-pointer rounded-xl px-5 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-40'
const statusLabels = { ALL: '전체 접수 상태', OPEN: '접수 중', UPCOMING: '접수 예정', CLOSED: '접수 마감', UNKNOWN: '상태 미확인' }

/** 자연어 추천과 구분되는 DB 목록 화면입니다. AI 자격 판정을 표시하지 않습니다. */
export function SupportProgramCatalogPanel() {
  const [params, setParams] = useSearchParams()
  const filters = readCatalogFilters(params)
  const { pathname } = useLocation()
  const catalog = useSupportProgramCatalogViewModel(filters)
  const apply = (next: SupportProgramCatalogFilters) => setParams(writeCatalogFilters(next))
  const returnTo = `${pathname}?${writeCatalogFilters(filters)}`
  const pageStart = Math.max(1, Math.min(filters.page - 2, (catalog.data?.totalPages ?? 1) - 4))
  return (
    <main className="flex-1 bg-white text-app-ink">
      <div className="mx-auto grid w-full max-w-6xl gap-6 px-6 pt-6 pb-12 max-chat:gap-5 max-chat:px-4 max-chat:pt-4">
        <header>
          <p className="m-0 text-xs font-bold text-brand-primary">필터로 빠르게 찾기</p>
          <h1 className="mt-2 mb-2 text-3xl font-bold tracking-tight max-chat:text-2xl">원하는 지원사업을 직접 골라보세요.</h1>
          <p className="m-0 text-sm leading-relaxed text-sample-muted">분야와 지역을 선택하면 저장된 공고를 바로 볼 수 있어요.</p>
        </header>
        <CatalogFilters key={JSON.stringify(filters)} filters={filters} regions={catalog.regions} categories={catalog.categories}
          startupStages={catalog.startupStages} applicantTypes={catalog.applicantTypes} founderAges={catalog.founderAges} onApply={apply} />
        <section aria-label="필터 검색 결과" className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="m-0 text-base font-bold" aria-live="polite">검색 결과 <span className="text-brand-primary">{(catalog.data?.total ?? 0).toLocaleString()}건</span></h2>
            <label className="flex items-center gap-2 text-xs text-sample-muted">정렬
              <SelectField label="공고 정렬" className={`${inputStyle} !min-h-9 !w-auto !text-xs`} value={filters.sort}
                options={[{ value: 'RECENT', label: '최신순' }, { value: 'DEADLINE', label: '마감일순' }]}
                onChange={(value) => apply({ ...filters, sort: value as SupportProgramCatalogFilters['sort'], page: 1 })} />
            </label>
          </div>
          {catalog.phase === 'loading' ? <div role="status" className="rounded-2xl border border-sample-border px-5 py-14 text-center text-sm text-sample-muted">
            <span className="mx-auto mb-3 block size-6 rounded-full border-2 border-brand-accent border-t-brand-primary motion-safe:animate-spin" aria-hidden="true" />공고를 불러오고 있어요…
          </div> : catalog.phase === 'failed' ? <div role="alert" className="rounded-2xl border border-sample-border p-8 text-center">
            <p className="text-sm text-sample-muted">공고 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
            <button type="button" className={`${buttonStyle} bg-brand-primary text-white`} onClick={catalog.retry}>다시 불러오기</button>
          </div> : catalog.data?.programs.length ? (
            <div className="overflow-hidden rounded-2xl border border-sample-border">
              <div aria-hidden="true" className="grid grid-cols-[minmax(0,1fr)_10rem_10rem] gap-5 bg-[#f7f8f9] px-5 py-3 text-xs font-semibold text-sample-muted max-chat:hidden">
                <span>지원사업명 · 분야</span><span>기관</span><span>접수 상태 · 신청 기간</span>
              </div>
              {catalog.data.programs.map((program) => <CatalogRow key={JSON.stringify([program.sourceCode, program.id])} program={program} returnTo={returnTo} inApp={isAppPath(pathname)} />)}
            </div>
          ) : <div className="rounded-2xl border border-sample-border p-10 text-center">
            <h3 className="m-0 text-base font-bold">{catalog.data?.total ? '이 페이지에는 공고가 없어요.' : '조건에 맞는 공고가 없어요.'}</h3>
            <p className="text-sm text-sample-muted">{catalog.data?.total ? '공고 목록이 바뀌었을 수 있어요. 첫 페이지를 확인해 주세요.' : '검색어를 줄이거나 지역·분야·접수 상태를 넓혀보세요.'}</p>
            <button type="button" className={`${buttonStyle} border border-sample-border bg-white`} onClick={() => apply(catalog.data?.total ? { ...filters, page: 1 } : { ...defaultCatalogFilters, status: 'ALL' })}>
              {catalog.data?.total ? '첫 페이지로' : '전체 공고 보기'}
            </button>
          </div>}
          {catalog.data && catalog.data.totalPages > 1 ? <nav aria-label="공고 페이지" className="mt-6 flex flex-wrap justify-center gap-1.5">
            <button type="button" className={`${buttonStyle} !px-3 text-sample-muted`} disabled={filters.page <= 1} onClick={() => apply({ ...filters, page: filters.page - 1 })}>이전</button>
            {Array.from({ length: Math.min(5, catalog.data.totalPages) }, (_, index) => pageStart + index).map((page) => (
              <button type="button" key={page} aria-label={`${page}페이지`} aria-current={page === filters.page ? 'page' : undefined}
                className={`${buttonStyle} !px-3.5 ${page === filters.page ? 'bg-brand-primary text-white' : 'text-sample-muted hover:bg-[#f5f6f7]'}`}
                onClick={() => apply({ ...filters, page })}>{page}</button>
            ))}
            <button type="button" className={`${buttonStyle} !px-3 text-sample-muted`} disabled={filters.page >= catalog.data.totalPages} onClick={() => apply({ ...filters, page: filters.page + 1 })}>다음</button>
          </nav> : null}
        </section>
        <p className="m-0 text-xs leading-relaxed text-sample-muted">필터는 제공처의 공고 분류이며 신청 자격 판정이 아닙니다. 전국 공고는 ‘전국’을 선택해 확인하세요. 신청 자격은 공고 원문에서 확인해 주세요.</p>
      </div>
    </main>
  )
}

function CatalogFilters({ filters, regions, categories, startupStages, applicantTypes, founderAges, onApply }: {
  filters: SupportProgramCatalogFilters; regions: string[]; categories: string[]
  startupStages: string[]; applicantTypes: string[]; founderAges: string[]; onApply: (filters: SupportProgramCatalogFilters) => void
}) {
  const [draft, setDraft] = useState(filters)
  const [showStartupFilters, setShowStartupFilters] = useState(Boolean(filters.startupStage || filters.applicantType || filters.founderAge))
  const startupFilterCount = [draft.startupStage, draft.applicantType, draft.founderAge].filter(Boolean).length
  const needsPeriodNotice = draft.sourceCode === 'MSIT' || draft.sourceCode === 'CNTRADE_NOTICE'
  return <form aria-label="공고 필터" className="grid gap-4 rounded-3xl border border-sample-border bg-white p-5 shadow-[0_4px_24px_rgb(32_33_36_/_3%)] max-chat:p-4"
    onSubmit={(event) => { event.preventDefault(); onApply({ ...draft, keyword: draft.keyword.trim(), page: 1 }) }}>
    <div className="flex items-end gap-2">
      <label className="grid min-w-0 flex-1 gap-2 text-xs font-semibold text-sample-muted">검색어
        <input type="search" className={inputStyle} aria-label="공고명 또는 기관명" placeholder="공고명이나 기관명을 입력하세요" maxLength={100}
          value={draft.keyword} onChange={(event) => setDraft({ ...draft, keyword: event.target.value })} />
      </label>
      <button type="submit" className={`${buttonStyle} shrink-0 bg-brand-primary text-white hover:bg-[#066538]`}>검색</button>
    </div>
    <div className="grid gap-4 border-t border-sample-border pt-4">
      <FilterChoices label="지역" name="catalog-region" options={toFilterChoiceOptions(regions)} selected={draft.region} onSelect={(region) => setDraft({ ...draft, region })} />
      <FilterChoices label="분야" name="catalog-category" options={toFilterChoiceOptions(categories)} selected={draft.category} onSelect={(category) => setDraft({ ...draft, category })} />
      {/* 지역·분야 줄과 같은 라벨 폭(w-13)·간격으로 맞춰 드롭다운 상자가 같은 세로선에서 시작합니다. */}
      <div className="grid gap-3 sm:grid-cols-2 sm:gap-x-8">
        <label className="flex min-w-0 gap-3 text-xs font-semibold text-sample-muted max-chat:flex-col max-chat:gap-2">
          <span className="w-13 shrink-0 pt-2.5 max-chat:pt-0">출처</span>
          <SelectField label="출처" className={`${inputStyle} !min-h-9 min-w-0 flex-1`} value={draft.sourceCode}
            options={catalogSourceCodes.map((code) => ({ value: code, label: catalogSourceLabels[code] }))}
            onChange={(value) => {
              const sourceCode = value as SupportProgramCatalogFilters['sourceCode']
              setDraft({ ...draft, sourceCode, startupStage: '', applicantType: '', founderAge: '' })
              setShowStartupFilters(false)
            }} />
        </label>
        <label className="flex min-w-0 gap-3 text-xs font-semibold text-sample-muted max-chat:flex-col max-chat:gap-2">
          <span className="w-13 shrink-0 pt-2.5 max-chat:pt-0">접수 상태</span>
          <SelectField label="접수 상태" className={`${inputStyle} !min-h-9 min-w-0 flex-1`} value={draft.status}
            describedBy={needsPeriodNotice ? 'catalog-period-notice' : undefined}
            options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))}
            onChange={(value) => setDraft({ ...draft, status: value as SupportProgramCatalogFilters['status'] })} />
        </label>
      </div>
      {needsPeriodNotice ? <p id="catalog-period-notice" className="m-0 rounded-xl bg-[#f7f8f9] px-3 py-2 text-xs leading-relaxed text-sample-muted">
        접수 기간을 제공하지 않는 공고는 ‘상태 미확인’에 표시됩니다. ‘전체 접수 상태’ 또는 ‘상태 미확인’으로 검색해 주세요.
      </p> : null}
      {draft.sourceCode === 'KSTARTUP' ? <div className="min-w-0 rounded-xl bg-[#f7f8f9] px-3 py-2">
        <button type="button" aria-expanded={showStartupFilters} aria-controls="catalog-startup-filters"
          className="flex min-h-9 w-full cursor-pointer items-center justify-between gap-2 rounded text-left text-xs font-semibold text-sample-muted focus-visible:outline-2 focus-visible:outline-brand-primary"
          onClick={() => setShowStartupFilters((value) => !value)}>
          <span>K-Startup 추가 조건{startupFilterCount ? ` · ${startupFilterCount}개 선택` : ''}</span>
          <span aria-hidden="true">{showStartupFilters ? '−' : '+'}</span>
        </button>
        <div id="catalog-startup-filters" hidden={!showStartupFilters}>
          <div className="grid min-w-0 gap-3 pt-2 pb-3 sm:grid-cols-3">
            <CatalogExtraSelect label="창업 업력" options={startupStages} selected={draft.startupStage} onSelect={(startupStage) => setDraft({ ...draft, startupStage })} />
            <CatalogExtraSelect label="신청 대상" options={applicantTypes} selected={draft.applicantType} onSelect={(applicantType) => setDraft({ ...draft, applicantType })} />
            <CatalogExtraSelect label="대표자 연령" options={founderAges} selected={draft.founderAge} onSelect={(founderAge) => setDraft({ ...draft, founderAge })} />
          </div>
          <p className="mt-0 mb-2 text-xs leading-relaxed text-sample-muted">공고 분류 기준입니다. 실제 신청 자격은 원문을 확인해 주세요.</p>
        </div>
      </div> : null}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-sample-border pt-3">
      <p className="m-0 text-xs text-sample-muted">필터를 바꾼 뒤 검색을 눌러주세요.</p>
      <button type="button" className="cursor-pointer rounded px-1 py-1 text-xs font-semibold text-brand-primary focus-visible:outline-2 focus-visible:outline-brand-primary"
        onClick={() => { setDraft({ ...defaultCatalogFilters }); setShowStartupFilters(false); onApply({ ...defaultCatalogFilters }) }}>필터 초기화</button>
    </div>
  </form>
}

function CatalogExtraSelect({ label, options, selected, onSelect }: {
  label: string; options: string[]; selected: string; onSelect: (value: string) => void
}) {
  const choices = selected && !options.includes(selected) ? [selected, ...options] : options
  return <label className="grid min-w-0 gap-2 text-xs font-semibold text-sample-muted">{label}
    <SelectField label={label} className={inputStyle} value={selected}
      options={[{ value: '', label: '전체' }, ...choices.map((value) => ({ value, label: value }))]}
      onChange={onSelect} />
  </label>
}
function CatalogRow({ program, returnTo, inApp }: { program: SupportProgram; returnTo: string; inApp: boolean }) {
  const detailPath = supportProgramDetailPath({ sourceCode: program.sourceCode, sourceProgramId: program.id }, inApp, returnTo)
  return <article className="grid min-w-0 grid-cols-[minmax(0,1fr)_10rem_10rem] gap-5 border-t border-sample-border px-5 py-5 first:border-t-0 hover:bg-[#fafcfb] max-chat:grid-cols-1 max-chat:gap-2 max-chat:px-4">
    <div className="min-w-0">
      <p className="mt-0 mb-2 truncate text-xs font-semibold text-brand-primary">{program.categories.join(' · ') || '분야 미분류'} <span className="font-normal text-sample-muted">{program.regions.length ? ` / ${program.regions.join(' · ')}` : ''}</span></p>
      <h3 className="m-0 text-sm font-bold leading-relaxed [overflow-wrap:anywhere]"><Link className="rounded hover:text-brand-primary focus-visible:outline-2 focus-visible:outline-brand-primary"
        to={detailPath} state={{ searchReturnTo: returnTo }}>{program.title}</Link></h3>
    </div>
    <p className="m-0 self-center text-xs leading-relaxed text-sample-muted [overflow-wrap:anywhere]">{program.organization || program.sourceName}</p>
    <div className="self-center max-chat:flex max-chat:flex-wrap max-chat:items-center max-chat:gap-2">
      <span className={`inline-block rounded-full px-2 py-1 text-[0.68rem] font-bold ${program.status === 'OPEN' ? 'bg-brand-accent text-brand-primary' : 'bg-[#f1f3f4] text-sample-muted'}`}>{statusLabels[program.status]}</span>
      <p className="mt-1 mb-0 text-xs leading-relaxed text-sample-muted [overflow-wrap:anywhere]">{program.applicationPeriod}</p>
    </div>
  </article>
}
