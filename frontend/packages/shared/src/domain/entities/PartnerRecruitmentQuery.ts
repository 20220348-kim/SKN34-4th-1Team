import type { PartnerRole } from './PartnerRecruitment'

export type PartnerRecruitmentSort = 'DEADLINE' | 'RECENT'

/** 목록을 좁히고 정렬하는 조건입니다. 그대로 모집 목록 API의 조회 파라미터가 됩니다. */
export type PartnerRecruitmentQuery = {
  keyword: string
  /** 비어 있으면 모든 역할입니다. 여러 개를 함께 고를 수 있습니다. */
  seekingRoles: PartnerRole[]
  /** 비어 있으면 전국을 포함한 모든 지역입니다. 지역을 고르면 그 지역들과 전국 모집글이 함께 보입니다. */
  regions: string[]
  /** 내 글만 보기입니다. 마감된 내 글도 포함합니다. */
  mineOnly: boolean
  /** 묶인 공고의 출처(`BIZINFO` 등)입니다. 빈 문자열이면 모든 출처입니다. */
  sourceCode: string
  sort: PartnerRecruitmentSort
  page: number
}

export const partnerRecruitmentPageSize = 20

export const defaultPartnerRecruitmentQuery: PartnerRecruitmentQuery = {
  keyword: '',
  seekingRoles: [],
  regions: [],
  mineOnly: false,
  sourceCode: '',
  sort: 'DEADLINE',
  page: 1,
}

export const partnerRecruitmentSortLabels: Record<PartnerRecruitmentSort, string> = {
  DEADLINE: '마감 임박순',
  RECENT: '최근 등록순',
}

/** 검색어·필터 중 하나라도 기본값과 다르면 참입니다. 정렬과 페이지만 바뀐 것은 좁힌 것으로 보지 않습니다. */
export function hasPartnerRecruitmentNarrowing(query: PartnerRecruitmentQuery): boolean {
  return query.keyword.trim() !== '' || query.seekingRoles.length > 0 || query.regions.length > 0 || query.mineOnly
    || query.sourceCode !== ''
}

/** 한 페이지 결과입니다. 총 건수는 같은 조건의 전체 건수입니다. */
export type PartnerRecruitmentPage<Item> = {
  recruitments: Item[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}
