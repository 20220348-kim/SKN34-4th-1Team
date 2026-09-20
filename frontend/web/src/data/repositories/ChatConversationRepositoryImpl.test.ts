import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatConversationRepositoryImpl } from './ChatConversationRepositoryImpl'
import { ChatConversationApiError } from '../api/chatConversationApi'
import { createAppStore } from '../../app/store'
import { createChatConversationSnapshot, interpretationStarted } from '../../presentation/features/chat/state/chatSlice'
import { emptyConversationContext } from '../fixtures/supportProgramConversation'
import { chatConversationDetailSchema } from '../models/ChatConversationDto'
import { supportPrograms } from '../fixtures/supportPrograms'

vi.unmock('../api/chatConversationApi')
const repository = new ChatConversationRepositoryImpl()
const email = 'member@test.local'
const summary = { id: 'saved', title: '서울 AI', version: 1, updatedAt: '2026-09-12T12:00:00.123456' }
function snapshot() {
  const store = createAppStore(); store.dispatch(interpretationStarted({ message: '서울 AI', context: emptyConversationContext }, 'saved'))
  return createChatConversationSnapshot(store.getState().chat)
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('대화 기록 Repository HTTP 계약', () => {
  it('삭제는 본인 세션으로 DELETE를 보내고 본문 없는 204를 처리한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(repository.delete(email, 'saved')).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[0][0]).toMatch(/chat-conversations\/saved$/)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE', credentials: 'include', cache: 'no-store',
      headers: { 'X-Chat-Account': encodeURIComponent(email) } })
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined()
  })
  it.each([401, 403, 500])('삭제 HTTP %s를 성공으로 처리하지 않는다', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })))
    await expect(repository.delete(email, 'saved')).rejects.toMatchObject({ status })
  })
  it('계정 확인 헤더·쿠키·페이지 커서를 전송하고 마이크로초 날짜를 검증한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [summary], nextCursor: 10 })))
    vi.stubGlobal('fetch', fetchMock)
    expect(await repository.list(email, 20)).toEqual({ items: [summary], nextCursor: 10 })
    expect(fetchMock.mock.calls[0][0]).toMatch(/chat-conversations\?before=20$/)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include', cache: 'no-store', headers: { 'X-Chat-Account': encodeURIComponent(email) } })
  })
  it.each([401, 409, 500])('HTTP %s를 정상 저장으로 숨기지 않는다', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })))
    await expect(repository.save(email, 'saved', 0, snapshot())).rejects.toMatchObject({ status })
  })
  it('잘못된 저장 형식은 전송 전에 거절하고 잘못된 상세 버전·원문 링크·식별자는 복원하지 않는다', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    await expect(repository.save(email, 'saved', 0, { ...snapshot(), messages: [] })).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(chatConversationDetailSchema.safeParse({ conversation: summary, snapshot: { ...snapshot(), schemaVersion: 2 } }).success).toBe(false)
    const broken = snapshot(); broken.messages = [...broken.messages, { id: 'answer', role: 'assistant', text: '결과', programs: [{ ...supportPrograms[0], sourceUrl: 'javascript:alert(1)' }] }]
    expect(chatConversationDetailSchema.safeParse({ conversation: summary, snapshot: broken }).success).toBe(false)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ conversation: summary, snapshot: snapshot() })))
    await expect(repository.get(email, 'another')).rejects.toThrow('다른 대화')
  })
  it('20초 시간 제한과 사용자 취소를 HTTP 요청에 연결한다', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const result = repository.list(email, null)
    const rejection = expect(result).rejects.toThrow('aborted')
    await vi.advanceTimersByTimeAsync(20_000); await rejection
    const controller = new AbortController()
    const second = repository.get(email, 'saved', controller.signal)
    controller.abort(); await expect(second).rejects.toThrow('aborted')
    expect(vi.getTimerCount()).toBe(0)
    expect(new ChatConversationApiError(409).status).toBe(409)
  })
})
