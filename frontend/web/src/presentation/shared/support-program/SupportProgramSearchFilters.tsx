import { regionNames } from '../../../domain/entities/Region'
import { supportProgramCategories } from '../../../domain/entities/SupportProgramCategory'
import { catalogSourceCodes, catalogSourceLabels, type SupportProgramCatalog, type SupportProgramCatalogFilters } from '../../../domain/entities/SupportProgramCatalog'
import { SelectField } from '../workspace/SelectField'
import { defaultProgramSelectionFilters } from './catalogSearchParams'

const fieldStyle = 'grid min-w-0 gap-1 text-[0.7rem] font-bold text-sample-muted'
const inputStyle = 'min-h-11 w-full min-w-0 rounded-[1rem] border border-sample-border bg-white px-3 text-[0.85rem] font-semibold text-app-ink focus-visible:outline-2 focus-visible:outline-brand-primary disabled:opacity-50'
const buttonStyle = 'min-h-11 cursor-pointer rounded-xl px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-50'
const statusLabels = { ALL: '전체', OPEN: '접수 중', UPCOMING: '접수 예정', CLOSED: '접수 종료', UNKNOWN: '접수 상태 미확인' }

/** 작성 화면의 선택 상태와 분리하여 공고 검색 조건만 편집합니다. */
export function SupportProgramSearchFilters({ filters, appliedFilters, catalog, disabled = false, loading = false, onChange, onSearch }: {
  filters: SupportProgramCatalogFilters
  appliedFilters: SupportProgramCatalogFilters
  catalog: SupportProgramCatalog | null
  disabled?: boolean
  loading?: boolean
  onChange: (filters: SupportProgramCatalogFilters) => void
  onSearch: (filters: SupportProgramCatalogFilters) => void
}) {
  const activeFilters: { key: 'keyword' | 'region' | 'category' | 'sourceCode' | 'status'; label: string }[] = [
    ...(appliedFilters.keyword ? [{ key: 'keyword' as const, label: `검색 · ${appliedFilters.keyword}` }] : []),
    ...(appliedFilters.region ? [{ key: 'region' as const, label: `지역 · ${appliedFilters.region}` }] : []),
    ...(appliedFilters.category ? [{ key: 'category' as const, label: `분야 · ${appliedFilters.category}` }] : []),
    ...(appliedFilters.sourceCode ? [{ key: 'sourceCode' as const, label: `출처 · ${catalogSourceLabels[appliedFilters.sourceCode]}` }] : []),
    ...(appliedFilters.status !== 'ALL' ? [{ key: 'status' as const, label: `접수 · ${statusLabels[appliedFilters.status]}` }] : []),
  ]
  const apply = (next: SupportProgramCatalogFilters) => { onChange(next); onSearch(next) }
  const options = (defaults: readonly string[], available: string[] = [], selected: string) => [
    { value: '', label: '전체' },
    ...[...new Set([...defaults, ...available, selected].filter(Boolean))].map((value) => ({ value, label: value })),
  ]
  return <fieldset disabled={disabled || loading} className="min-w-0 overflow-hidden rounded-[1rem] border border-sample-border bg-white" aria-label="공고 검색 필터">
    <div className="grid grid-cols-2 items-end gap-3 p-4 max-chat:grid-cols-1">
      <label className={`${fieldStyle} col-span-2 max-chat:col-span-1`}>검색어
        <input className={inputStyle} type="search" aria-label="공고명·기관명" placeholder="공고명, 기관명" maxLength={100}
          value={filters.keyword} onChange={(event) => onChange({ ...filters, keyword: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); onSearch(filters) }
          }} />
      </label>
      <label className={fieldStyle}>지역
        <SelectField label="지역" className={inputStyle} disabled={disabled || loading} value={filters.region}
          options={options(regionNames, catalog?.regions, filters.region)} onChange={(region) => onChange({ ...filters, region })} />
      </label>
      <label className={fieldStyle}>지원 분야
        <SelectField label="지원 분야" className={inputStyle} disabled={disabled || loading} value={filters.category}
          options={options(supportProgramCategories, catalog?.categories, filters.category)} onChange={(category) => onChange({ ...filters, category })} />
      </label>
      <label className={fieldStyle}>출처
        <SelectField label="출처" className={inputStyle} disabled={disabled || loading} value={filters.sourceCode}
          options={catalogSourceCodes.map((value) => ({ value, label: catalogSourceLabels[value] }))}
          onChange={(value) => onChange({ ...filters, sourceCode: value as SupportProgramCatalogFilters['sourceCode'] })} />
      </label>
      <label className={fieldStyle}>접수 상태
        <SelectField label="접수 상태" className={inputStyle} disabled={disabled || loading} value={filters.status}
          options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))}
          onChange={(value) => onChange({ ...filters, status: value as SupportProgramCatalogFilters['status'] })} />
      </label>
      <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 max-chat:col-span-1">
        <p className="text-xs text-sample-muted">조건을 바꾼 뒤 공고 검색을 눌러 주세요.</p>
        <button type="button" className={`${buttonStyle} bg-brand-primary text-white`} onClick={() => onSearch(filters)}>{loading ? '공고 검색 중…' : '공고 검색'}</button>
      </div>
    </div>
    <div className="flex min-h-12 flex-wrap items-center gap-2 border-t border-sample-border bg-[#f6f7f8] px-4 py-2 text-xs text-sample-muted" aria-label="적용된 검색조건">
      <strong className="text-app-ink">적용된 검색조건 <span className="text-brand-primary">{activeFilters.length}</span></strong>
      {activeFilters.map(({ key, label }) => <button type="button" key={key} aria-label={`${label} 조건 해제`}
        className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-full border border-sample-border bg-white px-3 font-semibold text-app-ink hover:border-brand-primary focus-visible:outline-2 focus-visible:outline-brand-primary"
        onClick={() => apply({ ...appliedFilters, [key]: defaultProgramSelectionFilters[key], page: 1 })}>
        {label}<span aria-hidden="true">×</span>
      </button>)}
      <button type="button" className="ml-auto min-h-8 cursor-pointer font-bold text-brand-primary focus-visible:outline-2 focus-visible:outline-brand-primary"
        onClick={() => apply({ ...defaultProgramSelectionFilters })}>전체 초기화</button>
    </div>
  </fieldset>
}
