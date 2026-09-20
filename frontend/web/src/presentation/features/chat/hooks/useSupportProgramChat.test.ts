// @vitest-environment jsdom

import { completeSearchResult } from '../../../../data/fixtures/supportProgramSearchResult'

import {
  createElement,
  type ComponentType,
  type PropsWithChildren,
  type ReactNode,
} from 'react'
import { Provider } from 'react-redux'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAppStore } from '../../../../app/store'
import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import { readyConversationProposal } from '../../../../data/fixtures/supportProgramConversation'
import { SupportProgramRequestError } from '../../../../domain/errors/SupportProgramRequestError'
import type { SearchSupportProgramsUseCase } from '../../../../domain/usecases/SearchSupportProgramsUseCase'
import {
  draftChanged,
  maximumSupportProgramSearchQueryLength,
  interpretationStarted,
  interpretationSucceeded,
  selectConversationContext,
} from '../state/chatSlice'
import { useSupportProgramChat } from './useSupportProgramChat'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Redux chat flow', () => {
  it('stores the user message and injected search service result in the chat slice', async () => {
    const execute = vi.fn().mockResolvedValue(completeSearchResult({
      query: '서울 AI',
      programs: [supportPrograms[0]],
    }))
    const store = createAppStore()
    const { result } = renderChatHook(store, createSearchUseCase(execute))

    act(() => store.dispatch(draftChanged('서울 AI')))
    await act(async () => result.current.submitMessage())

    const chat = store.getState().chat
    expect(execute).toHaveBeenCalledWith({ query: '서울 AI', acceptingOnly: true }, expect.any(AbortSignal))
    expect(chat.searchStatus).toBe('idle')
    expect(chat.messages.map((message) => message.role)).toEqual([
      'assistant',
      'user',
      'assistant',
    ])
    expect(chat.messages.at(-1)?.programs?.[0]?.id).toBe('fixture-seoul-ai-business')
  })

  it('does not start a duplicate search while the first request is pending', async () => {
    const pending = deferredSearchResult()
    const execute = vi.fn().mockReturnValue(pending.promise)
    const store = createAppStore()
    const { result } = renderChatHook(store, createSearchUseCase(execute))

    act(() => store.dispatch(draftChanged('수출')))
    let firstSearch!: Promise<void>
    let duplicateSearch!: Promise<void>
    act(() => {
      firstSearch = result.current.submitMessage()
      duplicateSearch = result.current.submitMessage()
    })
    pending.resolve(completeSearchResult({ query: '수출', programs: [supportPrograms[3]] }))
    await act(async () => Promise.all([firstSearch, duplicateSearch]))

    expect(execute).toHaveBeenCalledOnce()
    expect(store.getState().chat.messages).toHaveLength(3)
  })

  it('aborts and ignores a pending result when a new conversation starts', async () => {
    const pending = deferredSearchResult()
    let requestSignal: AbortSignal | undefined
    const execute = vi.fn((_command: unknown, signal?: AbortSignal) => {
      requestSignal = signal
      return pending.promise
    })
    const store = createAppStore()
    const { result } = renderChatHook(store, createSearchUseCase(execute))

    act(() => store.dispatch(draftChanged('제조')))
    let search!: Promise<void>
    act(() => {
      search = result.current.submitMessage()
    })
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())
    act(() => result.current.startNewConversation())

    expect(requestSignal?.aborted).toBe(true)
    pending.resolve(completeSearchResult({ query: '제조', programs: [supportPrograms[2]] }))
    await act(async () => search)

    const chat = store.getState().chat
    expect(chat.searchStatus).toBe('idle')
    expect(chat.messages).toHaveLength(1)
  })

  it('keeps a new draft but blocks resubmission while a request is pending', async () => {
    const firstPending = deferredSearchResult()
    let firstSignal: AbortSignal | undefined
    const execute = vi.fn((_command: unknown, signal?: AbortSignal) => {
      firstSignal = signal
      return firstPending.promise
    })
    const store = createAppStore()
    const { result } = renderChatHook(store, createSearchUseCase(execute))

    act(() => store.dispatch(draftChanged('서울')))
    let firstSearch!: Promise<void>
    act(() => {
      firstSearch = result.current.submitMessage()
    })
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())

    act(() => store.dispatch(draftChanged('수출')))
    await waitFor(() => expect(result.current.isReadyToSubmit).toBe(false))
    await act(async () => result.current.submitMessage())
    expect(firstSignal?.aborted).toBe(false)
    expect(execute).toHaveBeenCalledOnce()

    firstPending.resolve(completeSearchResult({ query: '서울', programs: [supportPrograms[0]] }))
    await act(async () => firstSearch)

    const chat = store.getState().chat
    expect(chat.searchStatus).toBe('idle')
    expect(chat.draft).toBe('수출')
    expect(chat.messages.at(-1)?.programs?.[0]?.id).toBe('fixture-seoul-ai-business')
  })

  it('500자를 넘는 검색어는 요청하지 않고 입력값과 검증 메시지를 유지한다', async () => {
    const execute = vi.fn()
    const store = createAppStore()
    const { result } = renderChatHook(store, createSearchUseCase(execute))
    const overlongQuery = '가'.repeat(maximumSupportProgramSearchQueryLength + 1)

    act(() => store.dispatch(draftChanged(overlongQuery)))
    await act(async () => result.current.submitMessage())

    const chat = store.getState().chat
    expect(execute).not.toHaveBeenCalled()
    expect(chat.draft).toBe(overlongQuery)
    expect(chat.messages).toHaveLength(1)
    expect(chat.searchStatus).toBe('idle')
    expect(chat.searchError).toBe('검색어는 500자 이하로 입력해 주세요. 현재 501자입니다.')
  })

  it('stores a safe error when the search service fails', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('private server detail'))
    const store = createAppStore()
    const { result } = renderChatHook(store, createSearchUseCase(execute))

    act(() => store.dispatch(draftChanged('서울')))
    await act(async () => result.current.submitMessage())

    const chat = store.getState().chat
    expect(chat.searchStatus).toBe('failed')
    expect(chat.draft).toBe('서울')
    expect(chat.searchError).toBe('지원사업을 검색하지 못했습니다. 잠시 후 다시 시도해 주세요.')
    expect(chat.searchError).not.toContain('private server detail')
    expect(chat.messages.at(-1)).toMatchObject({ role: 'assistant', failure: 'search', text: chat.searchError })
  })

  it.each([
    ['rate-limited', 12, '짧은 시간에 요청이 많아 잠시 제한되었습니다. 약 12초 후 직접 다시 시도해 주세요.'],
    ['busy', 3, '현재 다른 요청을 처리하고 있어 새 요청을 시작할 수 없습니다. 약 3초 후 직접 다시 시도해 주세요.'],
    ['rate-limited', null, '짧은 시간에 요청이 많아 잠시 제한되었습니다. 잠시 후 직접 다시 시도해 주세요.'],
  ] as const)('keeps the conversation and query for manual retry after %s', async (reason, seconds, message) => {
    vi.useFakeTimers()
    const execute = vi.fn()
      .mockResolvedValueOnce(completeSearchResult({ query: '서울', programs: [supportPrograms[0]] }))
      .mockRejectedValueOnce(new SupportProgramRequestError(reason, seconds))
      .mockResolvedValueOnce(completeSearchResult({ query: '수출', programs: [supportPrograms[3]] }))
    const store = createAppStore()
    const { result } = renderChatHook(store, createSearchUseCase(execute))
    act(() => result.current.updateDraft('서울'))
    await act(async () => result.current.submitMessage())
    const priorMessages = store.getState().chat.messages

    act(() => result.current.updateDraft('수출'))
    await act(async () => result.current.submitMessage())
    expect(result.current.searchError).toBe(message)
    expect(result.current.draft).toBe('수출')
    expect(result.current.canRetrySearch).toBe(true)
    expect(store.getState().chat.messages.slice(0, 3)).toEqual(priorMessages)
    expect(store.getState().chat.messages.at(-1)).toMatchObject({ role: 'assistant', failure: 'search', text: message })

    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(execute).toHaveBeenCalledTimes(2)
    await act(async () => result.current.submitMessage())
    expect(execute).toHaveBeenCalledTimes(3)
    expect(store.getState().chat.messages.slice(0, 3)).toEqual(priorMessages)
    expect(result.current.searchError).toBeNull()
  })

  it('cancels a pending search, restores its query, and clears the pending state', async () => {
    const pending = deferredSearchResult()
    let requestSignal: AbortSignal | undefined
    const execute = vi.fn((_command: unknown, signal?: AbortSignal) => {
      requestSignal = signal
      return pending.promise
    })
    const store = createAppStore()
    const { result } = renderChatHook(store, createSearchUseCase(execute))

    act(() => store.dispatch(draftChanged('수출')))
    let search!: Promise<void>
    act(() => {
      search = result.current.submitMessage()
    })
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())

    act(() => result.current.cancelSearch())

    expect(requestSignal?.aborted).toBe(true)
    expect(store.getState().chat.searchStatus).toBe('idle')
    expect(store.getState().chat.draft).toBe('수출')
    expect(store.getState().chat.searchError).toBeNull()

    pending.resolve(completeSearchResult({ query: '수출', programs: [supportPrograms[3]] }))
    await search
    expect(store.getState().chat.messages).toHaveLength(2)
  })

  it('waits past 70 seconds, cancels at 90 seconds, and allows retry while ignoring the old result', async () => {
    vi.useFakeTimers()
    const pending = deferredSearchResult()
    let requestSignal: AbortSignal | undefined
    const execute = vi.fn((_command: unknown, signal?: AbortSignal) => {
      requestSignal = signal
      return pending.promise
    })
    const store = createAppStore()
    const { result } = renderChatHook(store, createSearchUseCase(execute))

    act(() => store.dispatch(draftChanged('창업')))
    let search!: Promise<void>
    act(() => {
      search = result.current.submitMessage()
    })
    expect(execute).toHaveBeenCalledOnce()

    act(() => {
      vi.advanceTimersByTime(70_000)
    })
    expect(requestSignal?.aborted).toBe(false)
    expect(store.getState().chat.searchStatus).toBe('pending')

    act(() => {
      vi.advanceTimersByTime(19_999)
    })
    expect(requestSignal?.aborted).toBe(false)
    expect(store.getState().chat.searchStatus).toBe('pending')

    act(() => {
      vi.advanceTimersByTime(1)
    })

    const chat = store.getState().chat
    expect(requestSignal?.aborted).toBe(true)
    expect(chat.searchStatus).toBe('failed')
    expect(chat.draft).toBe('창업')
    expect(chat.searchError).toBe('검색 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.')
    expect(result.current.canRetrySearch).toBe(true)

    execute.mockResolvedValueOnce(completeSearchResult({ query: '창업', programs: [supportPrograms[0]] }))
    await act(async () => result.current.submitMessage())
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][0]).toEqual({ query: '창업', acceptingOnly: true })
    expect(execute.mock.calls[1][1]?.aborted).toBe(false)
    expect(store.getState().chat.searchStatus).toBe('idle')
    expect(store.getState().chat.searchError).toBeNull()
    expect(store.getState().chat.messages.at(-1)?.programs?.[0]?.id).toBe('fixture-seoul-ai-business')

    pending.resolve(completeSearchResult({ query: '창업', programs: [supportPrograms[1]] }))
    await search
    expect(store.getState().chat.messages).toHaveLength(5)
    expect(store.getState().chat.messages.filter((message) => message.failure === 'search')).toHaveLength(1)
    expect(store.getState().chat.messages.at(-1)?.programs?.[0]?.id).toBe('fixture-seoul-ai-business')
  })

  it('keeps a pending request alive after unmount and stores the result as unseen until the screen returns', async () => {
    const pending = deferredSearchResult()
    let requestSignal: AbortSignal | undefined
    const execute = vi.fn((_command: unknown, signal?: AbortSignal) => {
      requestSignal = signal
      return pending.promise
    })
    const store = createAppStore()
    const { result, unmount } = renderChatHook(store, createSearchUseCase(execute))

    act(() => store.dispatch(draftChanged('창업')))
    let search!: Promise<void>
    act(() => {
      search = result.current.submitMessage()
    })
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())

    // 화면을 떠나도 요청은 스토어가 쥐고 있어 끊기지 않습니다.
    unmount()
    expect(requestSignal?.aborted).toBe(false)
    expect(store.getState().chat.searchStatus).toBe('pending')

    pending.resolve(completeSearchResult({ query: '창업', programs: [supportPrograms[1]] }))
    await search
    expect(store.getState().chat.searchStatus).toBe('idle')
    expect(store.getState().chat.messages.at(-1)?.programs?.[0]?.id).toBe(supportPrograms[1]!.id)
    expect(store.getState().chat.unseenOutcome).toBe('search-succeeded')

    // 화면이 다시 열리면 결과를 본 것으로 표시합니다.
    renderChatHook(store, createSearchUseCase(execute))
    await waitFor(() => expect(store.getState().chat.unseenOutcome).toBeNull())
  })

  it('logging out aborts the request the store still holds', async () => {
    const pending = deferredSearchResult()
    let requestSignal: AbortSignal | undefined
    const execute = vi.fn((_command: unknown, signal?: AbortSignal) => {
      requestSignal = signal
      return pending.promise
    })
    const store = createAppStore()
    const { result } = renderChatHook(store, createSearchUseCase(execute))
    act(() => store.dispatch(draftChanged('창업')))
    act(() => { void result.current.submitMessage() })
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())

    act(() => result.current.startNewConversation())
    expect(requestSignal?.aborted).toBe(true)
    expect(store.getState().chat.searchStatus).toBe('idle')
    expect(store.getState().chat.messages).toHaveLength(1)
  })
})

