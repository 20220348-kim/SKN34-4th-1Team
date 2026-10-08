import { chatConversationSnapshotSchema } from '@govbiz/shared/data/models/ChatConversationDto'
import type { ChatMessage } from '@govbiz/shared/domain/entities/ChatConversation'
import { chatSnapshot, contextFromSearch, emptyChatContext } from './chatConversationState'
import { programDetail } from '../test/preparationFixtures'

test('retains earlier questions and recommendations in a snapshot accepted by the existing shared contract', () => {
  const messages: ChatMessage[] = Array.from({ length: 24 }, (_, index) => ({ id: `question-${index}`, role: index % 2 ? 'assistant' : 'user', text: `대화 ${index}` }))
  messages.splice(2, 0, { id: 'results', role: 'assistant', text: '추천 1건', totalCount: 1,
    programs: [{ ...programDetail, matchedReasons: [], recommendationScore: null, eligibilityReview: null }],
    searchQuery: '서울 사업화', searchOptions: { acceptingOnly: true, companyConditions: { region: '서울특별시' } } })
  const proposal = { status: 'READY' as const, proposedContext: { ...emptyChatContext, query: '부산 사업화' }, clarificationQuestion: null, changedFields: [] }
  const snapshot = chatSnapshot(messages, emptyChatContext, proposal, null)
  expect(chatConversationSnapshotSchema.parse(snapshot).messages).toHaveLength(25)
  expect(snapshot.messages[0].text).toBe('대화 0')
  expect(snapshot.lastSearch).toMatchObject({ context: { query: '서울 사업화', companyConditions: { region: '서울특별시' } }, resultCount: 1 })
  expect(snapshot.pendingProposal?.query).toBe('부산 사업화')
  expect(contextFromSearch(snapshot.conversationQuery, snapshot.searchOptions)).toEqual(emptyChatContext)
})

test('preserves unanswered clarification without persisting an unsent draft or credentials', () => {
  const clarification = { question: '어느 지역인가요?', draftContext: emptyChatContext }
  const snapshot = chatSnapshot([{ id: 'question', role: 'user', text: '지원사업' }, { id: 'answer', role: 'assistant', text: clarification.question }], emptyChatContext,
    { status: 'CLARIFICATION_REQUIRED', proposedContext: emptyChatContext, clarificationQuestion: clarification.question, changedFields: [] }, clarification)
  expect(chatConversationSnapshotSchema.parse(snapshot).pendingClarification).toEqual(clarification)
  expect(snapshot).not.toHaveProperty('accessToken')
  expect(snapshot).not.toHaveProperty('message')
})
