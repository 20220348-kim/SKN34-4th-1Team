// @vitest-environment jsdom

import { createElement, type FormEvent } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import { emptyConversationContext, readyConversationProposal, seoulConversationContext } from '../../../../data/fixtures/supportProgramConversation'
import type { useSupportProgramChat } from '../hooks/useSupportProgramChat'
import { useChatPageViewModel } from './useChatPageViewModel'
import type { useSupportProgramSearchReadiness } from '../hooks/useSupportProgramSearchReadiness'
import * as supportProgramEligibility from '../supportProgramEligibility'

const hookMocks = vi.hoisted(() => ({
  chat: vi.fn(),
  readiness: vi.fn(),
}))

vi.mock('../hooks/useSupportProgramChat', () => ({
  supportProgramChatSuggestions: [
    '서울 AI 창업지원 사업 찾아줘',
    '현재 접수 중인 수출 지원사업 알려줘',
    '제조기업 R&D 사업을 찾아줘',
  ],
  useSupportProgramChat: hookMocks.chat,
}))

vi.mock('../hooks/useSupportProgramSearchReadiness', () => ({
  useSupportProgramSearchReadiness: hookMocks.readiness,
}))

// 관심 저장은 전용 훅·화면 통합 테스트에서 검증하고, 이 파일은 대화 페이지의 상태 조합만 검증합니다.
vi.mock('./useSearchResultInterests', () => ({ useSearchResultInterests: () => null }))

type ChatHook = ReturnType<typeof useSupportProgramChat>
type ReadinessHook = ReturnType<typeof useSupportProgramSearchReadiness>

