// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createAppStore } from './app/store'
import { appContainer } from './app/appContainer'
import type { ChatConversationDetail, ChatConversationSnapshot } from './domain/entities/ChatConversation'
import type { Account } from './domain/entities/Account'
import { readyConversationProposal, seoulConversationContext } from './data/fixtures/supportProgramConversation'
import { completeSearchResult } from './data/fixtures/supportProgramSearchResult'
import { supportPrograms } from './data/fixtures/supportPrograms'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'
import { interpretationStarted } from './presentation/features/chat/state/chatSlice'
import { emptyConversationContext } from './data/fixtures/supportProgramConversation'

// 공통 테스트 격리를 해제하고 실제 DI → Repository → HTTP DTO 검증 경로를 사용합니다.
vi.unmock('./data/api/chatConversationApi')
vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({ CoreApiConnectionStatus: () => null }))
vi.mock('./presentation/features/chat/hooks/useSupportProgramSearchReadiness', () => ({ useSupportProgramSearchReadiness: () => ({
  canSearch: true, isError: false, isInitialLoading: false, isRefreshing: false, refetch: vi.fn(),
  data: { searchState: 'SEARCHABLE', programCount: 10, indexReady: true, sources: [] },
}) }))

const account: Account = { email: 'member@test.local', tier: 'MEMBER', role: 'USER', emailVerified: true, hasPassword: true, company: null }
const records = new Map<string, Map<string, ChatConversationDetail>>()
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
let historyRequests: { email: string; url: string; method: string; body?: { expectedVersion: number; snapshot: ChatConversationSnapshot } }[]

