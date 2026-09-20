// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { Provider } from 'react-redux'
import { MemoryRouter, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { completeSearchResult } from './data/fixtures/supportProgramSearchResult'
import { appContainer } from './app/appContainer'
import { createAppStore, type AppStore } from './app/store'
import { partnerRecruitmentPage } from './data/fixtures/partnerRecruitments'
import { emptyConversationContext, readyConversationProposal, seoulConversationContext } from './data/fixtures/supportProgramConversation'
import { supportPrograms } from './data/fixtures/supportPrograms'
import {
  draftChanged,
  interpretationStarted,
  interpretationSucceeded,
  outcomeSeen,
  proposalConfirmed,
  searchStarted,
  searchSucceeded,
} from './presentation/features/chat/state/chatSlice'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({
  CoreApiConnectionStatus: () => null,
}))
vi.mock('./presentation/features/chat/hooks/useSupportProgramSearchReadiness', () => ({
  useSupportProgramSearchReadiness: () => ({
    canSearch: true, isError: false, isInitialLoading: false, isRefreshing: false, refetch: vi.fn(),
    data: { searchState: 'SEARCHABLE', programCount: 10, indexReady: true,
      lastSuccessfulSyncAt: null, lastFailedSyncAt: null, sources: [{ sourceCode: 'BIZINFO', sourceName: '기업마당',
        searchState: 'SEARCHABLE', programCount: 10, indexReady: true,
        lastSuccessfulSyncAt: null, lastFailedSyncAt: null }] },
  }),
}))