beforeEach(() => {
  hookMocks.chat.mockReturnValue(createChatHook())
  hookMocks.readiness.mockReturnValue(createReadinessHook())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useChatPageViewModel', () => {
  it('원본 해석 상태 대신 화면에 필요한 제안·초기화·오류 상태를 제공한다', () => {
    const { result } = renderHook(() => useChatPageViewModel())

    expect(result.current).toMatchObject({ displayProposal: null, hasConfirmedSearch: false,
      hasSearchToReset: false, interpretationError: undefined, canRetryInterpretation: false })
    expect(result.current).not.toHaveProperty('confirmedContext')
    expect(result.current).not.toHaveProperty('interpretation')
    expect(result.current).not.toHaveProperty('pendingClarification')
  })

  it.each([
    { query: null, conversationCount: 1, hasConfirmedSearch: false },
    { query: '사업화 지원', conversationCount: 0, hasConfirmedSearch: true },
  ])('확정 검색어 $query 또는 대화 $conversationCount건이 있으면 새 검색을 제공한다', ({ query, conversationCount, hasConfirmedSearch }) => {
    hookMocks.chat.mockReturnValue(createChatHook({
      confirmedContext: { ...emptyConversationContext, query }, conversationCount,
    }))
    const { result } = renderHook(() => useChatPageViewModel())

    expect(result.current).toMatchObject({ hasConfirmedSearch, hasSearchToReset: true })
  })

  it('해석 오류와 재시도 가능 여부를 원본 요청의 존재에 따라 제공하고 재시도는 훅에 위임한다', () => {
    let chat = createChatHook({ interpretation: { status: 'failed', error: '해석 실패',
      request: { message: '지원사업', context: emptyConversationContext } } })
    hookMocks.chat.mockImplementation(() => chat)
    const { result, rerender } = renderHook(() => useChatPageViewModel())

    expect(result.current).toMatchObject({ interpretationError: '해석 실패', canRetryInterpretation: true })
    act(() => result.current.handleRetryInterpretation())
    expect(chat.retryInterpretation).toHaveBeenCalledOnce()

    chat = { ...chat, interpretation: { status: 'failed', error: '요청 없는 오류' } }
    rerender()
    expect(result.current).toMatchObject({ interpretationError: '요청 없는 오류', canRetryInterpretation: false })
    chat = { ...chat, interpretation: { status: 'ready',
      request: { message: '새 질문', context: emptyConversationContext },
      result: readyConversationProposal(seoulConversationContext) } }
    rerender()
    expect(result.current.canRetryInterpretation).toBe(false)
  })

  it('요청 당시 조건으로 표시 제안을 만들고 검색 준비 변화에 따라 확인 가능 여부를 갱신한다', () => {
    const chat = createChatHook({ interpretation: { status: 'ready',
      request: { message: '사업화 지원', context: seoulConversationContext },
      result: readyConversationProposal(seoulConversationContext) } })
    let readiness = createReadinessHook({ canSearch: false })
    hookMocks.chat.mockReturnValue(chat)
    hookMocks.readiness.mockImplementation(() => readiness)
    const { result, rerender } = renderHook(() => useChatPageViewModel())

    expect(result.current.displayProposal).toMatchObject({ kind: 'ready', query: '사업화 지원',
      changes: [], hasRetainedConditions: true, canConfirm: false })
    act(() => result.current.handleConfirmInterpretation())
    expect(chat.confirmInterpretation).not.toHaveBeenCalled()

    readiness = createReadinessHook({ canSearch: true })
    rerender()
    expect(result.current.displayProposal).toMatchObject({ kind: 'ready', canConfirm: true })
    act(() => result.current.handleConfirmInterpretation())
    expect(chat.confirmInterpretation).toHaveBeenCalledOnce()

    readiness = createReadinessHook({ canSearch: false })
    rerender()
    expect(result.current.displayProposal).toMatchObject({ kind: 'ready', canConfirm: false })
  })

  it.each(['interpretation', 'search'] as const)('%s 처리 중에는 미확정 질문을 숨기고 취소 뒤에는 제거한다', (operation) => {
    let chat = createChatHook({ pendingClarification: { question: '어느 지역인가요?', draftContext: emptyConversationContext } })
    const cancelInterpretation = vi.fn(() => { chat = { ...chat, interpretation: { status: 'idle' }, pendingClarification: null } })
    chat = { ...chat, cancelInterpretation }
    hookMocks.chat.mockImplementation(() => chat)
    const { result, rerender } = renderHook(() => useChatPageViewModel())

    expect(result.current.displayProposal).toEqual({ kind: 'clarification', question: '어느 지역인가요?' })
    chat = { ...chat, isBusy: true, isInterpreting: operation === 'interpretation', isSearching: operation === 'search' }
    rerender()
    expect(result.current.displayProposal).toBeNull()

    chat = { ...chat, isBusy: false, isInterpreting: false, isSearching: false }
    rerender()
    expect(result.current.displayProposal).toEqual({ kind: 'clarification', question: '어느 지역인가요?' })
    act(() => result.current.cancelInterpretation())
    rerender()
    expect(cancelInterpretation).toHaveBeenCalledOnce()
    expect(result.current.displayProposal).toBeNull()
  })

  it('잠긴 결과의 전체 수와 실제 표시 수·자격 집계를 스크린 리더에 구분해 알린다', () => {
    hookMocks.chat.mockReturnValue(createChatHook({ messages: [{ id: 'preview', role: 'assistant', text: '일부 공개',
      programs: supportPrograms.slice(0, 2), totalCount: 5,
      resultToken: '4595df20-ea11-4b17-a37e-c82e1b5c9142', expiresAt: '2026-09-10T12:30:00Z' }] }))
    const { result } = renderHook(() => useChatPageViewModel())
    expect(result.current.searchStatusAnnouncement).toContain('검색 결과 5건 중 2건을 표시했습니다.')
    expect(result.current.searchStatusAnnouncement).toContain('표시된 공고: 조건 확인 공고 0건, 확인 필요 공고 2건')
    expect(result.current.searchStatusAnnouncement).toContain('추가 3건은 회원가입 또는 로그인 후 확인')
    expect(result.current.searchStatusAnnouncement).not.toContain('5건을 표시했습니다.')
  })

  it('초안 수정은 기존 검색 결과의 자격 건수를 재집계하지 않고 새 결과가 오면 안내를 갱신한다', () => {
    const formatCounts = vi.spyOn(supportProgramEligibility, 'formatSupportProgramEligibilityCounts')
    let chat = createChatHook({ messages: [{
      id: 'search-result', role: 'assistant', text: '검색 결과', programs: supportPrograms.slice(0, 2),
    }] })
    hookMocks.chat.mockImplementation(() => chat)
    const { result, rerender } = renderHook(() => useChatPageViewModel())
    const announcement = result.current.searchStatusAnnouncement
    expect(formatCounts).toHaveBeenCalledOnce()

    for (let index = 1; index <= 20; index += 1) {
      chat = { ...chat, draft: `다음 질문 ${index}` }
      rerender()
    }
    expect(formatCounts).toHaveBeenCalledOnce()
    expect(result.current.searchStatusAnnouncement).toBe(announcement)

    chat = { ...chat, messages: [...chat.messages, {
      id: 'next-result', role: 'assistant', text: '새 결과', programs: [],
    }] }
    rerender()
    expect(formatCounts).toHaveBeenCalledTimes(2)
    expect(result.current.searchStatusAnnouncement)
      .toBe('지원사업 검색 결과 0건: 조건 확인 공고 0건, 확인 필요 공고 0건을 표시했습니다.')
  })

  it('문서 스크롤 화면은 새 로딩·제안·응답을 보이게 하되 초기 진입·초안 수정·초기화에서는 점프하지 않는다', () => {
    const initial = createChatHook()
    const harness = renderScrollHarness(initial)
    expect(harness.scrollIntoView).not.toHaveBeenCalled()
    harness.rerender({ ...initial, draft: '서울' })
    expect(harness.scrollIntoView).not.toHaveBeenCalled()

    const pending = { ...initial, messages: [...initial.messages, { id: 'question', role: 'user' as const, text: '서울' }],
      isInterpreting: true, isBusy: true, interpretation: { status: 'pending' as const } }
    harness.rerender(pending)
    expect(harness.scrollIntoView).toHaveBeenLastCalledWith({ block: 'start' })
    expect(harness.scrollIntoView).toHaveBeenCalledTimes(1)
    harness.rerender({ ...pending, isInterpreting: false, isBusy: false, interpretation: { status: 'ready' } })
    expect(harness.scrollIntoView).toHaveBeenCalledTimes(2)
    harness.rerender({ ...pending, isInterpreting: false, isSearching: true, interpretation: { status: 'idle' } })
    expect(harness.scrollIntoView).toHaveBeenCalledTimes(3)
    const completed = { ...initial, messages: [...pending.messages,
      { id: 'answer', role: 'assistant' as const, text: '결과', programs: [supportPrograms[0]] }] }
    harness.rerender(completed)
    expect(harness.scrollIntoView).toHaveBeenCalledTimes(4)
    harness.rerender({ ...completed, draft: '다음 질문' })
    expect(harness.scrollIntoView).toHaveBeenCalledTimes(4)

    act(() => harness.model().handleStartNewConversation())
    harness.rerender(createChatHook())
    expect(harness.scrollIntoView).toHaveBeenCalledTimes(4)
    expect(harness.focus).toHaveBeenCalledOnce()
  })

  it('과거 결과가 있는 내부 overflow 화면은 최초 진입·상세 복귀에도 마지막 결과의 처음을 표시한다', () => {
    const initial = createChatHook({ messages: [
      { id: 'old-question', role: 'user', text: '서울 지원사업' },
      { id: 'old-answer', role: 'assistant', text: '이전 검색 결과', programs: [supportPrograms[0]] },
    ] })
    const harness = renderScrollHarness(initial, true)
    expect(harness.model().timelineRef.current?.scrollTop).toBe(400)
    harness.model().timelineRef.current!.scrollTop = 0
    harness.rerender({ ...initial, draft: '작성 중인 새 질문' })
    expect(harness.model().timelineRef.current?.scrollTop).toBe(0)
    harness.rerender({ ...initial, interpretation: { status: 'clarification' } })
    expect(harness.model().timelineRef.current?.scrollTop).toBe(1_000)
    expect(harness.scrollIntoView).not.toHaveBeenCalled()
  })

  it.each(['auto', 'scroll'] as const)('내부 %s 화면의 긴 새 결과는 목록의 처음으로 이동하고 초안 수정은 읽던 위치를 유지한다', (overflowY) => {
    const initial = createChatHook()
    const pending = { ...initial,
      messages: [...initial.messages, { id: 'question', role: 'user' as const, text: '서울 AI 창업지원' }],
      isSearching: true, isBusy: true }
    const harness = renderScrollHarness(pending, true, { overflowY })
    const timeline = harness.model().timelineRef.current!
    expect(timeline.scrollTop).toBe(1_000)

    const completed = { ...pending, isSearching: false, isBusy: false,
      messages: [...pending.messages, { id: 'answer', role: 'assistant' as const,
        text: '검색 결과', programs: supportPrograms }] }
    harness.rerender(completed)

    expect(timeline.scrollTop).toBe(400)
    expect(timeline.querySelector('[data-search-results]')!.getBoundingClientRect().top)
      .toBe(timeline.getBoundingClientRect().top + timeline.clientTop)
    expect(harness.scrollIntoView).not.toHaveBeenCalled()
    timeline.scrollTop = 480
    harness.rerender({ ...completed, draft: '다음 질문을 작성 중' })
    expect(timeline.scrollTop).toBe(480)
  })

  it.each([
    { overflowY: 'auto', clientHeight: 400, scrollHeight: 400 },
    { overflowY: 'auto', clientHeight: 600, scrollHeight: 400 },
    { overflowY: 'scroll', clientHeight: 400, scrollHeight: 400 },
    { overflowY: 'scroll', clientHeight: 600, scrollHeight: 400 },
  ] as const)('내용이 넘치지 않는 내부 $overflowY 화면($clientHeight/$scrollHeight)은 첫 로딩에서도 문서를 스크롤하지 않는다', (dimensions) => {
    const initial = createChatHook()
    const harness = renderScrollHarness(initial, true, dimensions)
    const timeline = harness.model().timelineRef.current!
    expect(timeline.clientHeight).toBeGreaterThanOrEqual(timeline.scrollHeight)
    expect(harness.scrollIntoView).not.toHaveBeenCalled()
    timeline.scrollTop = 0

    harness.rerender({
      ...initial,
      messages: [...initial.messages, { id: 'first-question', role: 'user', text: '서울' }],
      isInterpreting: true,
      isBusy: true,
      interpretation: { status: 'pending' },
    })

    expect(timeline.scrollTop).toBe(dimensions.scrollHeight)
    expect(harness.scrollIntoView).not.toHaveBeenCalled()
  })

  it('scrollIntoView가 없는 테스트 DOM에서도 새로운 제안 표시가 실패하지 않는다', () => {
    const initial = createChatHook()
    const harness = renderScrollHarness(initial)
    Object.defineProperty(harness.model().timelineRef.current!.lastElementChild!, 'scrollIntoView', { value: undefined, configurable: true })
    expect(() => harness.rerender({ ...initial, interpretation: { status: 'ready' } })).not.toThrow()
  })

  it('검색 불가 상태에서도 해석은 허용하고 확인 검색·검색 재시도는 차단한다', () => {
    const chat = createChatHook({
      canRetrySearch: true,
      isReadyToSubmit: true,
    })
    hookMocks.chat.mockReturnValue(chat)
    hookMocks.readiness.mockReturnValue(createReadinessHook({ canSearch: false }))
    const { result } = renderHook(() => useChatPageViewModel())
    const submitEvent = createSubmitEvent()

    act(() => {
      result.current.handleSubmit(submitEvent.event)
      result.current.handleRetrySearch()
      result.current.handleConfirmInterpretation()
      result.current.handleSelectSuggestion('서울 AI')
    })

    expect(submitEvent.preventDefault).toHaveBeenCalledOnce()
    expect(chat.submitMessage).toHaveBeenCalledOnce()
    expect(chat.selectSuggestion).toHaveBeenCalledOnce()
    expect(chat.retrySearch).not.toHaveBeenCalled()
    expect(chat.confirmInterpretation).not.toHaveBeenCalled()
    expect(result.current).toMatchObject({
      canSearch: false,
      canRetrySearch: false,
      isReadyToSubmit: true,
    })
  })

  it('검색 가능 상태에서 내부 훅에 위임한다', () => {
    const chat = createChatHook({
      canRetrySearch: true,
      isReadyToSubmit: true,
    })
    const readiness = createReadinessHook()
    hookMocks.chat.mockReturnValue(chat)
    hookMocks.readiness.mockReturnValue(readiness)
    const { result } = renderHook(() => useChatPageViewModel())
    const submitEvent = createSubmitEvent()

    act(() => {
      result.current.handleSubmit(submitEvent.event)
      result.current.handleRetrySearch()
    })
    expect(submitEvent.preventDefault).toHaveBeenCalledOnce()
    expect(chat.submitMessage).toHaveBeenCalledOnce()
    expect(chat.retrySearch).toHaveBeenCalledOnce()

    act(() => result.current.handleSelectSuggestion('서울 AI'))
    expect(chat.selectSuggestion).toHaveBeenCalledWith('서울 AI')

    act(() => result.current.refetchReadiness())
    expect(readiness.refetch).toHaveBeenCalledOnce()
  })

  it('준비 상태가 바뀌면 검색·재시도·제출 가능 여부를 다시 계산한다', () => {
    const chat = createChatHook({
      canRetrySearch: true,
      isReadyToSubmit: true,
    })
    let readiness = createReadinessHook({ canSearch: false })
    hookMocks.chat.mockReturnValue(chat)
    hookMocks.readiness.mockImplementation(() => readiness)
    const { result, rerender } = renderHook(() => useChatPageViewModel())

    expect(result.current).toMatchObject({
      canSearch: false,
      canRetrySearch: false,
      isReadyToSubmit: true,
    })

    readiness = createReadinessHook({ canSearch: true })
    rerender()

    expect(result.current).toMatchObject({
      canSearch: true,
      canRetrySearch: true,
      isReadyToSubmit: true,
    })
  })

  it('검색 불가 상태에서도 새 대화를 시작한다', () => {
    const chat = createChatHook()
    hookMocks.chat.mockReturnValue(chat)
    hookMocks.readiness.mockReturnValue(createReadinessHook({ canSearch: false }))
    const { result } = renderHook(() => useChatPageViewModel())

    act(() => result.current.handleStartNewConversation())

    expect(chat.startNewConversation).toHaveBeenCalledOnce()
  })

  it('검색 중·0건·성공 결과를 스크린 리더 안내로 구분한다', () => {
    let chat = createChatHook({
      isSearching: true,
      messages: [{
        id: 'previous-result',
        role: 'assistant',
        text: '검색 결과',
        programs: [supportPrograms[0]],
      }],
    })
    hookMocks.chat.mockImplementation(() => chat)
    const { result, rerender } = renderHook(() => useChatPageViewModel())

    expect(result.current.searchStatusAnnouncement).toBe('지원사업 공고를 검색하고 있습니다.')

    chat = createChatHook({
      messages: [{ id: 'empty-result', role: 'assistant', text: '결과 없음', programs: [] }],
    })
    rerender()
    expect(result.current.searchStatusAnnouncement).toBe('지원사업 검색 결과 0건: 조건 확인 공고 0건, 확인 필요 공고 0건을 표시했습니다.')

    chat = createChatHook({
      messages: [{
        id: 'successful-result',
        role: 'assistant',
        text: '검색 결과',
        programs: supportPrograms.slice(0, 2),
      }],
    })
    rerender()
    expect(result.current.searchStatusAnnouncement).toBe('지원사업 검색 결과 2건: 조건 확인 공고 0건, 확인 필요 공고 2건을 표시했습니다.')
  })
})

