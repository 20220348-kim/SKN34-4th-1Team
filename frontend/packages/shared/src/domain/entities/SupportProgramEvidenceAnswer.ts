/** 공고 원문에서 찾은 문장과 원문 위치를 함께 보여 주는 답변 근거입니다. */
export type SupportProgramEvidenceCitation = {
  excerpt: string
  sourceUrl: string
  /** 근거 링크에 보일 원문 이름입니다(예: 기업마당 상세 본문). 제공처를 화면이 직접 해석하지 않도록 서버가 정합니다. */
  sourceLabel: string
  chunkOrder: number
}

export type SupportProgramEvidenceAnswerStatus = 'ANSWERED' | 'INSUFFICIENT_EVIDENCE'

/** 특정 공고 원문만 근거로 생성한 질문 답변입니다. */
export type SupportProgramEvidenceAnswer = {
  answer: string
  answerStatus: SupportProgramEvidenceAnswerStatus
  citations: SupportProgramEvidenceCitation[]
}