const originalMessage = '서울 AI 창업지원 사업 찾아줘'
const unsentDraft = '아직 보내지 않은 다음 조건'
const context = { ...seoulConversationContext, query: '서울 AI 창업지원 사업', acceptingOnly: false }
const program = supportPrograms[0]!

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  vi.spyOn(appContainer.resolve('browsePartnerRecruitmentsUseCase'), 'execute')
    .mockResolvedValue(partnerRecruitmentPage)
  vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(program)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('비로그인 대화의 화면 이동 수명', () => {
  it.each(['메뉴 링크', '브라우저 뒤로가기'] as const)('파트너 모집에서 %s로 돌아오면 대화·결과·조건·초안을 그대로 이어 보고 같은 맥락으로 다음 질문을 보낸다', async (returnMethod) => {
    const fetchMock = vi.fn().mockResolvedValue(json(readyConversationProposal(seoulConversationContext)))
    vi.stubGlobal('fetch', fetchMock)
    const store = seededConversationStore()
    const previous = store.getState().chat
    renderApp(store)
    expect(screen.getByText(originalMessage, { selector: 'div' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: program.title })).toBeTruthy()

    await act(async () => fireEvent.click(within(screen.getByRole('navigation', { name: '화면 이동' }))
      .getByRole('link', { name: '파트너 모집' })))

    // 비로그인 대화는 탭 세션 동안 남습니다. 결과를 이미 봤으므로 헤더 칩·알림은 없습니다.
    expect(screen.getByRole('heading', { name: '함께 신청할 기업 찾기' })).toBeTruthy()
    expect(store.getState().chat).toEqual(previous)
    expect(screen.queryByRole('status', { name: /진행 중|도착/ })).toBeNull()
    if (returnMethod === '메뉴 링크') {
      fireEvent.click(within(screen.getByRole('navigation', { name: '화면 이동' }))
        .getByRole('link', { name: '지원사업 찾기' }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: '브라우저 뒤로가기' }))
    }

    expect(screen.getByText(originalMessage, { selector: 'div' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: program.title })).toBeTruthy()
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement
    expect(input.value).toBe(unsentDraft)
    fireEvent.change(input, { target: { value: '수출 지원사업 찾아줘' } })
    await act(async () => fireEvent.submit(input.closest('form')!))
    expect(fetchMock).toHaveBeenCalledOnce()
    // 다음 질문은 이어 온 확정 조건과 최근 검색 요약을 함께 보냅니다.
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body))
    expect(body.message).toBe('수출 지원사업 찾아줘')
    expect(body.context.query).toBe(context.query)
    expect(body.lastSearch).toMatchObject({ resultCount: 1 })
  })

  it('로그인한 사용자는 파트너 모집에서 로고로 돌아오면 기존 대화·결과·조건·초안을 유지한다', async () => {
    const store = seededConversationStore(true)
    const previous = store.getState().chat
    renderApp(store, '/app/chat')
    await act(async () => fireEvent.click(within(screen.getByRole('complementary', { name: '작업 사이드바' }))
      .getByRole('link', { name: /파트너 관리/ })))
    expect(screen.getByRole('heading', { name: '파트너 관리' })).toBeTruthy()
    expect(store.getState().chat).toEqual(previous)
    fireEvent.click(within(screen.getByRole('complementary', { name: '작업 사이드바' }))
      .getByRole('link', { name: 'GovBiz' }))
    expect(store.getState().chat).toEqual(previous)
    expect(screen.getByText(originalMessage, { selector: 'div' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: program.title })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement).value).toBe(unsentDraft)
  })

  it('파트너 화면에서 지원사업 새검색을 누르면 로그인 상태를 유지하고 대화·결과·조건·초안을 지운다', () => {
    const store = seededConversationStore(true)
    const accountEmail = store.getState().chat.accountEmail
    renderApp(store, '/app/partners')
    fireEvent.click(screen.getByRole('button', { name: '지원사업 새검색' }))
    expectEmptyChatScreen()
    expect(store.getState().chat).toMatchObject({
      accountEmail, draft: '', confirmedSearch: null, conversationQuery: null,
      pendingClarification: null, searchOptions: { acceptingOnly: true },
    })
    expect(store.getState().chat.messages).toHaveLength(1)
    expect(store.getState().chat.searchOptions.companyConditions).toBeUndefined()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '지원사업 검색어' }))
  })

  it.each(['interpretation', 'search'] as const)('진행 중인 %s 요청을 남기고 다른 메뉴로 나가면 요청을 이어가고, 헤더 배지와 도착 알림으로 돌아올 수 있다', async (phase) => {
    let complete!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { complete = resolve })
    const fetchMock = vi.fn()
    if (phase === 'search') fetchMock.mockResolvedValueOnce(json(readyConversationProposal(context)))
    fetchMock.mockReturnValueOnce(pending)
    vi.stubGlobal('fetch', fetchMock)
    const store = emptyStore()
    renderApp(store)
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(input, { target: { value: originalMessage } })
    await act(async () => fireEvent.submit(input.closest('form')!))
    if (phase === 'search') {
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    }
    const signal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal
    expect(signal.aborted).toBe(false)

    await act(async () => fireEvent.click(within(screen.getByRole('navigation', { name: '화면 이동' }))
      .getByRole('link', { name: '파트너 모집' })))

    // 요청은 살아 있고 대화도 남아 있습니다. 검색은 헤더가 진행 중임을 알리고, 몇 초면 끝나는 조건 해석은 도착할 때만 알립니다.
    expect(signal.aborted).toBe(false)
    expect(store.getState().chat.messages.some((message) => message.text === originalMessage)).toBe(true)
    if (phase === 'search') expect(screen.getByRole('status', { name: '검색 진행 중' })).toBeTruthy()
    else expect(screen.queryByRole('status', { name: /진행 중/ })).toBeNull()
    expect(screen.queryByRole('status', { name: '검색 알림' })).toBeNull()

    await act(async () => {
      complete(json(phase === 'search' ? completeSearchResult({ query: context.query, programs: [program] })
        : readyConversationProposal(context)))
      await pending
    })

    // 결과가 도착하면 알림 한 줄과 헤더 배지가 바뀌고, 대화 보기로 돌아가면 결과가 보이며 알림이 사라집니다.
    const toast = screen.getByRole('status', { name: '검색 알림' })
    expect(within(toast).getByText(phase === 'search' ? '지원사업 검색이 끝났어요. 결과 1건이에요.' : '조건 변경안이 준비됐어요. 확인을 눌러야 검색이 시작돼요.')).toBeTruthy()
    expect(screen.getByRole('status', { name: '검색 결과 도착' })).toBeTruthy()
    expect(store.getState().chat.unseenOutcome).toBe(phase === 'search' ? 'search-succeeded' : 'interpretation-ready')

    await act(async () => fireEvent.click(within(toast).getByRole('link', { name: '대화 보기' })))
    expect(screen.queryByRole('status', { name: '검색 알림' })).toBeNull()
    expect(store.getState().chat.unseenOutcome).toBeNull()
    if (phase === 'search') expect(screen.getByRole('heading', { name: program.title })).toBeTruthy()
    else expect(screen.getByRole('button', { name: '이 조건으로 검색' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(phase === 'search' ? 2 : 1)

    // 결과를 본 뒤 다시 나가도 비로그인 대화는 탭 세션 동안 남아, 돌아오면 그대로 이어 봅니다.
    const seen = store.getState().chat
    await act(async () => fireEvent.click(within(screen.getByRole('navigation', { name: '화면 이동' }))
      .getByRole('link', { name: '파트너 모집' })))
    expect(store.getState().chat).toEqual(seen)
    expect(screen.queryByRole('status', { name: /진행 중|도착/ })).toBeNull()
    await act(async () => fireEvent.click(within(screen.getByRole('navigation', { name: '화면 이동' }))
      .getByRole('link', { name: '지원사업 찾기' })))
    if (phase === 'search') expect(screen.getByRole('heading', { name: program.title })).toBeTruthy()
    else expect(screen.getByRole('button', { name: '이 조건으로 검색' })).toBeTruthy()
  })

  it('로그인 사용자가 검색 중에 다른 메뉴로 가도 계정 위에 상태 패널을 표시하지 않고 검색과 결과 복귀를 유지한다', async () => {
    let complete!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { complete = resolve })
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input), 'http://localhost').pathname
      switch (path) {
        case '/api/v1/support-programs/conversation/interpret':
          return json(readyConversationProposal(context))
        case '/api/v1/support-programs/search':
          return pending
        case '/api/v1/me/saved-programs':
          return json({ programs: [] })
        default:
          throw new Error(`예상하지 않은 요청: ${path}`)
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = emptyStore(true)
    renderApp(store, '/app/chat')
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(input, { target: { value: originalMessage } })
    await act(async () => fireEvent.submit(input.closest('form')!))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))

    const sidebar = () => screen.getByRole('complementary', { name: '작업 사이드바' })
    expect(within(sidebar()).queryByRole('status', { name: '검색 상태' })).toBeNull()
    const signal = fetchMock.mock.calls.at(-1)![1]!.signal as AbortSignal
    await act(async () => fireEvent.click(within(sidebar()).getByRole('link', { name: /파트너 관리/ })))
    expect(within(sidebar()).queryByRole('status', { name: '검색 상태' })).toBeNull()
    expect(signal.aborted).toBe(false)
    expect(store.getState().chat.searchStatus).toBe('pending')

    await act(async () => {
      complete(json(completeSearchResult({ query: context.query, programs: [program] })))
      await pending
    })
    expect(within(sidebar()).queryByRole('status', { name: '검색 상태' })).toBeNull()
    expect(store.getState().chat.unseenOutcome).toBe('search-succeeded')
    expect(screen.getByRole('status', { name: '검색 알림' })).toBeTruthy()

    fireEvent.click(within(screen.getByRole('status', { name: '검색 알림' })).getByRole('button', { name: '닫기' }))
    expect(screen.queryByRole('status', { name: '검색 알림' })).toBeNull()
    // 도착 알림을 닫아도 기존 사이드바 링크로 돌아와 결과를 확인할 수 있습니다.
    await act(async () => fireEvent.click(within(sidebar()).getByRole('link', { name: 'GovBiz' })))
    expect(screen.getByRole('heading', { name: program.title })).toBeTruthy()
    expect(store.getState().chat.unseenOutcome).toBeNull()
    // 복귀 시 관심 상태는 조회하지만 조건 해석과 검색은 다시 실행하지 않습니다.
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input), 'http://localhost').pathname)).toEqual([
      '/api/v1/support-programs/conversation/interpret',
      '/api/v1/support-programs/search',
      '/api/v1/me/saved-programs',
    ])
    expect(screen.getByRole('button', { name: '관심 공고 저장' }).hasAttribute('disabled')).toBe(false)
    expect(within(sidebar()).queryByRole('status', { name: '검색 상태' })).toBeNull()
  })

  it('검색 중 다른 메뉴에서 새검색을 누르면 묻지 않고 검색 화면으로 가고, 검색 화면에서 다시 누르면 대화상자로 확인해 계속할 때만 검색을 끊는다', async () => {
    const pending = new Promise<Response>(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(readyConversationProposal(context))).mockReturnValueOnce(pending))
    const store = emptyStore(true)
    renderApp(store, '/app/chat')
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(input, { target: { value: originalMessage } })
    await act(async () => fireEvent.submit(input.closest('form')!))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    const sidebar = () => screen.getByRole('complementary', { name: '작업 사이드바' })
    await act(async () => fireEvent.click(within(sidebar()).getByRole('link', { name: /파트너 관리/ })))

    // 다른 메뉴에서는 필터 검색 탭도 써야 하므로 묻지 않고 검색 화면으로 갑니다. 진행 중인 대화는 그대로입니다.
    fireEvent.click(within(sidebar()).getByRole('button', { name: '지원사업 새검색' }))
    expect(screen.queryByRole('dialog', { name: '검색이 진행 중입니다' })).toBeNull()
    expect(screen.getByRole('tab', { name: '필터 검색' })).toBeTruthy()
    expect(store.getState().chat.searchStatus).toBe('pending')
    expect(store.getState().chat.messages.some((message) => message.role === 'user' && message.text === originalMessage)).toBe(true)

    fireEvent.click(within(sidebar()).getByRole('button', { name: '지원사업 새검색' }))
    const dialog = screen.getByRole('dialog', { name: '검색이 진행 중입니다' })
    expect(within(dialog).getByText('새 검색을 시작하면 진행 중인 검색이 취소되고 결과를 받지 못합니다. 계속할까요?')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }))
    expect(screen.queryByRole('dialog', { name: '검색이 진행 중입니다' })).toBeNull()
    expect(store.getState().chat.searchStatus).toBe('pending')
    expect(store.getState().chat.messages.some((message) => message.role === 'user' && message.text === originalMessage)).toBe(true)

    fireEvent.click(within(sidebar()).getByRole('button', { name: '지원사업 새검색' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '검색이 진행 중입니다' })).getByRole('button', { name: '계속' }))
    expect(screen.queryByRole('dialog', { name: '검색이 진행 중입니다' })).toBeNull()
    expectEmptyChatScreen()
    expect(store.getState().chat.searchStatus).toBe('idle')
    expect(within(sidebar()).queryByRole('status', { name: '검색 상태' })).toBeNull()
  })

  it('StrictMode에서 검색 화면을 마운트해도 같은 검색 흐름의 대화를 초기화하지 않는다', () => {
    const store = seededConversationStore()
    const previous = store.getState().chat
    renderApp(store, '/', true)
    expect(store.getState().chat).toEqual(previous)
    expect(screen.getByText(originalMessage, { selector: 'div' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: program.title })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement).value).toBe(unsentDraft)
  })

  it('공고 상세와 요금제를 거쳐 돌아와도 비로그인 대화·결과·초안을 유지한다', async () => {
    const store = seededConversationStore()
    const previous = store.getState().chat
    renderApp(store)
    await act(async () => fireEvent.click(screen.getByRole('link', { name: '상세 조건 보기' })))
    expect(screen.getByText('자격 미평가 · 공고 상세 정보')).toBeTruthy()
    expect(store.getState().chat).toEqual(previous)

    fireEvent.click(within(screen.getByRole('navigation', { name: '화면 이동' })).getByRole('link', { name: '요금제' }))
    expect(store.getState().chat).toEqual(previous)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '브라우저 뒤로가기' })))
    fireEvent.click(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }))
    expect(screen.getByRole('heading', { name: program.title })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement).value).toBe(unsentDraft)
    expect(store.getState().chat).toEqual(previous)
  })
})

