// @vitest-environment jsdom

import { completeSearchResult } from '../../../../data/fixtures/supportProgramSearchResult'

import { createElement, type ComponentType, type PropsWithChildren } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAppStore } from '../../../../app/store'
import { emptyConversationContext, readyConversationProposal } from '../../../../data/fixtures/supportProgramConversation'
import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import type { SupportProgramInterpretation } from '../../../../domain/entities/SupportProgramConversation'
import type { InterpretSupportProgramConversationUseCase } from '../../../../domain/usecases/InterpretSupportProgramConversationUseCase'
import type { SearchSupportProgramsUseCase } from '../../../../domain/usecases/SearchSupportProgramsUseCase'
import { signedIn, signedOut } from '../../../shared/auth/state/authSlice'
import { useSupportProgramChat } from './useSupportProgramChat'

const trade = { ...emptyConversationContext, query: '무역 지원사업',
  companyConditions: { ...emptyConversationContext.companyConditions, region: '서울', supportPurpose: '무역' } }
const daegu = { ...trade, companyConditions: { ...trade.companyConditions, region: '대구' } }
const explanation: SupportProgramInterpretation = { status: 'ANSWERED', proposedContext: daegu,
  clarificationQuestion: null, changedFields: ['REGION'], answer: '현재 대구 무역 조건으로 찾은 공고는 0건입니다. 접수 상태를 넓혀 볼 수 있어요.' }
