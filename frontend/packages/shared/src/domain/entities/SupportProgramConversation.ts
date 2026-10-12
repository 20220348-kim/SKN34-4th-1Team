export type SupportProgramConversationContext = {
  query: string | null
  acceptingOnly: boolean
  companyConditions: {
    region: string | null
    industry: string | null
    establishedOn: string | null
    foundedYear?: number | null
    supportPurpose: string | null
  }
}

export type SupportProgramPendingClarification = {
  question: string
  draftContext: SupportProgramConversationContext
}

export type SupportProgramLastSearch = {
  context: SupportProgramConversationContext
  resultCount: number
}

export type SupportProgramInterpretRequest = {
  message: string
  context: SupportProgramConversationContext
  pendingClarification?: SupportProgramPendingClarification | null
  pendingProposal?: SupportProgramConversationContext | null
  lastSearch?: SupportProgramLastSearch | null
}

export const conversationChangedFields = ['QUERY', 'REGION', 'INDUSTRY', 'ESTABLISHED_ON', 'FOUNDED_YEAR', 'SUPPORT_PURPOSE', 'ACCEPTING_ONLY'] as const
export type SupportProgramConversationField = typeof conversationChangedFields[number]

/** 보완 질문의 종류입니다. 질문 문구는 서버가 정하고 화면은 종류로 선택지를 고릅니다. */
export const conversationClarificationKinds = ['QUERY', 'REGION', 'INDUSTRY', 'ESTABLISHMENT', 'SUPPORT_PURPOSE', 'ACCEPTING_ONLY', 'CHANGE_TARGET'] as const
export type SupportProgramClarificationKind = typeof conversationClarificationKinds[number]

export type SupportProgramInterpretation = {
  status: 'READY' | 'CLARIFICATION_REQUIRED' | 'ANSWERED'
  proposedContext: SupportProgramConversationContext
  clarificationQuestion: string | null
  answer?: string | null
  changedFields: SupportProgramConversationField[]
  /** CLARIFICATION_REQUIRED의 질문 종류입니다. 종류를 보내기 전 서버의 질문과 다른 상태는 null입니다. */
  clarificationKind?: SupportProgramClarificationKind | null
}

/**
 * 찾는 지원사업을 묻는 질문(QUERY)에 한 번에 답할 수 있는 지원 분야 선택지입니다.
 * 고른 문구를 사용자의 새 메시지로 보내며, 해석·확인 카드를 거쳐야 검색합니다.
 */
export const supportFieldQuickReplies = [
  '창업·사업화 지원', '정책자금·융자', '기술개발(R&D) 지원', '수출·해외진출 지원',
  '판로·마케팅 지원', '인력·고용 지원', '교육·컨설팅 지원',
] as const

/** 질문 종류에 맞는 빠른 답변입니다. 선택지를 정할 수 없는 질문은 직접 입력만 받습니다. */
export function clarificationQuickReplies(kind: SupportProgramClarificationKind | null | undefined): readonly string[] {
  return kind === 'QUERY' ? supportFieldQuickReplies : []
}
