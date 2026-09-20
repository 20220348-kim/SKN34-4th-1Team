/** 검색 화면이 공고 데이터와 검색 인덱스를 사용할 수 있는지 나타냅니다. */
export type SupportProgramSourceSearchState =
  | 'PREPARING'
  | 'SEARCHABLE'
  | 'SEARCHABLE_WITH_SYNC_FAILURE'
  | 'UNAVAILABLE'

export type SupportProgramSearchState =
  | SupportProgramSourceSearchState
  | 'SEARCHABLE_WITH_PARTIAL_SOURCES'

/** 각 제공처의 저장 공고와 검색 준비 상태입니다. */
export type SupportProgramSourceSearchReadiness = {
  sourceCode: string
  sourceName: string
  searchState: SupportProgramSourceSearchState
  programCount: number
  indexReady: boolean
  lastSuccessfulSyncAt: string | null
  lastFailedSyncAt: string | null
}

/** 검색 요청 전 사용자에게 보여 줄 지원사업 데이터 준비 상태입니다. */
export type SupportProgramSearchReadiness = {
  searchState: SupportProgramSearchState
  programCount: number
  indexReady: boolean
  lastSuccessfulSyncAt: string | null
  lastFailedSyncAt: string | null
  sources: SupportProgramSourceSearchReadiness[]
}
