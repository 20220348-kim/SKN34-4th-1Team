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
  /**
   * 검색 결과에서만 참일 수 있습니다. 전국이 아닌 공고 지역 태그가 회사 소재지와 겹치지 않아 다른 지역 한정일 수 있어
   * 서버가 결과 뒤로 보낸 공고입니다. 본문 자격 판정이 아닙니다.
   */
  regionTagMismatch?: boolean
  /** 서버가 이 공고에 원문 근거 질문을 받는다고 알린 경우에만 `true`입니다. 없으면 지원하지 않거나 알 수 없습니다. */
  evidenceQuestionSupported?: boolean
  /** 검색 결과에서만 있습니다. 같은 공고를 다른 제공처도 올려 서버가 이 칸에 함께 묶은 게시물입니다. */
  alsoPostedBy?: SupportProgramPosting[]
}

/** 같은 공고의 다른 제공처 게시물입니다. 그 제공처의 원문 주소와 원문 질문 지원 여부를 가집니다. */
export type SupportProgramPosting = {
  sourceCode: string
  id: string
  sourceName: string
  sourceUrl: string
  evidenceQuestionSupported: boolean
}

/** "기업마당·K-Startup 함께 게시"처럼 이 칸에 묶인 제공처 이름입니다. 묶인 게시물이 없으면 null입니다. */
export function supportProgramPostedTogetherLabel(program: SupportProgram): string | null {
  const others = program.alsoPostedBy ?? []
  return others.length ? `${[program.sourceName, ...others.map((posting) => posting.sourceName)].join('·')} 함께 게시` : null
}

/**
 * "이 공고에 질문하기"가 열 게시물입니다. 이 칸의 공고가 원문 질문을 받으면 그 공고, 아니면 함께 묶인 같은 공고 중
 * 원문 질문을 받는 첫 게시물입니다. 어느 쪽도 받지 않으면 null이라 질문 동작을 두지 않습니다.
 */
export function supportProgramQuestionTarget(program: SupportProgram): { sourceCode: string; sourceProgramId: string } | null {
  if (program.evidenceQuestionSupported) return { sourceCode: program.sourceCode, sourceProgramId: program.id }
  const posting = program.alsoPostedBy?.find((candidate) => candidate.evidenceQuestionSupported)
  return posting ? { sourceCode: posting.sourceCode, sourceProgramId: posting.id } : null
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
export type SupportProgramDetail = Omit<SupportProgram, 'matchedReasons' | 'recommendationScore' | 'eligibilityReview' | 'alsoPostedBy'> & {
  evidenceQuestionSupported: boolean
  applicationRoute: { method: string | null; url: string | null; type: 'GOOGLE_FORMS' | 'OTHER_ONLINE_FORM' | 'FILE' | 'UNKNOWN' }
  /** 공식 API의 문의처입니다. 제공처가 주지 않으면 `null`입니다. */
  contact: SupportProgramContact | null
  /** K-Startup 공식 우대 사항입니다. */
  preferenceDescription: string | null
  /** K-Startup 주관 기관 유형(공공기관·민간·교육기관·지자체 등)입니다. 기관 이름이 아닙니다. */
  supervisingInstitutionType: string | null
}

/** 공고 원문이 직접 연결한 첨부 한 건입니다. 이미지는 빼며, Core가 원본에서 받아 내려 주는 주소로 엽니다. */
export type SupportProgramAttachment = {
  fileName: string
  /** 소문자 확장자입니다. 이름에 없으면 빈 문자열입니다. */
  extension: string
  downloadUrl: string
}
