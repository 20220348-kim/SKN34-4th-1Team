import type { AskAssistantResult, AssistantQuestion, AssistantRepository } from '../repositories/AssistantRepository'

type AskAssistantRepository = Pick<AssistantRepository, 'ask'>

/** 서버와 같은 상한입니다. 질문 500자, 최근 대화 6개, 대화 한 개 1,000자. */
export const assistantQuestionLimits = { message: 500, history: 6, historyContent: 1000 } as const

export function isValidAssistantMessage(message: string): boolean {
  const trimmed = message.trim()
  return trimmed.length > 0 && trimmed.length <= assistantQuestionLimits.message
}

/** 도우미 자유 질문 한 건을 보냅니다. 질문은 다듬고 최근 대화는 상한만큼만 실어 서버 검증에 걸리지 않게 합니다. */
export class AskAssistantUseCase {
  private readonly repository: AskAssistantRepository

  constructor(repository: AskAssistantRepository) {
    this.repository = repository
  }

  execute(question: AssistantQuestion, signal?: AbortSignal): Promise<AskAssistantResult> {
    const message = question.message.trim()
    if (!isValidAssistantMessage(message)) throw new RangeError(`message must be 1~${assistantQuestionLimits.message} characters`)
    if (question.helpEntries.length === 0) throw new RangeError('helpEntries must not be empty')
    const history = question.history
      .filter((item) => item.content.trim() !== '')
      .slice(-assistantQuestionLimits.history)
      .map((item) => ({ role: item.role, content: item.content.trim().slice(0, assistantQuestionLimits.historyContent) }))
    return this.repository.ask({ ...question, message, history }, signal)
  }
}
