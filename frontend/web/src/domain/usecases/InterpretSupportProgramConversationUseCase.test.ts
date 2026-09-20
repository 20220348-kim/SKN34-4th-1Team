import { describe, expect, it, vi } from 'vitest'

import { emptyConversationContext, readyConversationProposal, seoulConversationContext } from '../../data/fixtures/supportProgramConversation'
import { InterpretSupportProgramConversationUseCase } from './InterpretSupportProgramConversationUseCase'

describe('InterpretSupportProgramConversationUseCase', () => {
  it('전체 대화를 만들지 않고 현재 조건·새 발화·마지막 질문과 취소 신호만 해석에 전달한다', async () => {
    const proposal = readyConversationProposal(seoulConversationContext)
    const interpretConversation = vi.fn().mockResolvedValue(proposal)
    const request = { message: '2024-01-01', context: emptyConversationContext,
      pendingClarification: { question: '설립일은 언제인가요?', draftContext: { ...seoulConversationContext, companyConditions: {
        ...seoulConversationContext.companyConditions, establishedOn: null,
      } } } }
    const signal = new AbortController().signal
    await expect(new InterpretSupportProgramConversationUseCase({ interpretConversation }).execute(request, signal)).resolves.toBe(proposal)
    expect(interpretConversation).toHaveBeenCalledExactlyOnceWith(request, signal)
  })
})
