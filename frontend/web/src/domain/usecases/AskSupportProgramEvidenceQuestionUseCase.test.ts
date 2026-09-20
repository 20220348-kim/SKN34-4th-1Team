import { describe, expect, it, vi } from 'vitest'

import { supportPrograms } from '../../data/fixtures/supportPrograms'
import { AskSupportProgramEvidenceQuestionUseCase } from './AskSupportProgramEvidenceQuestionUseCase'

describe('AskSupportProgramEvidenceQuestionUseCase', () => {
  it('forwards the complete source identity, trimmed question, and cancellation signal', async () => {
    const answerEvidenceQuestion = vi.fn().mockResolvedValue({ outcome: 'not-supported' })
    const useCase = new AskSupportProgramEvidenceQuestionUseCase({ answerEvidenceQuestion })
    const controller = new AbortController()

    await expect(useCase.execute({
      sourceCode: supportPrograms[0].sourceCode,
      sourceProgramId: supportPrograms[0].id,
      question: '  신청 대상은 누구인가요?  ',
    }, controller.signal)).resolves.toEqual({ outcome: 'not-supported' })

    expect(answerEvidenceQuestion).toHaveBeenCalledWith({
      sourceCode: supportPrograms[0].sourceCode,
      sourceProgramId: supportPrograms[0].id,
      question: '신청 대상은 누구인가요?',
    }, controller.signal)
  })
})
