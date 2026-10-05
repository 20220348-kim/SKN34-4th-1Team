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
 * 공식 제공처가 준 문의처입니다. K-Startup은 담당 부서와 하이픈 없는 숫자 전화번호를, 기업마당은 문의처 원문 한 줄을 줍니다.
 * 전화번호는 제공처 값 그대로이며 표시 형식과 전화 연결은 `supportProgramContactParts`가 정합니다.
 */
export type SupportProgramContact = { department: string | null; phoneNumber: string | null; text: string | null }

/**
 * 상세 조회로 받는 공고입니다. 검색 결과와 달리 관련도·추천 이유·자격 판정이 없고, 상세 화면이 제공처를
 * 직접 비교하지 않도록 원문 근거 질문 지원 여부를 서버가 정해 줍니다.
 */
export type SupportProgramDetail = Omit<SupportProgram, 'matchedReasons' | 'recommendationScore' | 'eligibilityReview'> & {
  evidenceQuestionSupported: boolean
  applicationRoute: { method: string | null; url: string | null; type: 'GOOGLE_FORMS' | 'OTHER_ONLINE_FORM' | 'FILE' | 'UNKNOWN' }
  /** 공식 API의 문의처입니다. 제공처가 주지 않으면 `null`입니다. */
  contact: SupportProgramContact | null
  /** K-Startup 공식 우대 사항입니다. */
  preferenceDescription: string | null
  /** K-Startup 주관 기관 유형(공공기관·민간·교육기관·지자체 등)입니다. 기관 이름이 아닙니다. */
  supervisingInstitutionType: string | null
}
