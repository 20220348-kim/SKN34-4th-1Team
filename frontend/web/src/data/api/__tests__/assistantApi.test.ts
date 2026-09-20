import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AssistantQuestion } from '../../../domain/repositories/AssistantRepository'
import { AssistantRepositoryImpl } from '../../repositories/AssistantRepositoryImpl'
import { askAssistantApi, AssistantApiError } from '../assistantApi'

afterEach(() => {
  vi.unstubAllGlobals()
})

const question: AssistantQuestion = {
  message: '점수가 무슨 뜻이야?',
  history: [{ role: 'ASSISTANT', content: '무엇을 도와드릴까요?' }],
  context: { route: '/', programSelected: false },
  helpEntries: [{
    id: 'search-score-meaning', title: '점수는 무엇을 뜻하나요', question: '점수는 무슨 뜻인가요?',
    summary: '점수는 검색어와 공고의 관련도입니다.', body: ['점수는 순서를 정하는 값입니다.'], limitation: null,
    audience: 'public', status: 'available', action: { label: '검색 화면 열기', to: '/app/chat' },
  }],
}
const answer = {
  intent: 'PRODUCT_HELP', answer: '점수는 관련도입니다.', citations: ['search-score-meaning'],
  clarificationQuestion: null, searchQuery: null, accountTopic: null, navigation: { label: '검색 화면 열기', to: '/app/chat' }, cards: [],
}

describe('askAssistantApi', () => {
  it('posts the question with cookies and validates the intent answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(answer))
    vi.stubGlobal('fetch', fetchMock)

    await expect(askAssistantApi(question)).resolves.toEqual(answer)

    const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new URL(requestUrl).pathname).toBe('/api/v1/assistant/messages')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(String(init.body))).toEqual(question)
  })

  it('rejects answers whose navigation is not an absolute path or whose intent is unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...answer, navigation: { label: '열기', to: 'https://evil.example' } })))
    await expect(askAssistantApi(question)).rejects.toThrow()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...answer, intent: 'ELIGIBILITY' })))
    await expect(askAssistantApi(question)).rejects.toThrow()
  })

  it('accepts agent cards with internal detail routes and rejects other card routes', async () => {
    const card = { kind: 'RECRUITMENT', id: '21', title: 'AI 실증 참여기관 구합니다', subtitle: null, reason: '지역이 맞아요.', quote: null, to: '/app/partners/detail?recruitmentId=21' }
    const agentAnswer = { ...answer, intent: 'PARTNER_MATCH', citations: [], navigation: { label: '파트너 모집 열기', to: '/app/partners' }, cards: [card] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(agentAnswer)))
    await expect(askAssistantApi(question)).resolves.toEqual(agentAnswer)
    for (const to of ['https://evil.example/x', '/login', '/app/partners/detail?next=<script>']) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...agentAnswer, cards: [{ ...card, to }] })))
      await expect(askAssistantApi(question)).rejects.toThrow()
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...agentAnswer, cards: Array(6).fill(card) })))
    await expect(askAssistantApi(question)).rejects.toThrow()
  })

  it('surfaces the problem code and retry seconds of a failed response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problemResponse(429, 'SUPPORT_PROGRAM_RATE_LIMITED', { retryAfterSeconds: 12 })))
    const error = await askAssistantApi(question).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AssistantApiError)
    expect((error as AssistantApiError).status).toBe(429)
    expect((error as AssistantApiError).code).toBe('SUPPORT_PROGRAM_RATE_LIMITED')
    expect((error as AssistantApiError).retryAfterSeconds).toBe(12)
  })
})

describe('AssistantRepositoryImpl', () => {
  it('maps rate limits and AI failures to outcomes and rethrows other errors', async () => {
    const repository = new AssistantRepositoryImpl()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(answer)))
    await expect(repository.ask(question)).resolves.toEqual({ outcome: 'answered', answer })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problemResponse(429, 'SUPPORT_PROGRAM_RATE_LIMITED', { retryAfterSeconds: 5 })))
    await expect(repository.ask(question)).resolves.toEqual({ outcome: 'rate-limited', retryAfterSeconds: 5 })

    for (const status of [502, 503, 504]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problemResponse(status, 'AI_SERVICE_UNAVAILABLE')))
      await expect(repository.ask(question)).resolves.toEqual({ outcome: 'unavailable' })
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problemResponse(400, null)))
    await expect(repository.ask(question)).rejects.toBeInstanceOf(AssistantApiError)
  })
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function problemResponse(status: number, code: string | null, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ status, code, ...extra }), { status, headers: { 'Content-Type': 'application/problem+json' } })
}