const question: SupportProgramInterpretation = { status: 'CLARIFICATION_REQUIRED', proposedContext: daegu,
  clarificationQuestion: '정확한 설립일을 알려주세요.', changedFields: ['REGION'] }

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('후속 발화의 미확정 조건과 검색 결과 맥락', () => {
  it('무역 → 미확정 대구 → 설정해 → 0건 → 왜 못찾아 → 대구를 조건 손실이나 자동 검색 없이 이어간다', async () => {
    const interpret = vi.fn<InterpretSupportProgramConversationUseCase['execute']>()
      .mockResolvedValueOnce(readyConversationProposal(trade))
      .mockResolvedValueOnce(readyConversationProposal(daegu))
      .mockResolvedValueOnce(readyConversationProposal(daegu))
      .mockResolvedValueOnce(explanation)
      .mockResolvedValueOnce(readyConversationProposal(daegu))
    const search = vi.fn<SearchSupportProgramsUseCase['execute']>()
      .mockResolvedValueOnce(completeSearchResult({ query: trade.query, programs: [supportPrograms[0]] }))
      .mockResolvedValue(completeSearchResult({ query: daegu.query, programs: [] }))
    const chat = renderConversation(interpret, search)
    await chat.submit('무역관련 찾아봐')
    await act(async () => chat.result.current.confirmInterpretation())
    await chat.submit('대구로 찾아봐')
    await chat.submit('설정해')
    expect(interpret.mock.calls[2][0]).toEqual({ message: '설정해', context: trade, pendingClarification: null,
      pendingProposal: daegu, lastSearch: { context: trade, resultCount: 1 } })
    expect(chat.result.current.confirmedContext).toEqual(trade)
    expect(search).toHaveBeenCalledOnce()
    await act(async () => chat.result.current.confirmInterpretation())
    expect(chat.store.getState().chat.pendingProposal).toBeNull()
    await chat.submit('왜 못찾아?')
    expect(interpret.mock.calls[3][0]).toEqual({ message: '왜 못찾아?', context: daegu, pendingClarification: null,
      lastSearch: { context: daegu, resultCount: 0 } })
    expect(chat.store.getState().chat.messages.at(-1)).toMatchObject({ role: 'assistant', text: explanation.answer })
    expect(chat.result.current.confirmedContext).toEqual(daegu)
    expect(chat.result.current.interpretation.status).toBe('idle')
    await act(async () => chat.result.current.confirmInterpretation())
    expect(search).toHaveBeenCalledTimes(2)
    await chat.submit('대구')
    expect(interpret.mock.calls[4][0]).toEqual({ message: '대구', context: daegu, pendingClarification: null,
      lastSearch: { context: daegu, resultCount: 0 } })
  })

  it.each([
    ['proposal', '그게 무슨 뜻이야?', explanation.answer],
    ['clarification', '그게 무슨 뜻이야?', explanation.answer],
    ['proposal', 'duckduckgo에 관해 자세히 말해줘', '이 대화에서는 지원사업 검색과 검색 조건 안내만 도와드릴 수 있습니다. 찾으시는 지원사업이나 필요한 지원 내용을 알려 주세요.'],
    ['clarification', 'duckduckgo에 관해 자세히 말해줘', '이 대화에서는 지원사업 검색과 검색 조건 안내만 도와드릴 수 있습니다. 찾으시는 지원사업이나 필요한 지원 내용을 알려 주세요.'],
  ] as const)('ANSWERED는 확정 조건과 %s를 보존한다: %s', async (kind, message, answer) => {
    const pending = kind === 'proposal' ? readyConversationProposal(daegu) : question
    const interpret = vi.fn<InterpretSupportProgramConversationUseCase['execute']>()
      .mockResolvedValueOnce(readyConversationProposal(trade)).mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ ...explanation, answer }).mockResolvedValueOnce(readyConversationProposal(daegu))
    const chat = renderConversation(interpret)
    await chat.submit('서울 무역 지원')
    await act(async () => chat.result.current.confirmInterpretation())
    await chat.submit('대구로 바꿔줘')
    const before = chat.store.getState().chat
    await chat.submit(message)
    const after = chat.store.getState().chat
    expect(after.messages.at(-1)).toMatchObject({ role: 'assistant', text: answer })
    expect(after.interpretation.status).toBe('idle')
    expect(chat.result.current.confirmedContext).toEqual(trade)
    expect(after.pendingProposal).toEqual(before.pendingProposal)
    expect(after.pendingClarification).toEqual(before.pendingClarification)
    expect(after.lastSearch).toEqual(before.lastSearch)
    expect(after.confirmedSearch).toEqual(before.confirmedSearch)
    await act(async () => chat.result.current.confirmInterpretation())
    expect(chat.search).toHaveBeenCalledOnce()
    await chat.submit('설정해')
    const request = interpret.mock.calls[3][0]
    expect(request.context).toEqual(trade)
    if (kind === 'proposal') {
      expect(request.pendingProposal).toEqual(daegu)
      expect(request.pendingClarification).toBeNull()
    } else {
      expect(request.pendingProposal).toBeUndefined()
      expect(request.pendingClarification).toEqual({ question: question.clarificationQuestion, draftContext: daegu })
    }
  })

  it('해석 실패 재시도는 미확정 제안과 직전 성공 검색 요약을 그대로 다시 보낸다', async () => {
    const interpret = vi.fn<InterpretSupportProgramConversationUseCase['execute']>()
      .mockResolvedValueOnce(readyConversationProposal(trade)).mockResolvedValueOnce(readyConversationProposal(daegu))
      .mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(readyConversationProposal(daegu))
    const chat = renderConversation(interpret)
    await chat.submit('무역')
    await act(async () => chat.result.current.confirmInterpretation())
    await chat.submit('대구')
    await chat.submit('설정해')
    expect(chat.store.getState().chat.pendingProposal).toEqual(daegu)
    await act(async () => chat.result.current.retryInterpretation())
    expect(interpret.mock.calls[3][0]).toEqual(interpret.mock.calls[2][0])
    expect(interpret.mock.calls[3][0].pendingProposal).toEqual(daegu)
    expect(chat.search).toHaveBeenCalledOnce()
  })

  it.each(['cancel'] as const)('진행 중 해석 %s는 초안을 보존하고 늦은 설명 응답을 무시한다', async (action) => {
    vi.useFakeTimers()
    const pending = deferred<SupportProgramInterpretation>()
    const interpret = vi.fn<InterpretSupportProgramConversationUseCase['execute']>()
      .mockResolvedValueOnce(readyConversationProposal(daegu)).mockReturnValueOnce(pending.promise)
    const chat = renderConversation(interpret)
    await chat.submit('대구 무역')
    act(() => chat.result.current.updateDraft('설정해'))
    let request!: Promise<void>
    act(() => { request = chat.result.current.submitMessage() })
    act(() => { if (action === 'cancel') chat.result.current.cancelSearch(); else chat.unmount() })
    const preserved = chat.store.getState().chat
    expect(preserved.pendingProposal).toEqual(daegu)
    expect(preserved.draft).toBe('설정해')
    expect(interpret.mock.calls[1][1]?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => { pending.resolve(explanation); await request })
    expect(chat.store.getState().chat).toEqual(preserved)
    expect(chat.search).not.toHaveBeenCalled()
  })

  it.each(['failed', 'cancelled'] as const)('새 검색이 %s이면 이전 성공 0건을 최근 결과로 보내지 않는다', async (phase) => {
    const pending = deferred<Awaited<ReturnType<SearchSupportProgramsUseCase['execute']>>>()
    const interpret = vi.fn<InterpretSupportProgramConversationUseCase['execute']>().mockResolvedValue(readyConversationProposal(daegu))
    const search = vi.fn<SearchSupportProgramsUseCase['execute']>()
      .mockResolvedValueOnce(completeSearchResult({ query: daegu.query, programs: [] })).mockReturnValueOnce(pending.promise)
    const chat = renderConversation(interpret, search)
    await chat.submit('대구 무역')
    await act(async () => chat.result.current.confirmInterpretation())
    expect(chat.store.getState().chat.lastSearch?.resultCount).toBe(0)
    await chat.submit('다시 찾아줘')
    let request!: Promise<void>
    act(() => { request = chat.result.current.confirmInterpretation() })
    expect(chat.store.getState().chat.lastSearch).toBeNull()
    if (phase === 'failed') await act(async () => { pending.reject(new Error('failed')); await request })
    else act(() => chat.result.current.cancelSearch())
    await chat.submit('왜 못찾아?')
    expect(interpret.mock.calls[2][0].lastSearch).toBeUndefined()
    if (phase === 'cancelled') await act(async () => { pending.resolve(completeSearchResult({ query: daegu.query, programs: [] })); await request })
    expect(chat.store.getState().chat.lastSearch).toBeNull()
  })

  it('계정 변경은 보관 초안과 최근 검색을 지우고 늦은 설명 응답을 차단한다', async () => {
    const pending = deferred<SupportProgramInterpretation>()
    const interpret = vi.fn<InterpretSupportProgramConversationUseCase['execute']>()
      .mockResolvedValueOnce(readyConversationProposal(trade)).mockResolvedValueOnce(readyConversationProposal(daegu))
      .mockReturnValueOnce(pending.promise)
    const chat = renderConversation(interpret)
    const account = { email: 'first@example.test', role: 'USER' as const, tier: 'MEMBER' as const, emailVerified: true, hasPassword: true, company: null }
    act(() => chat.store.dispatch(signedIn(account)))
    await chat.submit('무역')
    await act(async () => chat.result.current.confirmInterpretation())
    await chat.submit('대구')
    act(() => chat.result.current.updateDraft('왜?'))
    let request!: Promise<void>
    act(() => { request = chat.result.current.submitMessage() })
    act(() => { chat.store.dispatch(signedOut()); chat.store.dispatch(signedIn({ ...account, email: 'second@example.test' })) })
    const fresh = chat.store.getState().chat
    expect(fresh.pendingProposal).toBeNull()
    expect(fresh.lastSearch).toBeNull()
    expect(fresh.messages).toHaveLength(1)
    await act(async () => { pending.resolve(explanation); await request })
    expect(chat.store.getState().chat).toEqual(fresh)
  })
})

function renderConversation(interpret: InterpretSupportProgramConversationUseCase['execute'],
  search = vi.fn<SearchSupportProgramsUseCase['execute']>().mockResolvedValue(completeSearchResult({ query: trade.query, programs: [supportPrograms[0]] }))) {
  const store = createAppStore()
  const StoreProvider = Provider as unknown as ComponentType<PropsWithChildren<{ store: typeof store }>>
  const hook = renderHook(() => useSupportProgramChat({ execute: search }, { execute: interpret }), {
    wrapper: ({ children }: PropsWithChildren) => createElement(StoreProvider, { store }, children),
  })
  return { ...hook, store, search, submit: async (message: string) => {
    act(() => hook.result.current.updateDraft(message))
    await act(async () => hook.result.current.submitMessage())
  } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}