function createChatHook(overrides: Partial<ChatHook> = {}): ChatHook {
  return {
    isRestoredHistory: false,
    confirmedContext: emptyConversationContext,
    conversationQuery: null,
    interpretation: { status: 'idle' },
    pendingClarification: null,
    isInterpreting: false,
    isBusy: false,
    cancelInterpretation: vi.fn(),
    confirmInterpretation: vi.fn(),
    retryInterpretation: vi.fn(),
    retrySearch: vi.fn(),
    searchOptions: { acceptingOnly: true },
    canRetrySearch: false,
    conversationCount: 0,
    cancelSearch: vi.fn(),
    draft: '',
    isReadyToSubmit: false,
    isSearching: false,
    messages: [{ id: 'welcome', role: 'assistant', text: '안녕하세요.' }],
    searchError: null,
    inputError: null,
    selectSuggestion: vi.fn(),
    startNewConversation: vi.fn(),
    submitMessage: vi.fn().mockResolvedValue(undefined),
    updateDraft: vi.fn(),
    ...overrides,
  }
}

function createReadinessHook(
  overrides: Partial<ReadinessHook> = {},
): ReadinessHook {
  return {
    canSearch: true,
    data: {
      searchState: 'SEARCHABLE',
      programCount: 12,
      indexReady: true,
      lastSuccessfulSyncAt: '2026-09-05T09:00:00+09:00',
      lastFailedSyncAt: null,
      sources: [{
        sourceCode: 'BIZINFO',
        sourceName: '기업마당',
        searchState: 'SEARCHABLE',
        programCount: 12,
        indexReady: true,
        lastSuccessfulSyncAt: '2026-09-05T09:00:00+09:00',
        lastFailedSyncAt: null,
      }],
    },
    isError: false,
    isInitialLoading: false,
    isRefreshing: false,
    refetch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function createSubmitEvent() {
  const preventDefault = vi.fn()
  return {
    event: { preventDefault } as unknown as FormEvent<HTMLFormElement>,
    preventDefault,
  }
}

function renderScrollHarness(
  initial: ChatHook,
  internal = false,
  dimensions: { overflowY?: 'auto' | 'scroll'; clientHeight?: number; scrollHeight?: number } = {},
) {
  let chat = initial
  let viewModel!: ReturnType<typeof useChatPageViewModel>
  const scrollIntoView = vi.fn()
  const focus = vi.fn()
  hookMocks.chat.mockImplementation(() => chat)

  function Harness() {
    viewModel = useChatPageViewModel()
    return createElement('div', null,
      createElement('div', { ref: (element: HTMLDivElement | null) => {
        viewModel.timelineRef.current = element
        if (!element) return
        element.style.overflowY = internal ? dimensions.overflowY ?? 'auto' : 'visible'
        Object.defineProperties(element, {
          clientTop: { value: 2, configurable: true },
          clientHeight: { value: dimensions.clientHeight ?? (internal ? 400 : 1_000), configurable: true },
          scrollHeight: { value: dimensions.scrollHeight ?? 1_000, configurable: true },
        })
        element.getBoundingClientRect = () => new DOMRect(0, 100, 600, element.clientHeight)
      } }, createElement('article', { ref: (element: HTMLElement | null) => {
        if (element && !Object.hasOwn(element, 'scrollIntoView')) element.scrollIntoView = scrollIntoView
        if (element) element.getBoundingClientRect = () => new DOMRect(
          0, 100 + element.parentElement!.clientTop + 250 - element.parentElement!.scrollTop, 600, 750,
        )
      } }, '마지막 표시 내용', createElement('section', { 'data-search-results': true, ref: (element: HTMLElement | null) => {
        if (element) element.getBoundingClientRect = () => new DOMRect(
          0, 100 + viewModel.timelineRef.current!.clientTop + 400 - viewModel.timelineRef.current!.scrollTop, 600, 600,
        )
      } }, '검색 결과'))),
      createElement('textarea', { ref: (element: HTMLTextAreaElement | null) => {
        viewModel.composerInputRef.current = element
        if (element) element.focus = focus
      } }),
    )
  }

  const view = render(createElement(Harness))
  return { scrollIntoView, focus, model: () => viewModel,
    rerender: (next: ChatHook) => { chat = next; view.rerender(createElement(Harness)) } }
}
