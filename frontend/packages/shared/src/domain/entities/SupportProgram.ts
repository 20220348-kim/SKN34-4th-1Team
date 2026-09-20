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
