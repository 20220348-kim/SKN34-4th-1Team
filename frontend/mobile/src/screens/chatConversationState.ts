import type { ChatConversationSnapshot, ChatMessage, ChatSearchOptions } from '@govbiz/shared/domain/entities/ChatConversation'
import type { SupportProgramConversationContext, SupportProgramInterpretation, SupportProgramPendingClarification } from '@govbiz/shared/domain/entities/SupportProgramConversation'

export const emptyChatContext: SupportProgramConversationContext = {
  query: null, acceptingOnly: true,
  companyConditions: { region: null, industry: null, establishedOn: null, foundedYear: null, supportPurpose: null },
}

export function chatSearchOptions(context: SupportProgramConversationContext): ChatSearchOptions {
  return { acceptingOnly: context.acceptingOnly,
    companyConditions: Object.fromEntries(Object.entries(context.companyConditions).filter(([, value]) => value != null)) }
}

export function chatSnapshot(messages: ChatMessage[], context: SupportProgramConversationContext,
  proposal: SupportProgramInterpretation | null, clarification: SupportProgramPendingClarification | null): ChatConversationSnapshot {
  const lastResult = [...messages].reverse().find(message => message.programs !== undefined)
  const searchContext = lastResult ? contextFromSearch(lastResult.searchQuery ?? null, lastResult.searchOptions ?? chatSearchOptions(context)) : null
  return { schemaVersion: 1, messages, searchOptions: chatSearchOptions(context), conversationQuery: context.query,
    confirmedSearch: searchContext?.query ? { query: searchContext.query, ...chatSearchOptions(searchContext) } : null,
    lastSearch: searchContext ? { context: searchContext, resultCount: lastResult!.totalCount ?? 0 } : null,
    pendingProposal: proposal?.status === 'READY' ? proposal.proposedContext : null, pendingClarification: clarification,
    searchStatus: 'idle', searchError: null,
    interpretation: proposal ? { status: proposal.status === 'READY' ? 'ready' : proposal.status === 'CLARIFICATION_REQUIRED' ? 'clarification' : 'idle',
      requestId: messages.at(-1)?.id, result: proposal } : { status: 'idle' } }
}

export function contextFromSearch(query: string | null, options: ChatSearchOptions): SupportProgramConversationContext {
  return { query, acceptingOnly: options.acceptingOnly, companyConditions: { ...emptyChatContext.companyConditions, ...options.companyConditions } }
}
