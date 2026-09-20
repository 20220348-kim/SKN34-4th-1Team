import type { SupportProgram } from './SupportProgram'

export const catalogStatuses = ['ALL', 'OPEN', 'UPCOMING', 'CLOSED', 'UNKNOWN'] as const
export const catalogSorts = ['RECENT', 'DEADLINE'] as const
export const catalogSourceCodes = ['', 'BIZINFO', 'KSTARTUP', 'MSIT', 'CNTRADE_NOTICE'] as const

/** 출처 선택지의 화면 이름입니다. 지원사업 찾기와 공개 파트너 모집이 같은 이름을 씁니다. */
export const catalogSourceLabels: Record<typeof catalogSourceCodes[number], string> = {
  '': '전체 출처',
  BIZINFO: '기업마당',
  KSTARTUP: 'K-Startup',
  MSIT: '과학기술정보통신부',
  CNTRADE_NOTICE: '충청남도 온라인수출지원시스템',
}

/** 제공처가 분류한 공고를 탐색하는 필터이며 기업의 신청 자격이 아닙니다. */
export type SupportProgramCatalogFilters = {
  keyword: string
  region: string
  category: string
  sourceCode: typeof catalogSourceCodes[number]
  startupStage: string
  applicantType: string
  founderAge: string
  status: typeof catalogStatuses[number]
  sort: typeof catalogSorts[number]
  page: number
  pageSize: number
}

export type SupportProgramCatalog = {
  programs: SupportProgram[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  regions: string[]
  categories: string[]
  startupStages: string[]
  applicantTypes: string[]
  founderAges: string[]
}
