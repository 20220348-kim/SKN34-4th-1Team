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

export type SupportProgramInterpretation = {
  status: 'READY' | 'CLARIFICATION_REQUIRED' | 'ANSWERED'
  proposedContext: SupportProgramConversationContext
  clarificationQuestion: string | null
  answer?: string | null
  changedFields: SupportProgramConversationField[]
}
