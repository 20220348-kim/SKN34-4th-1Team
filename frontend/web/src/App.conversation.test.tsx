// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { completeSearchResult } from './data/fixtures/supportProgramSearchResult'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import { sessionRestored, signedIn } from './presentation/shared/auth/state/authSlice'
import { emptyConversationContext, readyConversationProposal, seoulConversationContext } from './data/fixtures/supportProgramConversation'
import type { SupportProgramInterpretation } from './domain/entities/SupportProgramConversation'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({ CoreApiConnectionStatus: () => null }))
const readiness = vi.hoisted(() => ({ canSearch: true }))
vi.mock('./presentation/features/chat/hooks/useSupportProgramSearchReadiness', () => ({
  useSupportProgramSearchReadiness: () => ({
    canSearch: readiness.canSearch, isError: false, isInitialLoading: false, isRefreshing: false, refetch: vi.fn(),
    data: { searchState: readiness.canSearch ? 'SEARCHABLE' : 'UNAVAILABLE', programCount: 10, indexReady: readiness.canSearch,
      lastSuccessfulSyncAt: null, lastFailedSyncAt: null, sources: [{ sourceCode: 'BIZINFO', sourceName: '기업마당',
        searchState: readiness.canSearch ? 'SEARCHABLE' : 'UNAVAILABLE', programCount: 10, indexReady: readiness.canSearch,
        lastSuccessfulSyncAt: null, lastFailedSyncAt: null }] },
  }),
}))

