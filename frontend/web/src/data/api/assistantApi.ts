import type { AssistantQuestion } from '../../domain/repositories/AssistantRepository'
import { getCoreApiBaseUrl } from './coreApiConfig'
import { assistantAnswerDtoSchema, type AssistantAnswerDto } from '../models/AssistantAnswerDto'

const ASSISTANT_MESSAGES_PATH = '/api/v1/assistant/messages'

/** 도우미 endpoint의 HTTP 상태와 ProblemDetail `code`를 Repository가 업무 결과로 바꿀 수 있게 합니다. */
export class AssistantApiError extends Error {
  readonly status: number
  readonly code: string | null
  /** 429 응답의 `retryAfterSeconds`. 없거나 정수가 아니면 null입니다. */
  readonly retryAfterSeconds: number | null

  constructor(status: number, code: string | null, retryAfterSeconds: number | null = null) {
    super(`Core API returned HTTP ${status} for the assistant request.`)
    this.name = 'AssistantApiError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** 비로그인도 물을 수 있지만 세션 쿠키가 있으면 함께 보내 회원 상태 답을 받습니다. */
export async function askAssistantApi(question: AssistantQuestion, signal?: AbortSignal): Promise<AssistantAnswerDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${ASSISTANT_MESSAGES_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(question),
    credentials: 'include',
    signal,
  })
  if (!response.ok) {
    const problem = await readProblem(response)
    throw new AssistantApiError(response.status, problem.code, problem.retryAfterSeconds)
  }
  return assistantAnswerDtoSchema.parse(await response.json())
}

async function readProblem(response: Response): Promise<{ code: string | null; retryAfterSeconds: number | null }> {
  try {
    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null) return { code: null, retryAfterSeconds: null }
    const record = payload as { code?: unknown; retryAfterSeconds?: unknown }
    return {
      code: typeof record.code === 'string' ? record.code : null,
      retryAfterSeconds: Number.isInteger(record.retryAfterSeconds) ? (record.retryAfterSeconds as number) : null,
    }
  } catch {
    return { code: null, retryAfterSeconds: null }
  }
}
