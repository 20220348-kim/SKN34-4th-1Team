import type { SupportProgramConversationContext, SupportProgramInterpretation } from '../../domain/entities/SupportProgramConversation'

export const emptyConversationContext: SupportProgramConversationContext = {
  query: null,
  acceptingOnly: true,
  companyConditions: { region: null, industry: null, establishedOn: null, supportPurpose: null },
}

export const seoulConversationContext: SupportProgramConversationContext = {
  query: '사업화 지원', acceptingOnly: true,
  companyConditions: { region: '서울', industry: 'SW', establishedOn: '2024-01-01', supportPurpose: '사업화' },
}

export function readyConversationProposal(context: SupportProgramConversationContext): SupportProgramInterpretation {
  return { status: 'READY', proposedContext: context, clarificationQuestion: null, answer: null, changedFields: [] }
}