beforeEach(() => { readiness.canSearch = true })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('대화 조건 해석·확인 검색 HTTP E2E', () => {
  it.each(['/', '/app/chat'])('%s에서 후속 메시지를 입력해도 기존 조건 카드를 유지하고 새 해석에 전달한다', async (path) => {
    const seoul = { ...emptyConversationContext, query: 'AI 창업지원',
      companyConditions: { ...emptyConversationContext.companyConditions, region: '서울', industry: 'AI', supportPurpose: '창업' } }
    const busan = { ...seoul, companyConditions: { ...seoul.companyConditions, region: '부산' } }
    const network = mockConversationNetwork([readyConversationProposal(seoul), readyConversationProposal(busan)])
    const { store } = renderConversationApp(path)
    await submitMessage('서울 AI 창업지원 사업 찾아줘')
    const proposal = screen.getByRole('region', { name: '조건 변경 제안' })
    const interpretation = store.getState().chat.interpretation
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement
    const confirm = within(proposal).getByRole('button', { name: '이 조건으로 검색' }) as HTMLButtonElement

    fireEvent.change(input, { target: { value: '부산으로 바꿔줘' } })
    expect(screen.getByRole('region', { name: '조건 변경 제안' })).toBe(proposal)
    expect(within(proposal).getByText('현재 소재지: 서울')).toBeTruthy()
    expect(within(proposal).getByText('업종: AI')).toBeTruthy()
    expect(store.getState().chat.interpretation).toBe(interpretation)
    expect(store.getState().chat.pendingProposal).toEqual(seoul)
    expect(store.getState().chat.conversationQuery).toBeNull()
    expect(confirm.disabled).toBe(true)
    expect(within(proposal).getByText(/작성 중인 메시지를 전송/)).toBeTruthy()
    fireEvent.click(confirm)
    expect(network.fetch).toHaveBeenCalledOnce()

    fireEvent.change(input, { target: { value: ' ' } })
    expect(screen.getByRole('region', { name: '조건 변경 제안' })).toBe(proposal)
    expect(confirm.disabled).toBe(false)
    expect(network.fetch).toHaveBeenCalledOnce()

    await submitMessage('부산으로 바꿔줘')
    expect(network.interpretRequests[1]).toMatchObject({
      message: '부산으로 바꿔줘', context: emptyConversationContext, pendingProposal: seoul,
    })
    const updated = screen.getByRole('region', { name: '조건 변경 제안' })
    expect(within(updated).getByText('현재 소재지: 부산')).toBeTruthy()
    expect(within(updated).getByText('업종: AI')).toBeTruthy()
    expect(network.searchRequests).toHaveLength(0)
    await act(async () => fireEvent.click(within(updated).getByRole('button', { name: '이 조건으로 검색' })))
    expect(network.searchRequests).toEqual([{ query: 'AI 창업지원', acceptingOnly: true,
      companyConditions: { region: '부산', industry: 'AI', supportPurpose: '창업' } }])
  })

  it.each([false, true])('로그아웃 후 다른 계정으로 로그인해도 이전 대화·조건·초안이 남지 않는다 (로그아웃 API 실패: %s)', async (logoutFails) => {
    const logout = vi.spyOn(appContainer.resolve('logOutUseCase'), 'execute')
    if (logoutFails) logout.mockRejectedValue(new Error('logout unavailable'))
    else logout.mockResolvedValue(undefined)
    mockConversationNetwork([readyConversationProposal(seoulConversationContext)])
    const { store } = renderConversationApp('/app/chat')
    const privateMessage = '서울 SW 사업화 지원을 찾는 이전 계정의 대화'
    await submitMessage(privateMessage)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    expect(store.getState().chat.messages).toHaveLength(3)
    expect(within(screen.getByRole('region', { name: '대화 내역' })).getByText(privateMessage)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '지원사업 검색어' }), { target: { value: '아직 보내지 않은 개인 초안' } })

    const sidebar = screen.getByRole('complementary', { name: '작업 사이드바' })
    fireEvent.click(within(sidebar).getByRole('button', { name: /계정 메뉴/ }))
    fireEvent.click(within(sidebar).getByRole('button', { name: '로그아웃' }))

    await waitFor(() => expect(screen.queryByRole('complementary', { name: '작업 사이드바' })).toBeNull())
    expect(screen.queryByRole('form', { name: '로그인' })).toBeNull()
    expect(logout).toHaveBeenCalledOnce()
    expect(store.getState().chat).toMatchObject({
      draft: '', confirmedSearch: null, conversationQuery: null, pendingClarification: null,
      interpretation: { status: 'idle' }, searchOptions: { acceptingOnly: true },
    })
    expect(store.getState().chat.messages).toHaveLength(1)
    act(() => store.dispatch(signedIn({ email: 'other@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null })))
    const input = await screen.findByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement
    expect(input.value).toBe('')
    expect(screen.queryByText(privateMessage)).toBeNull()
    expect(screen.queryByRole('button', { name: '새 검색' })).toBeNull()
    expect(store.getState().chat.messages).toHaveLength(1)
  })

  it.each(['/', '/app/chat'])('%s에서 비회원은 보조 패널, 회원은 작업 사이드바의 대화 초기화를 사용한다', async (path) => {
    const network = mockConversationNetwork([readyConversationProposal(seoulConversationContext)])
    renderConversationApp(path)
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
    expect(screen.queryByRole('button', { name: '새 검색' })).toBeNull()

    fireEvent.change(input, { target: { value: '서울 AI 창업지원 사업 찾아줘' } })
    expect(screen.queryByRole('button', { name: '새 검색' })).toBeNull()
    expect(network.fetch).not.toHaveBeenCalled()

    await submitMessage('서울 AI 창업지원 사업 찾아줘')
    expect(screen.queryByRole('button', { name: '새 검색' })).toBeNull()
    if (path === '/') {
      expect(screen.queryByRole('complementary', { name: '검색 사이드바' })).toBeNull()
      expect(within(screen.getByRole('complementary', { name: 'AI 대화 도구' }))
        .getByRole('button', { name: '새 AI 대화 검색' })).toBeTruthy()
    } else {
      expect(within(screen.getByRole('complementary', { name: '작업 사이드바' }))
        .getByRole('button', { name: '지원사업 새검색' })).toBeTruthy()
    }
    expect(network.fetch).toHaveBeenCalledOnce()
  })

  it.each([
    { path: '/', phase: 'interpretation' },
    { path: '/', phase: 'search' },
    { path: '/app/chat', phase: 'interpretation' },
    { path: '/app/chat', phase: 'search' },
  ] as const)('$path에서 $phase 중 취소 클릭은 요청을 다시 제출하지 않고 입력을 복원하며 늦은 응답을 무시한다', async ({ path, phase }) => {
    let complete!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { complete = resolve })
    const fetchMock = vi.fn()
    if (phase === 'search') fetchMock.mockResolvedValueOnce(json(readyConversationProposal(seoulConversationContext)))
    fetchMock.mockReturnValueOnce(pending)
    vi.stubGlobal('fetch', fetchMock)
    const { store } = renderConversationApp(path)
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement
    const message = '서울 AI 창업지원 사업 찾아줘'
    fireEvent.change(input, { target: { value: message } })
    await act(async () => fireEvent.submit(input.closest('form')!))
    if (phase === 'search') {
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    }

    const requestSignal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal
    const requestCount = phase === 'search' ? 2 : 1
    const cancelButton = screen.getByRole('button', { name: '취소' })
    expect(requestSignal.aborted).toBe(false)
    // 폼 제출 기본 동작도 실행해 취소 버튼이 전송 버튼으로 재사용되는 회귀를 확인합니다.
    act(() => cancelButton.click())

    expect(requestSignal.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(requestCount)
    expect(screen.queryByRole('button', { name: '취소' })).toBeNull()
    const submitButton = screen.getByRole('button', { name: '검색 전송' }) as HTMLButtonElement
    expect(submitButton).not.toBe(cancelButton)
    expect(submitButton.disabled).toBe(false)
    expect(input.disabled).toBe(false)
    expect(input.value).toBe(phase === 'search' ? seoulConversationContext.query : message)
    expect(document.activeElement).toBe(input)
    expect(screen.queryByText(/조건 변경안을 해석하고 있어요|공고를 찾아보고 있어요/)).toBeNull()
    expect(screen.queryByRole('button', { name: '다시 검색' })).toBeNull()
    const cancelledState = store.getState().chat
    expect(cancelledState.searchStatus).toBe('idle')
    expect(cancelledState.interpretation.status).toBe('idle')
    expect(cancelledState.messages).toHaveLength(2)
    expect(cancelledState.confirmedSearch).toEqual(phase === 'search'
      ? { query: seoulConversationContext.query, acceptingOnly: true,
        companyConditions: seoulConversationContext.companyConditions }
      : null)

    await act(async () => {
      complete(json(phase === 'search' ? completeSearchResult({ query: seoulConversationContext.query, programs: [] })
        : readyConversationProposal(seoulConversationContext)))
      await pending
    })
    expect(store.getState().chat).toEqual(cancelledState)
    expect(screen.queryByRole('button', { name: '이 조건으로 검색' })).toBeNull()
    expect(screen.queryByRole('button', { name: '취소' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(requestCount)
  })

  it.each(['/', '/app/chat'])('%s에서 대화 초기화 버튼은 대화와 조건을 초기화하고 다음 메시지를 빈 맥락으로 보낸다', async (path) => {
    const context = { ...seoulConversationContext, acceptingOnly: false }
    const next = { ...emptyConversationContext, query: '수출 지원' }
    const network = mockConversationNetwork([readyConversationProposal(context), readyConversationProposal(next)])
    const { store } = renderConversationApp(path)
    expect(screen.queryByText(/적용 중인 조건:/)).toBeNull()
    expect(screen.queryByRole('button', { name: '새 검색' })).toBeNull()
    await submitMessage('서울 SW 사업화, 마감 공고도 포함해 줘')
    expect(screen.queryByText(/적용 중인 조건:/)).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    expect(screen.getByText('적용 중인 조건: 접수 상태: 전체 · 현재 소재지: 서울 · 업종: SW · 설립일: 2024-01-01 · 지원 목적: 사업화')).toBeTruthy()
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
    expect(input.getAttribute('aria-describedby')).toContain('support-program-current-conditions')
    fireEvent.click(screen.getByRole('button', { name: path === '/' ? '새 AI 대화 검색' : '지원사업 새검색' }))
    expect(store.getState().chat.conversationQuery).toBeNull()
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true })
    expect(store.getState().chat.confirmedSearch).toBeNull()
    expect(store.getState().chat.messages).toHaveLength(1)
    expect(screen.queryByText(/적용 중인 조건:|검색 당시 조건:/)).toBeNull()
    expect(document.activeElement).toBe(input)
    expect(network.fetch).toHaveBeenCalledTimes(2)
    await submitMessage('수출 지원 찾아줘')
    expect(network.interpretRequests[1]).toEqual({ message: '수출 지원 찾아줘',
      context: emptyConversationContext, pendingClarification: null })
    expect(network.searchRequests).toHaveLength(1)
  })

  it.each([
    { path: '/', phase: 'interpretation' },
    { path: '/', phase: 'search' },
    { path: '/app/chat', phase: 'interpretation' },
    { path: '/app/chat', phase: 'search' },
  ] as const)('$path의 새 채팅은 진행 중 $phase 요청을 취소하고 늦은 응답을 무시한다', async ({ path, phase }) => {
    let complete!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { complete = resolve })
    const fetchMock = vi.fn()
    if (phase === 'search') fetchMock.mockResolvedValueOnce(json(readyConversationProposal(seoulConversationContext)))
    fetchMock.mockReturnValueOnce(pending)
    vi.stubGlobal('fetch', fetchMock)
    const { store } = renderConversationApp(path)
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(input, { target: { value: '서울 SW 사업화' } })
    await act(async () => fireEvent.submit(input.closest('form')!))
    if (phase === 'search') {
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    }
    const requestSignal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal
    expect(requestSignal.aborted).toBe(false)
    readiness.canSearch = false
    fireEvent.click(screen.getByRole('button', { name: path === '/' ? '새 AI 대화 검색' : '지원사업 새검색' }))
    if (path === '/app/chat') {
      // 검색 화면에서 진행 중에 사이드바 새검색을 누르면 확인 대화상자를 거쳐서만 끊습니다. 비로그인 메인의 새 대화는 바로 끊습니다.
      expect(requestSignal.aborted).toBe(false)
      fireEvent.click(within(screen.getByRole('dialog', { name: '검색이 진행 중입니다' })).getByRole('button', { name: '계속' }))
    }
    expect(requestSignal.aborted).toBe(true)
    expect(document.activeElement).toBe(input)
    expect((input as HTMLTextAreaElement).disabled).toBe(false)
    const resetState = store.getState().chat
    expect(resetState.searchOptions).toEqual({ acceptingOnly: true })
    expect(resetState.confirmedSearch).toBeNull()
    expect(resetState.pendingClarification).toBeNull()
    expect(resetState.messages).toHaveLength(1)
    await act(async () => {
      complete(json(phase === 'search' ? completeSearchResult({ query: seoulConversationContext.query, programs: [] })
        : readyConversationProposal(seoulConversationContext)))
      await pending
    })
    expect(store.getState().chat).toEqual(resetState)
    expect(screen.queryByRole('button', { name: '이 조건으로 검색' })).toBeNull()
    expect(screen.queryByText(/적용 중인 조건:|검색 당시 조건:/)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(phase === 'search' ? 2 : 1)
  })

  it.each(['READY', 'CLARIFICATION_REQUIRED'] as const)('새 채팅 버튼은 %s 제안과 미확정 초안도 초기화한다', async (status) => {
    const proposal: SupportProgramInterpretation = status === 'READY'
      ? readyConversationProposal(seoulConversationContext)
      : { status, proposedContext: seoulConversationContext, clarificationQuestion: '지원 목적을 알려주세요.', changedFields: [] }
    const network = mockConversationNetwork([proposal])
    const { store } = renderConversationApp()
    await submitMessage('서울 SW 사업화')
    fireEvent.click(screen.getByRole('button', { name: '새 AI 대화 검색' }))
    expect(store.getState().chat.interpretation).toEqual({ status: 'idle' })
    expect(store.getState().chat.pendingClarification).toBeNull()
    expect(store.getState().chat.messages).toHaveLength(1)
    expect(screen.queryByRole('region', { name: '조건 변경 제안' })).toBeNull()
    expect(screen.queryByRole('region', { name: '조건 추가 확인' })).toBeNull()
    expect(network.searchRequests).toHaveLength(0)
    expect(network.fetch).toHaveBeenCalledOnce()
  })

  it('검색어만 제안하면 접수 범위를 짧게 안내하고 미입력 기업 조건은 상세에도 나열하지 않는다', async () => {
    const context = { ...emptyConversationContext, query: '제조기업 R&D 사업' }
    const network = mockConversationNetwork([readyConversationProposal(context)])
    const { store } = renderConversationApp()
    await submitMessage('제조기업 R&D 사업 찾아줘')

    const proposal = screen.getByRole('region', { name: '조건 변경 제안' })
    const card = within(proposal)
    expect(card.getByRole('heading', { name: context.query })).toBeTruthy()
    expect(card.getByText('이렇게 찾아볼게요')).toBeTruthy()
    expect(card.getByText('접수 중만', { selector: 'span' })).toBeTruthy()
    expect(card.getByText('접수 중인 공고에서 관련 지원사업을 찾아볼게요.')).toBeTruthy()
    expect(card.getByRole('button', { name: '이 조건으로 검색' })).toBeTruthy()
    expect(card.getByRole('button', { name: '제안 취소' })).toBeTruthy()
    expect(proposal.textContent).not.toMatch(/미입력|현재:|제안:|변경 전·후|해석과 검색은 각각|나머지 조건/)
    expect(proposal.textContent).not.toMatch(/현재 소재지|업종|설립일|지원 목적/)
    const details = card.getByText('검색 조건 자세히').closest('details')!
    expect(details.open).toBe(false)
    expect(proposalDetailEntries(details)).toEqual([['검색어', context.query], ['접수 상태', '접수 중만']])
    expect(network.searchRequests).toHaveLength(0)
    expect(store.getState().chat.conversationQuery).toBeNull()
    await act(async () => fireEvent.click(card.getByRole('button', { name: '이 조건으로 검색' })))
    expect(network.searchRequests).toEqual([{ query: context.query, acceptingOnly: true }])
  })

  it('검색어만 바꾸면 기존 기업 조건은 반복하지 않고 유지 안내 한 줄로 표시한다', async () => {
    const nextContext = { ...seoulConversationContext, query: '수출 지원' }
    const network = mockConversationNetwork([
      readyConversationProposal(seoulConversationContext), readyConversationProposal(nextContext),
    ])
    renderConversationApp()
    await submitMessage('서울 SW 사업화')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    await submitMessage('수출 지원도 찾아줘')
    expect(screen.getByText(/적용 중인 조건: 접수 중만 · 현재 소재지: 서울 · 업종: SW/)).toBeTruthy()

    const proposal = screen.getByRole('region', { name: '조건 변경 제안' })
    const card = within(proposal)
    expect(card.getByRole('heading', { name: '수출 지원' })).toBeTruthy()
    expect(card.getByText('나머지 조건은 유지됩니다.')).toBeTruthy()
    expect(proposalSummaryText(proposal)).not.toMatch(/현재 소재지|업종|설립일|지원 목적|서울|SW|2024-01-01/)
    expect(card.queryByRole('list', { name: '변경할 조건' })).toBeNull()
    expect(proposalDetailEntries(proposal.querySelector('details')!)).toEqual([
      ['검색어', '수출 지원'], ['접수 상태', '접수 중만'], ['현재 소재지', '서울'],
      ['업종', 'SW'], ['설립일', '2024-01-01'], ['지원 목적', '사업화'],
    ])
    expect(network.searchRequests).toHaveLength(1)
    await act(async () => fireEvent.click(card.getByRole('button', { name: '이 조건으로 검색' })))
    expect(network.searchRequests[1]).toEqual({ query: '수출 지원', acceptingOnly: true,
      companyConditions: seoulConversationContext.companyConditions })
  })

  it('변경된 값과 해제만 보여주며 취소하면 적용 조건과 이전 검색 스냅샷을 보존한다', async () => {
    const nextContext = { ...seoulConversationContext, acceptingOnly: false,
      companyConditions: { ...seoulConversationContext.companyConditions, region: '부산', industry: null } }
    const network = mockConversationNetwork([
      readyConversationProposal(seoulConversationContext), readyConversationProposal(nextContext),
    ])
    const { store } = renderConversationApp()
    await submitMessage('서울 SW 사업화')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    await submitMessage('부산으로 바꾸고 업종은 빼줘. 마감 공고도 포함해줘')

    const proposal = screen.getByRole('region', { name: '조건 변경 제안' })
    const card = within(proposal)
    expect(card.getByText('현재 소재지: 부산')).toBeTruthy()
    expect(card.getByText('업종 해제')).toBeTruthy()
    expect(card.getByText('접수 상태: 전체')).toBeTruthy()
    expect(card.getByText('나머지 조건은 유지됩니다.')).toBeTruthy()
    expect(proposalSummaryText(proposal)).not.toMatch(/설립일|지원 목적|서울|2024-01-01|현재:|제안:|미입력/)
    expect(proposalDetailEntries(proposal.querySelector('details')!)).toEqual([
      ['검색어', seoulConversationContext.query], ['접수 상태', '전체 (접수 중·예정·마감·상태 미확인)'],
      ['현재 소재지', '부산'], ['설립일', '2024-01-01'], ['지원 목적', '사업화'],
    ])
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true,
      companyConditions: seoulConversationContext.companyConditions })
    fireEvent.click(card.getByRole('button', { name: '제안 취소' }))
    expect(screen.queryByRole('region', { name: '조건 변경 제안' })).toBeNull()
    expect(network.searchRequests).toHaveLength(1)
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true,
      companyConditions: seoulConversationContext.companyConditions })
    expect(store.getState().chat.messages.filter((message) => message.searchOptions !== undefined).at(-1)).toMatchObject({
      searchQuery: seoulConversationContext.query, searchOptions: { acceptingOnly: true,
        companyConditions: seoulConversationContext.companyConditions },
    })
    expect(screen.getByText(/검색 당시 조건: 접수 중만 · 현재 소재지: 서울/)).toBeTruthy()
  })

  it('기업 조건이 없어도 유지되는 전체 접수 상태는 한 줄로 안내하고 검색에 그대로 적용한다', async () => {
    const current = { ...emptyConversationContext, query: '지원금', acceptingOnly: false }
    const next = { ...current, query: '수출 지원' }
    const network = mockConversationNetwork([readyConversationProposal(current), readyConversationProposal(next)])
    renderConversationApp()
    await submitMessage('마감 공고도 포함해서 지원금 찾아줘')
    const first = within(screen.getByRole('region', { name: '조건 변경 제안' }))
    expect(first.getByText('접수 상태: 전체')).toBeTruthy()
    expect(first.queryByText('나머지 조건은 유지됩니다.')).toBeNull()
    await act(async () => fireEvent.click(first.getByRole('button', { name: '이 조건으로 검색' })))
    await submitMessage('수출 지원도 찾아줘')

    const proposal = screen.getByRole('region', { name: '조건 변경 제안' })
    expect(within(proposal).getByText('나머지 조건은 유지됩니다.')).toBeTruthy()
    expect(within(proposal).getByText('전체 접수 상태')).toBeTruthy()
    expect(proposalSummaryText(proposal)).not.toMatch(/현재 소재지|미입력/)
    expect(within(proposal).queryByRole('list', { name: '변경할 조건' })).toBeNull()
    expect(proposalDetailEntries(proposal.querySelector('details')!)).toEqual([
      ['검색어', '수출 지원'], ['접수 상태', '전체 (접수 중·예정·마감·상태 미확인)'],
    ])
    await act(async () => fireEvent.click(within(proposal).getByRole('button', { name: '이 조건으로 검색' })))
    expect(network.searchRequests[1]).toEqual({ query: '수출 지원', acceptingOnly: false })
  })

  it.each(['/', '/chat'])('%s의 수출 제안은 접수 중 배지와 변경 목적만 요약하고 자세히 보기는 요청·조건을 바꾸지 않는다', async (path) => {
    const context = { ...emptyConversationContext, query: '수출 지원사업',
      companyConditions: { ...emptyConversationContext.companyConditions, supportPurpose: '수출' } }
    const network = mockConversationNetwork([{ ...readyConversationProposal(context), changedFields: ['QUERY', 'SUPPORT_PURPOSE'] }])
    const { store } = renderConversationApp(path)
    await submitMessage('수출 지원사업 찾아줘')
    const proposal = screen.getByRole('region', { name: '조건 변경 제안' })
    const card = within(proposal)
    expect(card.getByText('이렇게 찾아볼게요')).toBeTruthy()
    expect(card.getByRole('heading', { level: 2, name: '수출 지원사업' })).toBeTruthy()
    expect(card.getByText('접수 중만', { selector: 'span' })).toBeTruthy()
    expect(card.getByText('접수 중인 공고에서 관련 지원사업을 찾아볼게요.')).toBeTruthy()
    const changes = card.getByRole('list', { name: '변경할 조건' })
    expect(within(changes).getAllByRole('listitem').map(item => item.textContent)).toEqual(['지원 목적: 수출'])
    expect(proposal.textContent).not.toMatch(/미입력|전국|예상\s*\d|자격 충족|조건 충족/)

    const summary = card.getByText('검색 조건 자세히').closest('summary')!
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    expect(proposalDetailEntries(details)).toEqual([
      ['검색어', '수출 지원사업'], ['접수 상태', '접수 중만'], ['지원 목적', '수출'],
    ])
    const before = store.getState().chat
    fireEvent.click(summary)
    expect(details.open).toBe(true)
    expect(within(details).getByText('아직 검색하지 않았어요. 바꾸고 싶은 조건은 새 메시지로 알려주세요.')).toBeTruthy()
    expect(store.getState().chat).toEqual(before)
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true })
    expect(store.getState().chat.conversationQuery).toBeNull()
    expect(network.searchRequests).toHaveLength(0)
    expect(network.fetch).toHaveBeenCalledOnce()
    fireEvent.click(summary)
    expect(details.open).toBe(false)
    expect(store.getState().chat).toEqual(before)
    expect(network.fetch).toHaveBeenCalledOnce()
    fireEvent.click(card.getByRole('button', { name: '제안 취소' }))
    expect(screen.queryByRole('region', { name: '조건 변경 제안' })).toBeNull()
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true })
    expect(network.searchRequests).toHaveLength(0)
    expect(network.fetch).toHaveBeenCalledOnce()
  })

  it('전체 상태와 긴 검색어·기업 조건은 상세에서 원문 그대로 확인하며 검색은 명시적 확인 후에만 실행한다', async () => {
    const longQuery = '해외 시장 진출과 수출 바우처 지원사업 '.repeat(12).trim()
    const longPurpose = '해외 전시회 참가와 시장 조사 '.repeat(4).trim()
    const context = { ...seoulConversationContext, query: longQuery, acceptingOnly: false,
      companyConditions: { ...seoulConversationContext.companyConditions, supportPurpose: longPurpose } }
    const network = mockConversationNetwork([readyConversationProposal(context)])
    const { store } = renderConversationApp()
    await submitMessage('서울 SW 기업, 예정·마감 공고를 포함해서 수출 지원사업 찾아줘')
    const proposal = screen.getByRole('region', { name: '조건 변경 제안' })
    const card = within(proposal)
    expect(card.getByRole('heading', { level: 2, name: longQuery }).textContent).toBe(longQuery)
    expect(card.getByText('전체 접수 상태')).toBeTruthy()
    expect(card.getByText('예정·마감·상태 미확인 공고까지 함께 찾아볼게요.')).toBeTruthy()
    expect(within(card.getByRole('list', { name: '변경할 조건' })).getByText(`지원 목적: ${longPurpose}`)).toBeTruthy()
    const summary = card.getByText('검색 조건 자세히').closest('summary')!
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    const before = store.getState().chat
    fireEvent.click(summary)
    expect(details.open).toBe(true)
    expect(proposalDetailEntries(details)).toEqual([
      ['검색어', longQuery], ['접수 상태', '전체 (접수 중·예정·마감·상태 미확인)'],
      ['현재 소재지', '서울'], ['업종', 'SW'], ['설립일', '2024-01-01'], ['지원 목적', longPurpose],
    ])
    expect(store.getState().chat).toEqual(before)
    expect(network.fetch).toHaveBeenCalledOnce()
    expect(network.searchRequests).toHaveLength(0)
    await act(async () => fireEvent.click(card.getByRole('button', { name: '이 조건으로 검색' })))
    expect(network.searchRequests).toEqual([{ query: longQuery, acceptingOnly: false,
      companyConditions: context.companyConditions }])
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: false,
      companyConditions: context.companyConditions })
    expect(screen.queryByRole('region', { name: '조건 변경 제안' })).toBeNull()
    expect(network.fetch).toHaveBeenCalledTimes(2)
  })

  it('0건 이후 설명 답변을 대화로 표시하며 다음 지역 입력에도 무역 검색 맥락을 보낸다', async () => {
    const context = { ...emptyConversationContext, query: '무역 지원사업',
      companyConditions: { ...emptyConversationContext.companyConditions, region: '대구', supportPurpose: '무역' } }
    const answer = '대구 무역 조건으로 찾은 공고는 0건입니다. 접수 상태를 넓혀 볼 수 있어요.'
    const network = mockConversationNetwork([readyConversationProposal(context),
      { status: 'ANSWERED', proposedContext: context, clarificationQuestion: null, changedFields: [], answer },
      readyConversationProposal(context)])
    const { store } = renderConversationApp()
    await submitMessage('대구 무역 지원사업 찾아줘')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    await submitMessage('왜 못찾아?')
    expect(screen.getByText(answer)).toBeTruthy()
    expect(screen.queryByRole('region', { name: '조건 변경 제안' })).toBeNull()
    expect(screen.queryByRole('region', { name: '조건 추가 확인' })).toBeNull()
    expect(network.searchRequests).toHaveLength(1)
    expect(store.getState().chat.confirmedSearch?.query).toBe('무역 지원사업')
    await submitMessage('대구')
    expect(network.interpretRequests[2]).toEqual({ message: '대구', context, pendingClarification: null,
      lastSearch: { context, resultCount: 0 } })
    expect(network.searchRequests).toHaveLength(1)
  })

  it('서울 SW → 지원금 → 부산을 각각 확인한 뒤에만 검색하며 실제 body와 검색 스냅샷이 일치한다', async () => {
    const grants = { ...seoulConversationContext, query: '지원금', acceptingOnly: false,
      companyConditions: { ...seoulConversationContext.companyConditions, supportPurpose: '지원금' } }
    const busan = { ...grants, companyConditions: { ...grants.companyConditions, region: '부산' } }
    const network = mockConversationNetwork([
      { ...readyConversationProposal(seoulConversationContext), changedFields: ['QUERY', 'REGION', 'INDUSTRY', 'ESTABLISHED_ON', 'SUPPORT_PURPOSE'] },
      { ...readyConversationProposal(grants), changedFields: ['QUERY', 'SUPPORT_PURPOSE', 'ACCEPTING_ONLY'] },
      { ...readyConversationProposal(busan), changedFields: ['REGION'] },
    ])
    const { store } = renderConversationApp()
    for (const [index, message] of ['서울 SW 2024년 1월 1일 설립 사업화', '마감 공고도 포함해서 지원금 위주', '부산으로 변경'].entries()) {
      await submitMessage(message)
      expect(network.searchRequests).toHaveLength(index)
      expect(within(screen.getByRole('region', { name: '조건 변경 제안' }))
        .getByRole('heading', { name: index === 0 ? '사업화 지원' : '지원금' })).toBeTruthy()
      expect(screen.getByRole('status').textContent).toContain('확인 버튼을 눌러야 검색')
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
      await waitFor(() => expect(network.searchRequests).toHaveLength(index + 1))
      const command = network.searchRequests[index]
      expect(store.getState().chat.messages.at(-1)).toMatchObject({ searchQuery: command.query, searchOptions: {
        acceptingOnly: command.acceptingOnly, companyConditions: command.companyConditions,
      } })
    }
    expect(network.interpretRequests).toEqual([
      { message: '서울 SW 2024년 1월 1일 설립 사업화', context: emptyConversationContext, pendingClarification: null },
      { message: '마감 공고도 포함해서 지원금 위주', context: seoulConversationContext, pendingClarification: null, lastSearch: { context: seoulConversationContext, resultCount: 0 } },
      { message: '부산으로 변경', context: grants, pendingClarification: null, lastSearch: { context: grants, resultCount: 0 } },
    ])
    expect(network.searchRequests[2]).toEqual({ query: '지원금', acceptingOnly: false,
      companyConditions: { region: '부산', industry: 'SW', establishedOn: '2024-01-01', supportPurpose: '지원금' } })
    expect(screen.getByText(/검색 당시 조건: 접수 중만 · 현재 소재지: 서울/)).toBeTruthy()
    expect(screen.getByText(/검색 당시 조건: 접수 상태: 전체 · 현재 소재지: 부산/)).toBeTruthy()
    expect(network.fetch).toHaveBeenCalledTimes(6)
    fireEvent.click(screen.getByRole('button', { name: '새 AI 대화 검색' }))
    expect(store.getState().chat.conversationQuery).toBeNull()
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true })
    expect(screen.queryByText(/검색 당시 조건:/)).toBeNull()
    expect(screen.queryByRole('region', { name: '조건 변경 제안' })).toBeNull()
  })

  it('설립 2년은 미확정 질문으로 남기고 정확한 날짜 답변과 마지막 초안만 이어 보낸다', async () => {
    const draft = { ...seoulConversationContext, companyConditions: { ...seoulConversationContext.companyConditions, establishedOn: null } }
    const question = '정확한 설립일을 YYYY-MM-DD 형식으로 알려주세요.'
    const network = mockConversationNetwork([
      { status: 'CLARIFICATION_REQUIRED', proposedContext: draft, clarificationQuestion: question,
        changedFields: ['QUERY', 'REGION', 'INDUSTRY', 'SUPPORT_PURPOSE'] },
      { ...readyConversationProposal(seoulConversationContext), changedFields: ['QUERY', 'REGION', 'INDUSTRY', 'ESTABLISHED_ON', 'SUPPORT_PURPOSE'] },
    ])
    const { store } = renderConversationApp()
    await submitMessage('서울 SW 설립 2년 사업화')
    const clarification = screen.getByRole('region', { name: '조건 추가 확인' })
    expect(within(clarification).getByRole('heading', { name: question })).toBeTruthy()
    expect(within(clarification).getByText('답변을 입력해 주세요. 아직 검색하지 않았어요.')).toBeTruthy()
    expect(within(clarification).queryByText('이렇게 찾아볼게요')).toBeNull()
    expect(within(clarification).queryByText('접수 중만')).toBeNull()
    expect(within(clarification).queryByText('전체 접수 상태')).toBeNull()
    expect(clarification.querySelector('details')).toBeNull()
    expect(clarification.textContent).not.toMatch(/미확정 초안|미입력|현재:|제안:|현재 소재지|설립일 ·|2024-01-01|서울|SW/)
    expect(within(clarification).getAllByRole('button')).toHaveLength(1)
    expect(within(clarification).getByRole('button', { name: '제안 취소' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '이 조건으로 검색' })).toBeNull()
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true })
    expect(network.searchRequests).toHaveLength(0)
    await submitMessage('2024-01-01')
    expect(network.interpretRequests[1]).toEqual({ message: '2024-01-01', context: emptyConversationContext,
      pendingClarification: { question, draftContext: draft } })
    expect(network.searchRequests).toHaveLength(0)
    expect(screen.getByRole('region', { name: '조건 변경 제안' }).textContent).toContain('설립일: 2024-01-01')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    expect(network.searchRequests).toHaveLength(1)
    expect(store.getState().chat.searchOptions.companyConditions?.establishedOn).toBe('2024-01-01')
  })

  it('제공처 검색 불가 중에도 해석할 수 있지만 준비 완료 전 확인 검색은 막는다', async () => {
    readiness.canSearch = false
    const network = mockConversationNetwork([readyConversationProposal(seoulConversationContext)])
    const ui = renderConversationApp()
    await submitMessage('서울 SW 사업화')
    expect((screen.getByRole('button', { name: '이 조건으로 검색' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/공고 검색 준비가 완료되면/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' }))
    expect(network.searchRequests).toHaveLength(0)
    readiness.canSearch = true
    ui.rerender(<Provider store={ui.store}><MemoryRouter><App /></MemoryRouter></Provider>)
    expect((screen.getByRole('button', { name: '이 조건으로 검색' }) as HTMLButtonElement).disabled).toBe(false)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    expect(network.searchRequests).toHaveLength(1)
  })

  it.each(['READY', 'CLARIFICATION_REQUIRED'] as const)('%s 제안 취소는 미확정 초안을 폐기하고 실제 검색은 보내지 않는다', async (status) => {
    const proposal: SupportProgramInterpretation = status === 'READY'
      ? readyConversationProposal(seoulConversationContext)
      : { status, proposedContext: { ...seoulConversationContext,
        companyConditions: { ...seoulConversationContext.companyConditions, establishedOn: null },
      }, clarificationQuestion: '정확한 설립일을 알려주세요.', changedFields: ['REGION', 'INDUSTRY'] }
    const network = mockConversationNetwork([proposal, readyConversationProposal(seoulConversationContext)])
    const { store } = renderConversationApp()
    await submitMessage('서울 SW 사업화')
    expect(store.getState().chat.pendingClarification !== null).toBe(status === 'CLARIFICATION_REQUIRED')
    fireEvent.click(screen.getByRole('button', { name: '제안 취소' }))
    expect(screen.queryByRole('button', { name: '이 조건으로 검색' })).toBeNull()
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true })
    expect(store.getState().chat.pendingClarification).toBeNull()
    expect(screen.queryByRole('region', { name: '조건 추가 확인' })).toBeNull()
    expect(network.searchRequests).toHaveLength(0)
    await submitMessage('서울 SW 사업화')
    expect(network.interpretRequests[1]).toEqual({ message: '서울 SW 사업화', context: emptyConversationContext,
      pendingClarification: null })
    fireEvent.click(screen.getByRole('button', { name: '제안 취소' }))
    expect(screen.queryByRole('region', { name: '조건 변경 제안' })).toBeNull()
    expect(store.getState().chat.pendingClarification).toBeNull()
    expect(network.searchRequests).toHaveLength(0)
  })

  it('자연어 조건 초기화는 확인 후 검색에 적용하고 이전 검색의 조건은 보존한다', async () => {
    const resetContext = { ...emptyConversationContext, query: '지원금' }
    const network = mockConversationNetwork([
      readyConversationProposal(seoulConversationContext),
      { ...readyConversationProposal(resetContext), changedFields: ['QUERY', 'REGION', 'INDUSTRY', 'ESTABLISHED_ON', 'SUPPORT_PURPOSE'] },
    ])
    const { store } = renderConversationApp()
    await submitMessage('서울 SW 2024-01-01 설립 사업화')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))

    await submitMessage('기업 조건 모두 초기화하고 지원금 찾아줘')
    expect(network.interpretRequests[1]).toEqual({ message: '기업 조건 모두 초기화하고 지원금 찾아줘',
      context: seoulConversationContext, pendingClarification: null, lastSearch: { context: seoulConversationContext, resultCount: 0 } })
    expect(network.searchRequests).toHaveLength(1)
    expect(store.getState().chat.searchOptions.companyConditions).toEqual(seoulConversationContext.companyConditions)
    const proposal = screen.getByRole('region', { name: '조건 변경 제안' })
    for (const label of ['현재 소재지', '업종', '설립일', '지원 목적']) {
      expect(within(proposal).getByText(`${label} 해제`)).toBeTruthy()
    }
    expect(proposal.textContent).not.toMatch(/미입력|현재:|제안:|나머지 조건/)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))

    expect(network.searchRequests[1]).toEqual({ query: '지원금', acceptingOnly: true })
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true })
    expect(screen.getByText(/검색 당시 조건: 접수 중만 · 현재 소재지: 서울/)).toBeTruthy()
    expect(store.getState().chat.messages.at(-1)).toMatchObject({ searchQuery: '지원금', searchOptions: { acceptingOnly: true } })
    expect(network.fetch).toHaveBeenCalledTimes(4)
  })

  it.each(['/', '/app/chat'])('%s의 해석 실패는 대화 말풍선에서만 다시 해석을 제공한다', async (path) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(json(readyConversationProposal(seoulConversationContext)))
    vi.stubGlobal('fetch', fetchMock)
    const { store } = renderConversationApp(path)
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
    fireEvent.change(input, { target: { value: '서울 SW' } })
    fireEvent.submit(input.closest('form')!)
    const retry = await screen.findByRole('button', { name: '다시 해석' })
    const failure = screen.getByRole('alert')
    const bubble = failure.closest('article')!
    expect(bubble).not.toBeNull()
    expect(screen.getByRole('region', { name: '대화 내역' }).contains(bubble)).toBe(true)
    expect(bubble.contains(retry)).toBe(true)
    expect(input.closest('form')!.contains(failure)).toBe(false)
    expect(store.getState().chat.messages.at(-1)).toMatchObject({ role: 'assistant', failure: 'interpretation' })
    expect(screen.queryByRole('button', { name: '다시 검색' })).toBeNull()
    await act(async () => fireEvent.click(retry))
    expect(screen.getByRole('button', { name: '이 조건으로 검색' })).toBeTruthy()
    expect(bubble.isConnected).toBe(true)
    expect(within(bubble).queryByRole('button', { name: '다시 해석' })).toBeNull()
    expect(within(bubble).queryByRole('alert')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/conversation/interpret'))).toBe(true)
  })

  it('검색 서버의 확인된 시간 초과는 구체적으로 안내하고 같은 조건으로 검색만 수동 재시도한다', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(readyConversationProposal(seoulConversationContext)))
      .mockResolvedValueOnce(searchTimeoutResponse())
      .mockResolvedValueOnce(json(completeSearchResult({ query: seoulConversationContext.query, programs: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const { store } = renderConversationApp()
    await submitMessage('서울 SW 사업화')
    expect(fetchMock).toHaveBeenCalledOnce()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    const failure = screen.getByRole('alert')
    const bubble = failure.closest('article')!
    expect(failure.textContent).toContain('서버의 지원사업 검색 시간이 초과되었습니다')
    expect(bubble).not.toBeNull()
    expect(within(bubble).getByRole('button', { name: '다시 검색' })).toBeTruthy()
    expect(store.getState().chat.messages.at(-1)).toMatchObject({ role: 'assistant', failure: 'search' })
    expect(screen.queryByRole('button', { name: '다시 해석' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(store.getState().chat.searchOptions.companyConditions).toEqual(seoulConversationContext.companyConditions)

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '다시 검색' })))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[2][0])).toContain('/support-programs/search')
    expect(fetchMock.mock.calls[2][1].body).toEqual(fetchMock.mock.calls[1][1].body)
    expect(store.getState().chat.searchError).toBeNull()
    expect(bubble.isConnected).toBe(true)
    expect(within(bubble).queryByRole('button', { name: '다시 검색' })).toBeNull()
    expect(store.getState().chat.messages.at(-1)).toMatchObject({
      searchQuery: seoulConversationContext.query,
      searchOptions: { acceptingOnly: true, companyConditions: seoulConversationContext.companyConditions },
    })
  })

  it('연속 검색 실패는 각각 기록하되 최신 실패에서만 재시도하고 성공 뒤에도 기록을 유지한다', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(readyConversationProposal(seoulConversationContext)))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(json(completeSearchResult({ query: seoulConversationContext.query, programs: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const { store } = renderConversationApp()
    await submitMessage('서울 SW 사업화')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    const first = screen.getByRole('alert').closest('article')!
    const input = screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '작성 중인 다음 질문' } })
    expect(first.isConnected).toBe(true)
    await act(async () => fireEvent.click(within(first).getByRole('button', { name: '다시 검색' })))
    const second = screen.getByRole('alert').closest('article')!
    expect(second).not.toBe(first)
    expect(within(first).queryByRole('button')).toBeNull()
    expect(screen.getAllByRole('button', { name: '다시 검색' })).toHaveLength(1)
    expect(store.getState().chat.messages.filter((message) => message.failure === 'search')).toHaveLength(2)
    expect(input.value).toBe('작성 중인 다음 질문')
    await act(async () => fireEvent.click(within(second).getByRole('button', { name: '다시 검색' })))
    expect(first.isConnected).toBe(true)
    expect(second.isConnected).toBe(true)
    expect(screen.queryByRole('button', { name: '다시 검색' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(store.getState().chat.messages.filter((message) => message.failure === 'search')).toHaveLength(2)
    expect(fetchMock.mock.calls[2][1].body).toBe(fetchMock.mock.calls[1][1].body)
    expect(fetchMock.mock.calls[3][1].body).toBe(fetchMock.mock.calls[1][1].body)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each([{ code: 'UNKNOWN_TIMEOUT' }, { title: null }])('알 수 없거나 잘못된 검색 504는 일반 오류로 표시한다: %o', async (changes) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(readyConversationProposal(seoulConversationContext)))
      .mockResolvedValueOnce(searchTimeoutResponse(changes))
    vi.stubGlobal('fetch', fetchMock)
    renderConversationApp()
    await submitMessage('서울 SW')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '이 조건으로 검색' })))
    expect(screen.getByRole('alert').textContent).toContain('지원사업을 검색하지 못했습니다. 잠시 후 다시 시도해 주세요.')
    expect(screen.getByRole('alert').textContent).not.toContain('서버의 지원사업 검색 시간이 초과되었습니다')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

