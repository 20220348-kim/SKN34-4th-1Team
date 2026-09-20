import type { AssistantAnswer } from '../entities/AssistantAnswer'

export type AssistantHistoryMessage = {
  role: 'USER' | 'ASSISTANT'
  content: string
}

/** 사용자가 지금 보고 있는 화면입니다. `programSelected`는 공고 상세처럼 원문 질문을 열 수 있는 화면인지입니다. */
export type AssistantScreenContext = {
  route: string
  programSelected: boolean
}

/** 요청에 실어 보내는 도움말 한 항목입니다. 원본 `HelpEntry`에서 모델이 쓰는 필드만 고릅니다. */
export type AssistantHelpEntryInput = {
  id: string
  title: string
  question: string
  summary: string
  body: string[]
  limitation: string | null
  audience: 'public' | 'member' | 'company' | 'admin'
  status: 'available' | 'demo' | 'planned'
  action: { label: string; to: string } | null
}

export type AssistantQuestion = {
  message: string
  history: AssistantHistoryMessage[]
  context: AssistantScreenContext
  helpEntries: AssistantHelpEntryInput[]
}

/** 자유 질문 결과입니다. 한도와 AI 장애는 화면이 다르게 안내하고, 그 밖의 실패는 예외로 올라갑니다. */
export type AskAssistantResult =
  | { outcome: 'answered'; answer: AssistantAnswer }
  | { outcome: 'rate-limited'; retryAfterSeconds: number | null }
  | { outcome: 'unavailable' }

export interface AssistantRepository {
  /** 도우미 자유 질문 한 건을 Core에 보내고 의도별 답을 받습니다. 세션이 있으면 쿠키로 함께 갑니다. */
  ask(question: AssistantQuestion, signal?: AbortSignal): Promise<AskAssistantResult>
}
