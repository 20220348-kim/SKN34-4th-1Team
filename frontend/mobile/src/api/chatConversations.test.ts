import { deleteChatConversation, getChatConversation, listChatConversations, saveChatConversation } from './chatConversations'
import { chatSnapshot, emptyChatContext } from '../screens/chatConversationState'
import { programDetail } from '../test/preparationFixtures'

const id = 'question-1', email = 'owner+mobile@example.com'
const summary = { id, title: '사업화 지원', version: 1, updatedAt: '2026-10-08T09:00:00' }
const program = { ...programDetail, matchedReasons: [], recommendationScore: null, eligibilityReview: null }
const snapshot = chatSnapshot([{ id, role: 'user', text: '사업화 지원' },
  { id: 'result-1', role: 'assistant', text: '추천 공고', programs: [program], totalCount: 1, searchQuery: '사업화 지원' }], emptyChatContext, null, null)
const fetchMock = jest.fn()
const originalFetch = globalThis.fetch
const originalBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com'
  globalThis.fetch = fetchMock
  fetchMock.mockReset()
})
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalBaseUrl === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBaseUrl
})
function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

test('saves the shared snapshot with Bearer ownership, expected version and no cookies', async () => {
  fetchMock.mockResolvedValue(response(summary))
  await expect(saveChatConversation('owner-token', email, id, 0, snapshot)).resolves.toEqual(summary)
  const [url, request] = fetchMock.mock.calls[0]
  expect(url).toBe(`https://api.example.com/api/v1/me/chat-conversations/${id}`)
  expect(request).toMatchObject({ method: 'PUT', credentials: 'omit', cache: 'no-store', redirect: 'error' })
  expect(request.headers.get('Authorization')).toBe('Bearer owner-token')
  expect(request.headers.get('X-Chat-Account')).toBe(encodeURIComponent(email))
  expect(request.headers.has('Cookie')).toBe(false)
  expect(JSON.parse(request.body)).toMatchObject({ expectedVersion: 0, snapshot: { messages: [
    { id, role: 'user', text: '사업화 지원' }, { id: 'result-1', programs: [{ id: program.id, sourceCode: program.sourceCode }] },
  ] } })
})

test('reads paginated history and maps saved program DTOs at the API boundary', async () => {
  fetchMock.mockResolvedValueOnce(response({ items: [summary], nextCursor: 30 }))
    .mockResolvedValueOnce(response({ conversation: summary, snapshot }))
  await expect(listChatConversations('owner-token', email, 40)).resolves.toMatchObject({ nextCursor: 30 })
  expect(fetchMock.mock.calls[0][0]).toContain('?before=40')
  const detail = await getChatConversation('owner-token', email, id)
  expect(detail.snapshot.messages[1].programs?.[0]).toMatchObject({ id: program.id, sourceCode: program.sourceCode })
  expect(detail.snapshot.messages[1].programs?.[0]).not.toHaveProperty('contact')
})

test('rejects malformed records, another conversation, save conflicts and expired sessions', async () => {
  fetchMock.mockResolvedValueOnce(response({ items: null }))
  await expect(listChatConversations('owner-token', email)).rejects.toThrow()
  fetchMock.mockResolvedValueOnce(response({ conversation: { ...summary, id: 'another' }, snapshot }))
  await expect(getChatConversation('owner-token', email, id)).rejects.toThrow()
  fetchMock.mockResolvedValueOnce(response(null, 409))
  await expect(saveChatConversation('owner-token', email, id, 0, snapshot)).rejects.toMatchObject({ status: 409 })
  fetchMock.mockResolvedValueOnce(response(null, 401))
  await expect(listChatConversations('owner-token', email)).rejects.toMatchObject({ status: 401 })
})

test('forwards cancellation and rejects a mismatched first question before sending', async () => {
  const controller = new AbortController()
  fetchMock.mockImplementation(async (_url, request) => {
    controller.abort()
    expect(request.signal.aborted).toBe(true)
    throw new Error('aborted')
  })
  await expect(getChatConversation('owner-token', email, id, controller.signal)).rejects.toThrow('aborted')
  fetchMock.mockClear()
  await expect(saveChatConversation('owner-token', email, 'different', 0, snapshot)).rejects.toThrow('대화 ID와 첫 질문이 일치하지 않습니다.')
  expect(fetchMock).not.toHaveBeenCalled()
})

test('deletes only the selected conversation with Bearer ownership and validates the empty 204 response', async () => {
  const controller = new AbortController()
  const json = jest.fn()
  fetchMock.mockResolvedValue({ ok: true, status: 204, json })
  await expect(deleteChatConversation('owner-token', email, id, controller.signal)).resolves.toBeUndefined()
  const [url, request] = fetchMock.mock.calls[0]
  expect(url).toBe(`https://api.example.com/api/v1/me/chat-conversations/${id}`)
  expect(request).toMatchObject({ method: 'DELETE', credentials: 'omit', cache: 'no-store', redirect: 'error' })
  expect(request).not.toHaveProperty('body')
  expect(request.headers.get('Authorization')).toBe('Bearer owner-token')
  expect(request.headers.get('X-Chat-Account')).toBe(encodeURIComponent(email))
  expect(json).not.toHaveBeenCalled()
  fetchMock.mockResolvedValueOnce(response(undefined, 200))
  await expect(deleteChatConversation('owner-token', email, id)).rejects.toThrow('올바르지 않은 대화 삭제 응답입니다.')
  fetchMock.mockResolvedValueOnce(response(undefined, 500))
  await expect(deleteChatConversation('owner-token', email, id)).rejects.toMatchObject({ status: 500 })
})