function proposalSummaryText(proposal: HTMLElement) {
  const summary = proposal.cloneNode(true) as HTMLElement
  summary.querySelector('details')?.remove()
  return summary.textContent ?? ''
}

function proposalDetailEntries(details: HTMLDetailsElement) {
  const terms = Array.from(details.querySelectorAll('dl dt'), term => term.textContent)
  const definitions = Array.from(details.querySelectorAll('dl dd'), definition => definition.textContent)
  expect(terms).toHaveLength(definitions.length)
  return terms.map((term, index) => [term, definitions[index]])
}

function searchTimeoutResponse(changes: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    type: 'urn:govbiz:problem:ai-service-timeout', title: 'AI Service Gateway Timeout', status: 504,
    detail: 'private server detail', instance: '/api/v1/support-programs/search', code: 'AI_SERVICE_TIMEOUT', ...changes,
  }), { status: 504, headers: { 'Content-Type': 'application/problem+json' } })
}

async function submitMessage(message: string) {
  const input = screen.getByRole('textbox', { name: '지원사업 검색어' })
  fireEvent.change(input, { target: { value: message } })
  await act(async () => fireEvent.submit(input.closest('form')!))
  await waitFor(() => expect(screen.queryByText('조건 변경안을 해석하고 있어요. 아직 검색하지 않았습니다…')).toBeNull())
}

function renderConversationApp(path = '/') {
  const store = createAppStore()
  // 작업 채팅(/chat)은 회원 세션이 있어야 열립니다. 세션 복원 요청은 보내지 않습니다.
  store.dispatch(sessionRestored(
    path.startsWith('/app/chat') ? { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null } : null,
  ))
  const tree = <Provider store={store}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></Provider>
  return { ...render(tree), store, tree }
}

function mockConversationNetwork(proposals: SupportProgramInterpretation[]) {
  const interpretRequests: unknown[] = []
  const searchRequests: { query: string; acceptingOnly: boolean; companyConditions?: Record<string, string> }[] = []
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (String(url).endsWith('/conversation/interpret')) {
      interpretRequests.push(body)
      return json(proposals.shift())
    }
    if (String(url).endsWith('/search')) {
      searchRequests.push(body)
      return json(completeSearchResult({ query: body.query, programs: [] }))
    }
    throw new Error(`Unexpected endpoint: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetch: fetchMock, interpretRequests, searchRequests }
}

function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }) }
