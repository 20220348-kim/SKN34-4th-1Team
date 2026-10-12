import type { GovAgentApplication, GovAgentEvidence, GovAgentPartners, GovAgentProgram, GovAgentReview } from './GovAgent'
import type { SupportProgramSearchExclusionCounts } from './SupportProgramSearchResult'
import type { SupportProgram } from './SupportProgram'
import type { SupportProgramCompanyConditions, SupportProgramSearch } from '../repositories/SupportProgramRepository'
import type { SupportProgramConversationContext, SupportProgramInterpretation, SupportProgramInterpretRequest, SupportProgramLastSearch, SupportProgramPendingClarification } from './SupportProgramConversation'

export type ChatSearchOptions = { acceptingOnly: boolean; companyConditions?: SupportProgramCompanyConditions }
export type ChatMessage = {
  govEvidence?: GovAgentEvidence
  govApplication?: GovAgentApplication
  govReview?: GovAgentReview
  govPartners?: GovAgentPartners
  id: string
  role: 'assistant' | 'user'
  text: string
  failure?: 'search' | 'interpretation'
  programs?: SupportProgram[]
  totalCount?: number
  resultToken?: string | null
  expiresAt?: string | null
  searchOptions?: ChatSearchOptions
  searchQuery?: string
  /** 결과 메시지의 추천 제외 후보 수입니다. 결과가 없을 때 조건 빼기와 사유 안내에 씁니다. */
  exclusionCounts?: SupportProgramSearchExclusionCounts | null
}

/** 저장 시점의 대화와 조건입니다. 실행 중인 요청·인증 정보·미전송 초안은 저장하지 않습니다. */
export type ChatConversationSnapshot = {
  govProgram?: GovAgentProgram | null
  schemaVersion: 1
  companyDefaultsInitialized?: boolean
  messages: ChatMessage[]
  searchOptions: ChatSearchOptions
  conversationQuery: string | null
  confirmedSearch: SupportProgramSearch | null
  lastSearch: SupportProgramLastSearch | null
  pendingProposal: SupportProgramConversationContext | null
  pendingClarification: SupportProgramPendingClarification | null
  searchStatus: 'idle' | 'failed'
  searchError: string | null
  interpretation: {
    status: 'idle' | 'ready' | 'clarification' | 'failed'
    requestId?: string
    messageId?: string
    request?: SupportProgramInterpretRequest
    result?: SupportProgramInterpretation
    error?: string
  }
}
export type ChatConversationSummary = { id: string; title: string; version: number; updatedAt: string }
export type ChatConversationPage = { items: ChatConversationSummary[]; nextCursor: number | null }
export type ChatConversationDetail = { conversation: ChatConversationSummary; snapshot: ChatConversationSnapshot }
