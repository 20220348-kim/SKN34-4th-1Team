import type { AskAssistantResult, AssistantQuestion, AssistantRepository } from '../../domain/repositories/AssistantRepository'
import { askAssistantApi, AssistantApiError } from '../api/assistantApi'
import { toAssistantAnswer } from '../models/AssistantAnswerDto'

/** 429는 한도, 502·503·504는 AI 장애로 바꿔 화면이 안내하게 합니다. 그 밖의 오류는 그대로 올립니다. */
export class AssistantRepositoryImpl implements AssistantRepository {
  async ask(question: AssistantQuestion, signal?: AbortSignal): Promise<AskAssistantResult> {
    try {
      return { outcome: 'answered', answer: toAssistantAnswer(await askAssistantApi(question, signal)) }
    } catch (error) {
      if (error instanceof AssistantApiError) {
        if (error.status === 429) return { outcome: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds }
        if (error.status === 502 || error.status === 503 || error.status === 504) return { outcome: 'unavailable' }
      }
      throw error
    }
  }
}