beforeEach(() => {
  records.clear(); historyRequests = []
  vi.spyOn(appContainer.resolve('interpretSupportProgramConversationUseCase'), 'execute').mockResolvedValue(readyConversationProposal(seoulConversationContext))
  vi.spyOn(appContainer.resolve('searchSupportProgramsUseCase'), 'execute').mockResolvedValue(completeSearchResult({ query: '서울 AI', programs: [supportPrograms[0]] }))
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    if (!input.includes('/api/v1/me/chat-conversations')) return new Promise<Response>(() => {})
    expect(init.credentials).toBe('include'); expect(init.cache).toBe('no-store')
    const email = decodeURIComponent(new Headers(init.headers).get('X-Chat-Account')!)
    const url = new URL(input, 'http://localhost')
    const id = decodeURIComponent(url.pathname.split('/').at(-1)!)
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    historyRequests.push({ email, url: url.pathname, method: init.method!, body })
    const mine = records.get(email) ?? new Map<string, ChatConversationDetail>(); records.set(email, mine)
    if (init.method === 'DELETE') { mine.delete(id); return new Response(null, { status: 204 }) }
    if (init.method === 'PUT') {
      const current = mine.get(id)
      if ((current?.conversation.version ?? 0) !== body.expectedVersion) return json({}, 409)
      const detail = { conversation: { id, title: body.snapshot.messages.find((message: { role: string }) => message.role === 'user').text,
        version: body.expectedVersion + 1, updatedAt: '2026-09-12T12:00:00' }, snapshot: body.snapshot }
      mine.set(id, detail); return json(detail.conversation)
    }
    if (id === 'chat-conversations') return json({ items: [...mine.values()].reverse().map((entry) => entry.conversation), nextCursor: null })
    return mine.has(id) ? json(mine.get(id)) : json({}, 404)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function renderChat(owner: Account | null = account, path = owner ? '/app/chat' : '/') {
  const store = createAppStore(); store.dispatch(sessionRestored(owner))
  const view = render(<Provider store={store}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></Provider>)
  return { ...view, store }
}
async function submit(text: string) {
  const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
  await act(async () => { fireEvent.change(input, { target: { value: text } }); fireEvent.submit(input.closest('form')!) })
}

describe('사이드바 대화 기록 HTTP 통합', () => {
  it('대화한 적이 없는 로그인 계정은 조회 후 빈 기록 안내만 표시한다', async () => {
    renderChat()
    const history = screen.getByRole('region', { name: '대화 기록' })
    expect(await within(history).findByText('대화를 시작하면 여기에 저장됩니다.')).toBeTruthy()
    expect(historyRequests).toHaveLength(1)
    expect(within(history).queryByRole('alert')).toBeNull()
    expect(within(history).queryByRole('button', { name: '기록 다시 불러오기' })).toBeNull()
    expect(within(history).queryByRole('button', { name: /^대화 열기:/ })).toBeNull()
  })

  it('실제 기록 조회 실패는 빈 기록과 구분하고 재조회 성공 후 빈 안내로 바뀐다', async () => {
    const fetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) =>
      input.includes('/api/v1/me/chat-conversations') ? json({}, 503) : fetch(input, init)))
    renderChat()
    const history = screen.getByRole('region', { name: '대화 기록' })
    expect(await within(history).findByRole('alert')).toHaveProperty('textContent', '대화 기록을 불러오지 못했습니다. 다시 시도해 주세요.')
    expect(within(history).queryByText('대화를 시작하면 여기에 저장됩니다.')).toBeNull()
    vi.stubGlobal('fetch', fetch)
    fireEvent.click(within(history).getByRole('button', { name: '기록 다시 불러오기' }))
    expect(await within(history).findByText('대화를 시작하면 여기에 저장됩니다.')).toBeTruthy()
    expect(within(history).queryByRole('alert')).toBeNull()
    expect(within(history).queryByRole('button', { name: '기록 다시 불러오기' })).toBeNull()
  })

  it('삭제 취소 시 보존하고 확인하면 현재 대화를 비우며 새 세션에서도 삭제 상태를 유지한다', async () => {
    const view = renderChat()
    await submit('삭제할 서울 지원사업')
    await waitFor(() => expect([...records.get(account.email)!.values()][0].snapshot.interpretation.status).toBe('ready'))
    const remove = screen.getByRole('button', { name: '대화 삭제: 삭제할 서울 지원사업' })
    fireEvent.click(remove)
    // 브라우저 confirm이 아니라 앱 안 대화상자로 묻고, 취소하면 아무것도 지우지 않습니다.
    const dialog = screen.getByRole('dialog', { name: '대화를 삭제할까요?' })
    expect(within(dialog).getByText(/“삭제할 서울 지원사업” 대화의 질문·답변·검색 결과가 삭제되며 복구할 수 없습니다/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }))
    expect(screen.queryByRole('dialog', { name: '대화를 삭제할까요?' })).toBeNull()
    expect(historyRequests.filter((request) => request.method === 'DELETE')).toHaveLength(0)
    expect(screen.getByRole('button', { name: '대화 열기: 삭제할 서울 지원사업' })).toBeTruthy()
    fireEvent.click(remove)
    await act(async () => fireEvent.click(within(screen.getByRole('dialog', { name: '대화를 삭제할까요?' })).getByRole('button', { name: '삭제' })))
    expect(screen.queryByRole('dialog', { name: '대화를 삭제할까요?' })).toBeNull()
    expect(historyRequests.filter((request) => request.method === 'DELETE')).toHaveLength(1)
    expect(records.get(account.email)?.size).toBe(0)
    expect(screen.queryByRole('button', { name: /^대화 열기:/ })).toBeNull()
    expect(view.store.getState().chat.messages).toHaveLength(1)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '지원사업 새검색' }))
    expect(appContainer.resolve('interpretSupportProgramConversationUseCase').execute).toHaveBeenCalledOnce()
    view.unmount()
    renderChat()
    await waitFor(() => expect(screen.getByText('대화를 시작하면 여기에 저장됩니다.')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^대화 열기:/ })).toBeNull()
  })

  it('다른 기록을 삭제해도 현재 대화는 그대로 유지한다', async () => {
    const view = renderChat()
    await submit('이전 질문')
    await waitFor(() => expect([...records.get(account.email)!.values()][0].snapshot.interpretation.status).toBe('ready'))
    fireEvent.click(screen.getByRole('button', { name: '지원사업 새검색' }))
    await submit('현재 질문')
    await waitFor(() => expect([...records.get(account.email)!.values()].every((entry) => entry.snapshot.interpretation.status === 'ready')).toBe(true))
    const before = view.store.getState().chat
    fireEvent.click(screen.getByRole('button', { name: '대화 삭제: 이전 질문' }))
    await act(async () => fireEvent.click(within(screen.getByRole('dialog', { name: '대화를 삭제할까요?' })).getByRole('button', { name: '삭제' })))
    expect(screen.queryByRole('button', { name: '대화 열기: 이전 질문' })).toBeNull()
    expect(screen.getByRole('button', { name: '대화 열기: 현재 질문' })).toBeTruthy()
    expect(view.store.getState().chat).toBe(before)
  })

  it('삭제 중 버튼을 잠그고 실패 안내 후 같은 버튼으로 재시도할 수 있다', async () => {
    renderChat()
    const confirmDelete = () => fireEvent.click(within(screen.getByRole('dialog', { name: '대화를 삭제할까요?' })).getByRole('button', { name: '삭제' }))
    await submit('삭제 재시도')
    await waitFor(() => expect([...records.get(account.email)!.values()][0].snapshot.interpretation.status).toBe('ready'))
    const fetch = globalThis.fetch
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((input, init) => init?.method === 'DELETE'
      ? new Promise<Response>((resolve) => { finish = resolve }) : fetch(input, init)))
    fireEvent.click(screen.getByRole('button', { name: '대화 삭제: 삭제 재시도' }))
    confirmDelete()
    expect((screen.getByRole('button', { name: '대화 삭제: 삭제 재시도' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('대화 삭제 중…')).toBeTruthy()
    await act(async () => finish(json({}, 500)))
    expect(screen.getByText(/대화 삭제를 확인하지 못했습니다/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '대화 열기: 삭제 재시도' })).toBeTruthy()
    vi.stubGlobal('fetch', fetch)
    fireEvent.click(screen.getByRole('button', { name: '대화 삭제: 삭제 재시도' }))
    await act(async () => confirmDelete())
    expect(screen.queryByRole('button', { name: '대화 열기: 삭제 재시도' })).toBeNull()
    expect(screen.queryByText(/대화 삭제를 확인하지 못했습니다/)).toBeNull()
  })

  it('요금제 아래 대화 단위로 쌓이고 새 대화·필터 이동 후 클릭으로 복원하며 AI를 다시 호출하지 않는다', async () => {
    renderChat()
    await waitFor(() => expect(historyRequests).toHaveLength(1))
    await submit('서울 창업지원 찾아줘')
    const history = screen.getByRole('region', { name: '대화 기록' })
    const pricing = screen.getByRole('link', { name: '요금제' })
    expect(pricing.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    await waitFor(() => expect([...records.get(account.email)!.values()][0].snapshot.interpretation.status).toBe('ready'))
    expect(within(history).getAllByRole('button', { name: /^대화 열기:/ })).toHaveLength(1)
    await submit('지원 목적도 알려줘')
    expect(within(history).getAllByRole('button', { name: /^대화 열기:/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '지원사업 새검색' }))
    expect(within(history).getAllByRole('button', { name: /^대화 열기:/ })).toHaveLength(1)
    await submit('부산 제조기업 지원')
    expect(within(history).getAllByRole('button', { name: /^대화 열기:/ })).toHaveLength(2)
    fireEvent.click(screen.getByRole('tab', { name: '필터 검색' }))
    await act(async () => fireEvent.click(within(history).getByRole('button', { name: '대화 열기: 서울 창업지원 찾아줘' })))
    expect(screen.getByRole('tab', { name: 'AI 대화 검색' }).getAttribute('aria-selected')).toBe('true')
    expect(within(screen.getByRole('region', { name: '대화 내역' })).getByText('지원 목적도 알려줘')).toBeTruthy()
    expect(screen.getByRole('region', { name: '조건 변경 제안' })).toBeTruthy()
    expect(appContainer.resolve('interpretSupportProgramConversationUseCase').execute).toHaveBeenCalledTimes(3)
    expect(appContainer.resolve('searchSupportProgramsUseCase').execute).not.toHaveBeenCalled()
  })

  it('검색 중에 다른 대화를 열면 앱 안 대화상자로 확인하고, 취소하면 검색을 유지하며, 계속하면 검색을 끊고 그 대화를 연다', async () => {
    const view = renderChat()
    await submit('이전 질문')
    await waitFor(() => expect([...records.get(account.email)!.values()][0].snapshot.interpretation.status).toBe('ready'))
    fireEvent.click(screen.getByRole('button', { name: '지원사업 새검색' }))
    // 두 번째 질문의 조건 해석은 끝나지 않은 채로 둡니다.
    vi.mocked(appContainer.resolve('interpretSupportProgramConversationUseCase').execute).mockReturnValue(new Promise(() => {}))
    await submit('진행 중 질문')
    expect(view.store.getState().chat.interpretation.status).toBe('pending')
    // 진행 중인 대화의 기록 항목에는 조건 해석 중에도 점이 붙고(패널은 해석 중을 건너뜀), 버튼 이름은 그대로입니다.
    expect(screen.getByRole('button', { name: '대화 열기: 진행 중 질문' }).querySelector('[data-activity="pending"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: '대화 열기: 이전 질문' }).querySelector('[data-activity]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '대화 열기: 이전 질문' }))
    const dialog = screen.getByRole('dialog', { name: '검색이 진행 중입니다' })
    expect(within(dialog).getByText('다른 대화를 열면 진행 중인 검색이 취소되고 결과를 받지 못합니다. 계속할까요?')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }))
    expect(screen.queryByRole('dialog', { name: '검색이 진행 중입니다' })).toBeNull()
    expect(view.store.getState().chat.interpretation.status).toBe('pending')
    expect(within(screen.getByRole('region', { name: '대화 내역' })).getByText('진행 중 질문')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '대화 열기: 이전 질문' }))
    await act(async () => fireEvent.click(within(screen.getByRole('dialog', { name: '검색이 진행 중입니다' })).getByRole('button', { name: '계속' })))
    expect(screen.queryByRole('dialog', { name: '검색이 진행 중입니다' })).toBeNull()
    expect(within(screen.getByRole('region', { name: '대화 내역' })).getByText('이전 질문')).toBeTruthy()
    expect(view.store.getState().chat.interpretation.status).not.toBe('pending')
    // 떠난 대화는 '완료되지 않은 검색'이 아니라 취소된 상태로 저장됩니다.
    await waitFor(() => expect([...records.get(account.email)!.values()].find((entry) => entry.conversation.title === '진행 중 질문')?.snapshot.interpretation.status).toBe('idle'))
  })

  it('새 브라우저 상태·재로그인에서 저장된 결과와 조건을 복원하고 다른 계정은 빈 목록을 본다', async () => {
    const first = renderChat()
    await submit('서울 AI 사업 찾아줘')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    await waitFor(() => expect([...records.get(account.email)!.values()][0].snapshot.messages.at(-1)?.programs).toHaveLength(1))
    const saved = [...records.get(account.email)!.values()][0]
    first.unmount()
    const restored = renderChat()
    const link = await screen.findByRole('button', { name: '대화 열기: 서울 AI 사업 찾아줘' })
    await act(async () => fireEvent.click(link))
    expect(restored.store.getState().chat.messages).toEqual(saved.snapshot.messages)
    expect(restored.store.getState().chat.searchOptions).toEqual(saved.snapshot.searchOptions)
    expect(screen.getByText(supportPrograms[0].title)).toBeTruthy()
    expect(appContainer.resolve('searchSupportProgramsUseCase').execute).toHaveBeenCalledOnce()
    expect(appContainer.resolve('interpretSupportProgramConversationUseCase').execute).toHaveBeenCalledOnce()
    const puts = historyRequests.filter((request) => request.method === 'PUT').length
    await act(async () => {})
    expect(historyRequests.filter((request) => request.method === 'PUT')).toHaveLength(puts)
    restored.unmount()
    renderChat({ ...account, email: 'other@test.local' })
    await waitFor(() => expect(historyRequests.at(-1)?.email).toBe('other@test.local'))
    expect(screen.queryByRole('button', { name: '대화 열기: 서울 AI 사업 찾아줘' })).toBeNull()
  })

  it('비로그인 대화는 목록도 보이지 않고 저장 API도 호출하지 않는다', async () => {
    renderChat(null)
    await submit('비회원 서울 AI 질문')
    expect(screen.queryByRole('region', { name: '대화 기록' })).toBeNull()
    expect(historyRequests).toEqual([])
    expect(records.size).toBe(0)
  })

  it('중단된 대화를 새 세션에서 열면 로딩 대신 명시적인 재시도 버튼을 제공한다', async () => {
    const first = renderChat()
    act(() => first.store.dispatch(interpretationStarted({ message: '중단된 질문', context: emptyConversationContext }, 'interrupted')))
    await waitFor(() => expect(records.get(account.email)?.get('interrupted')?.snapshot.interpretation.status).toBe('failed'))
    first.unmount()
    renderChat()
    const historyButton = await screen.findByRole('button', { name: '대화 열기: 중단된 질문' })
    await act(async () => fireEvent.click(historyButton))
    expect(screen.getByRole('button', { name: '다시 해석' })).toBeTruthy()
    expect(appContainer.resolve('interpretSupportProgramConversationUseCase').execute).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '다시 해석' })))
    expect(appContainer.resolve('interpretSupportProgramConversationUseCase').execute).toHaveBeenCalledOnce()
    expect(screen.getByRole('region', { name: '조건 변경 제안' })).toBeTruthy()
  })

  it('대화 조회 중 다른 메뉴로 이동하면 늦은 응답이 채팅으로 되돌리지 않는다', async () => {
    const first = renderChat()
    await submit('이전 기록')
    await waitFor(() => expect(records.get(account.email)?.size).toBe(1))
    const saved = [...records.get(account.email)!.values()][0]
    first.unmount()
    const fetch = globalThis.fetch
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((input, init) => String(input).endsWith(`/${saved.conversation.id}`) && init?.method === 'GET'
      ? new Promise<Response>((resolve) => { finish = resolve }) : fetch(input, init)))
    const second = renderChat()
    fireEvent.click(await screen.findByRole('button', { name: '대화 열기: 이전 기록' }))
    await waitFor(() => expect(finish).toBeTruthy())
    fireEvent.click(screen.getByRole('link', { name: '요금제' }))
    await act(async () => finish(json(saved)))
    expect(screen.queryByRole('tab', { name: 'AI 대화 검색' })).toBeNull()
    expect(second.store.getState().chat.messages).toHaveLength(1)
  })
})
