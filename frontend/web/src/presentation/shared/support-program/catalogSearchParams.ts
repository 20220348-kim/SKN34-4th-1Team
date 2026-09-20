import { catalogSorts, catalogSourceCodes, catalogStatuses, type SupportProgramCatalogFilters } from '../../../domain/entities/SupportProgramCatalog'

export const defaultCatalogFilters: SupportProgramCatalogFilters = {
  keyword: '', region: '', category: '', status: 'OPEN', sort: 'RECENT', page: 1, pageSize: 12,
  sourceCode: '', startupStage: '', applicantType: '', founderAge: '',
}

/** 문서 작성·중복 지원 검토는 접수 종료 공고도 선택할 수 있습니다. */
export const defaultProgramSelectionFilters: SupportProgramCatalogFilters = {
  ...defaultCatalogFilters, status: 'ALL', pageSize: 10,
}

/** URL을 검색 상태로 복원할 때 알려진 필터만 받아들입니다. */
export function readCatalogFilters(params: URLSearchParams): SupportProgramCatalogFilters {
  const text = (key: string) => {
    const value = (params.get(key) ?? '').trim()
    return value.length <= (key === 'region' ? 50 : 100) && !/\p{C}/u.test(value) ? value : ''
  }
  const status = params.get('status') as SupportProgramCatalogFilters['status']
  const sort = params.get('sort') as SupportProgramCatalogFilters['sort']
  const source = params.get('sourceCode') as SupportProgramCatalogFilters['sourceCode']
  const sourceCode = catalogSourceCodes.includes(source) ? source : ''
  const pageText = params.get('page') ?? '1'
  const page = /^\d{1,7}$/.test(pageText) ? Number(pageText) : 1
  return { ...defaultCatalogFilters, keyword: text('keyword'), region: text('region'), category: text('category'),
    sourceCode, startupStage: sourceCode === 'KSTARTUP' ? text('startupStage') : '',
    applicantType: sourceCode === 'KSTARTUP' ? text('applicantType') : '',
    founderAge: sourceCode === 'KSTARTUP' ? text('founderAge') : '',
    status: catalogStatuses.includes(status) ? status : 'OPEN', sort: catalogSorts.includes(sort) ? sort : 'RECENT',
    page: page >= 1 && page <= 1_000_000 ? page : 1 }
}

export function writeCatalogFilters(filters: SupportProgramCatalogFilters): URLSearchParams {
  const params = new URLSearchParams({ mode: 'filter' })
  for (const key of ['keyword', 'region', 'category', 'status', 'sort', 'page'] as const) {
    if (filters[key] !== defaultCatalogFilters[key]) params.set(key, String(filters[key]))
  }
  if (catalogSourceCodes.includes(filters.sourceCode) && filters.sourceCode) params.set('sourceCode', filters.sourceCode)
  if (filters.sourceCode === 'KSTARTUP') {
    for (const key of ['startupStage', 'applicantType', 'founderAge'] as const) {
      if (filters[key]) params.set(key, filters[key])
    }
  }
  return params
}
