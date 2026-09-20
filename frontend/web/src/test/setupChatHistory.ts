import { vi } from 'vitest'

// 사이드바의 새 백그라운드 요청이 다른 기능 테스트의 순차 fetch 응답을 소비하지 않게 경계만 격리합니다.
// 대화 기록 HTTP/화면 통합 테스트는 이 mock을 해제해 production API를 별도로 검증합니다.
vi.mock('../data/api/chatConversationApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../data/api/chatConversationApi')>()
  return { ...original, chatConversationRequest: async (_email: string, path: string, _schema: unknown, _signal: unknown,
    body?: { expectedVersion: number; snapshot: { messages: { role: string; text: string }[] } }, method?: string) => {
    if (method === 'DELETE') return undefined
    if (body) return { id: decodeURIComponent(path.slice(1)), version: body.expectedVersion + 1,
      title: body.snapshot.messages.find((message) => message.role === 'user')?.text ?? '대화', updatedAt: '2026-09-12T12:00:00' }
    return { items: [], nextCursor: null }
  } }
})