function renderChatHook(
  store: ReturnType<typeof createAppStore>,
  searchUseCase: Pick<SearchSupportProgramsUseCase, 'execute'>,
) {
  // 검색·취소 회귀는 READY를 준비한 뒤 사용자의 명시적 확인으로 시작합니다.
  // 실제 해석→확인 흐름은 useSupportProgramConversation.test.ts에서 별도로 검증합니다.
  return renderHook(() => {
    const chat = useSupportProgramChat(searchUseCase, { execute: vi.fn() })
    return { ...chat, submitMessage: () => {
      const state = store.getState()
      if (state.chat.searchStatus === 'pending' || state.chat.draft.length > maximumSupportProgramSearchQueryLength || !state.chat.draft.trim()) {
        return chat.submitMessage()
      }
      if (state.chat.searchStatus === 'failed') return chat.retrySearch()
      const request = { message: state.chat.draft, context: selectConversationContext(state) }
      const started = interpretationStarted(request)
      store.dispatch(started)
      store.dispatch(interpretationSucceeded({ requestId: started.payload.requestId,
        result: readyConversationProposal({ ...request.context, query: request.message.trim() }) }))
      return chat.confirmInterpretation()
    } }
  }, {
    wrapper: createWrapper(store),
  })
}

function createWrapper(store: ReturnType<typeof createAppStore>) {
  const StoreProvider = Provider as unknown as ComponentType<PropsWithChildren<{ store: typeof store }>>

  return function TestWrapper({ children }: { children: ReactNode }) {
    return createElement(StoreProvider, { store }, children)
  }
}

function createSearchUseCase(
  execute: SearchSupportProgramsUseCase['execute'],
): Pick<SearchSupportProgramsUseCase, 'execute'> {
  return { execute }
}

function deferredSearchResult() {
  type Result = Awaited<ReturnType<SearchSupportProgramsUseCase['execute']>>
  let resolve!: (result: Result) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Result>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, reject, resolve }
}