function emptyStore(authenticated = false) {
  const store = createAppStore()
  store.dispatch(sessionRestored(authenticated
    ? { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null }
    : null))
  return store
}

function seededConversationStore(authenticated = false) {
  const store = emptyStore(authenticated)
  const interpreted = interpretationStarted({ message: originalMessage, context: emptyConversationContext, pendingClarification: null })
  store.dispatch(interpreted)
  store.dispatch(interpretationSucceeded({ requestId: interpreted.payload.requestId, result: readyConversationProposal(context) }))
  store.dispatch(proposalConfirmed(interpreted.payload.requestId))
  const searched = searchStarted(context.query, {
    acceptingOnly: context.acceptingOnly, companyConditions: store.getState().chat.searchOptions.companyConditions,
  }, interpreted.payload.messageId)
  store.dispatch(searched)
  store.dispatch(searchSucceeded(completeSearchResult({ requestId: searched.payload.requestId, programs: [program] })))
  // 이미 화면에서 본 대화를 흉내 냅니다. 보지 않은 결과가 있으면 비로그인 대화 초기화가 미뤄집니다.
  store.dispatch(outcomeSeen())
  store.dispatch(draftChanged(unsentDraft))
  return store
}

function renderApp(store: AppStore, path = '/', strict = false) {
  const tree = <Provider store={store}><MemoryRouter initialEntries={[path]}>
    <App /><BrowserHistoryControls />
  </MemoryRouter></Provider>
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}

function BrowserHistoryControls() {
  const navigate = useNavigate()
  return <button type="button" onClick={() => void navigate(-1)}>브라우저 뒤로가기</button>
}

function expectEmptyChatScreen() {
  expect((screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement).value).toBe('')
  expect(screen.queryByText(originalMessage, { selector: 'div' })).toBeNull()
  expect(screen.queryByRole('heading', { name: program.title })).toBeNull()
  expect(screen.queryByRole('button', { name: '새 검색' })).toBeNull()
  expect(screen.queryByRole('button', { name: '이 조건으로 검색' })).toBeNull()
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
}
