export type SupportProgramStatus = 'OPEN' | 'UPCOMING' | 'CLOSED' | 'UNKNOWN'

export type SupportProgramEligibilityAxis = {
  status: 'MATCH' | 'UNKNOWN'
  explanation: string
  evidence: { field: 'SUMMARY' | 'TARGET_DESCRIPTION'; quote: string }[]
}

export type SupportProgramEligibilityReview = {
  status: 'MATCH' | 'REVIEW_REQUIRED'
  basis: 'OFFICIAL_API_TEXT'
  target: SupportProgramEligibilityAxis
  region: SupportProgramEligibilityAxis
}

export type SupportProgram = {
  /** 제공처별 원본 식별자의 제공처 코드입니다. */
  sourceCode: string
  /** 제공처 안에서 공고를 식별하는 원본 ID입니다. */
  id: string
  title: string
  organization: string
  summary: string
  categories: string[]
  regions: string[]
  targetDescription: string
  applicationPeriod: string
  applicationStartDate: string | null
  applicationEndDate: string | null
  status: SupportProgramStatus
  sourceName: string
  sourceUrl: string
  matchedReasons: string[]
  recommendationScore: number | null
  eligibilityReview: SupportProgramEligibilityReview | null
}

/**
 * 상세 조회로 받는 공고입니다. 검색 결과와 달리 관련도·추천 이유·자격 판정이 없고, 상세 화면이 제공처를
 * 직접 비교하지 않도록 원문 근거 질문 지원 여부를 서버가 정해 줍니다.
 */
export type SupportProgramDetail = Omit<SupportProgram, 'matchedReasons' | 'recommendationScore' | 'eligibilityReview'> & {
  evidenceQuestionSupported: boolean
}
