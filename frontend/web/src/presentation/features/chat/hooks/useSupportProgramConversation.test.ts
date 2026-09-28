// @vitest-environment jsdom

import { completeSearchResult } from '../../../../data/fixtures/supportProgramSearchResult'

import { createElement, type ComponentType, type PropsWithChildren } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAppStore } from '../../../../app/store'
import { emptyConversationContext, readyConversationProposal, seoulConversationContext } from '../../../../data/fixtures/supportProgramConversation'
import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import type { SupportProgramInterpretation } from '../../../../domain/entities/SupportProgramConversation'
import { SupportProgramInterpretationError } from '../../../../domain/errors/SupportProgramInterpretationError'
import { SupportProgramRequestError } from '../../../../domain/errors/SupportProgramRequestError'
import type { InterpretSupportProgramConversationUseCase } from '../../../../domain/usecases/InterpretSupportProgramConversationUseCase'
import type { SearchSupportProgramsUseCase } from '../../../../domain/usecases/SearchSupportProgramsUseCase'
import { signedIn, signedOut } from '../../../shared/auth/state/authSlice'
import { useSupportProgramChat } from './useSupportProgramChat'

afterEach(() => { cleanup(); vi.useRealTimers() })

const clarification: SupportProgramInterpretation = {
  status: 'CLARIFICATION_REQUIRED',
  proposedContext: { ...seoulConversationContext, companyConditions: { ...seoulConversationContext.companyConditions, establishedOn: null } },
  clarificationQuestion: '정확한 설립일을 YYYY-MM-DD 형식으로 알려주세요.', changedFields: ['QUERY', 'REGION', 'INDUSTRY', 'SUPPORT_PURPOSE'],
}

describe('해석 → 명시적 확인 → 기존 검색', () => {
  it.each(['interpretation', 'search'] as const)('%s 중 로그아웃은 마운트된 화면의 요청과 타이머를 취소하고 늦은 응답을 무시한다', async (phase) => {
    vi.useFakeTimers()
    const pendingInterpretation = deferred<SupportProgramInterpretation>()
    const pendingSearch = deferred<Awaited<ReturnType<SearchSupportProgramsUseCase['execute']>>>()
    const interpret = vi.fn<InterpretSupportProgramConversationUseCase['execute']>()
      .mockResolvedValue(readyConversationProposal(seoulConversationContext))
    if (phase === 'interpretation') interpret.mockReturnValueOnce(pendingInterpretation.promise)
    const search = vi.fn<SearchSupportProgramsUseCase['execute']>().mockReturnValueOnce(pendingSearch.promise)
    const { result, store } = renderConversation(interpret, search)
    const account = { email: 'first@example.test', role: 'USER' as const, tier: 'MEMBER' as const, emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }
    act(() => store.dispatch(signedIn(account)))
    act(() => result.current.updateDraft('서울 SW 사업화'))
    let request!: Promise<void>
    if (phase === 'search') {
      await act(async () => result.current.submitMessage())
      act(() => { request = result.current.confirmInterpretation() })
    } else {
      act(() => { request = result.current.submitMessage() })
    }
    const signal = phase === 'search' ? search.mock.calls[0][1] : interpret.mock.calls[0][1]
    expect(signal?.aborted).toBe(false)

    act(() => store.dispatch(signedOut()))

    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.draft).toBe('')
    expect(result.current.isBusy).toBe(false)
    expect(result.current.confirmedContext).toEqual(emptyConversationContext)

    act(() => store.dispatch(signedIn({ ...account, email: 'second@example.test' })))
    act(() => result.current.updateDraft('새 계정의 대화'))
    await act(async () => result.current.submitMessage())
    const newConversation = store.getState().chat
    expect(newConversation.interpretation.status).toBe('ready')
    await act(async () => {
      if (phase === 'search') pendingSearch.resolve(completeSearchResult({ query: '사업화 지원', programs: [supportPrograms[0]] }))
      else pendingInterpretation.resolve(clarification)
      await request
    })
    expect(store.getState().chat).toEqual(newConversation)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('검색 중 작성한 다음 초안은 실패한 검색을 재시도해도 지우지 않는다', async () => {
    const pending = deferred<Awaited<ReturnType<SearchSupportProgramsUseCase['execute']>>>()
    const search = vi.fn<SearchSupportProgramsUseCase['execute']>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(completeSearchResult({ query: '사업화 지원', programs: [supportPrograms[0]] }))
    const { result } = renderConversation(vi.fn().mockResolvedValue(readyConversationProposal(seoulConversationContext)), search)
    act(() => result.current.updateDraft('서울 SW 사업화'))
    await act(async () => result.current.submitMessage())
    let request!: Promise<void>
    act(() => { request = result.current.confirmInterpretation() })
    act(() => result.current.updateDraft('다음에는 수출 지원도 찾아줘'))
    await act(async () => {
      pending.reject(new Error('temporary failure'))
      await request
    })
    expect(result.current.canRetrySearch).toBe(true)
    await act(async () => result.current.retrySearch())
    expect(search.mock.calls[1][0]).toEqual(search.mock.calls[0][0])
    expect(result.current.draft).toBe('다음에는 수출 지원도 찾아줘')
  })

  it('서울 SW → 지원금 위주 → 부산 변경에서 확인 전 검색하지 않고 확정 검색 의도와 조건을 유지한다', async () => {
    const grants = { ...seoulConversationContext, query: '지원금', companyConditions: { ...seoulConversationContext.companyConditions, supportPurpose: '지원금' } }
    const busan = { ...grants, companyConditions: { ...grants.companyConditions, region: '부산' } }
    const interpret = vi.fn().mockResolvedValueOnce(readyConversationProposal(seoulConversationContext))
      .mockResolvedValueOnce(readyConversationProposal(grants)).mockResolvedValueOnce(readyConversationProposal(busan))
    const { result, store, search } = renderConversation(interpret)
    for (const [index, message] of ['서울 SW 2024년 1월 1일 설립 사업화', '지원금 위주', '부산으로 변경'].entries()) {
      act(() => result.current.updateDraft(message))
      await act(async () => result.current.submitMessage())
      expect(search).toHaveBeenCalledTimes(index)
      expect(store.getState().chat.conversationQuery).toBe(index === 0 ? null : index === 1 ? '사업화 지원' : '지원금')
      await act(async () => result.current.confirmInterpretation())
      expect(search).toHaveBeenCalledTimes(index + 1)
    }
    expect(interpret.mock.calls[0][0]).toEqual({ message: '서울 SW 2024년 1월 1일 설립 사업화', context: emptyConversationContext, pendingClarification: null })
    expect(interpret.mock.calls[1][0]).toEqual({ message: '지원금 위주', context: seoulConversationContext, pendingClarification: null, lastSearch: { context: seoulConversationContext, resultCount: 1 } })
    expect(interpret.mock.calls[2][0]).toEqual({ message: '부산으로 변경', context: grants, pendingClarification: null, lastSearch: { context: grants, resultCount: 1 } })
    const expected = { query: '지원금', acceptingOnly: true, companyConditions: { region: '부산', industry: 'SW', establishedOn: '2024-01-01', supportPurpose: '지원금' } }
    expect(search).toHaveBeenLastCalledWith(expected, expect.any(AbortSignal))
    expect(store.getState().chat.messages.at(-1)).toMatchObject({ searchQuery: expected.query,
      searchOptions: { acceptingOnly: expected.acceptingOnly, companyConditions: expected.companyConditions } })
    expect(store.getState().chat.messages[1].searchOptions?.companyConditions?.region).toBe('서울')
  })

  it('상대 업력은 확정하지 않고 마지막 질문·미확정 초안만 다음 답변과 전송한다', async () => {
    const interpret = vi.fn().mockResolvedValueOnce(clarification).mockResolvedValueOnce(readyConversationProposal(seoulConversationContext))
    const { result, store, search } = renderConversation(interpret)
    act(() => result.current.updateDraft('서울 SW 설립 2년 사업화'))
    await act(async () => result.current.submitMessage())
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true })
    expect(store.getState().chat.conversationQuery).toBeNull()
    await act(async () => result.current.confirmInterpretation())
    expect(search).not.toHaveBeenCalled()
    act(() => result.current.updateDraft('2024-01-01'))
    await act(async () => result.current.submitMessage())
    expect(interpret.mock.calls[1][0]).toEqual({ message: '2024-01-01', context: emptyConversationContext,
      pendingClarification: { question: clarification.clarificationQuestion, draftContext: clarification.proposedContext } })
    expect(store.getState().chat.pendingClarification).toBeNull()
    expect(search).not.toHaveBeenCalled()
    await act(async () => result.current.confirmInterpretation())
    expect(search).toHaveBeenCalledOnce()
  })

  it('새 초안이 있는 제안 확인은 직전 확정 검색을 다시 실행하지 않고 초안을 비우면 확인할 수 있다', async () => {
    const busan = { ...seoulConversationContext, companyConditions: { ...seoulConversationContext.companyConditions, region: '부산' } }
    const interpret = vi.fn().mockResolvedValueOnce(readyConversationProposal(seoulConversationContext))
      .mockResolvedValueOnce(readyConversationProposal(busan))
    const { result, store, search } = renderConversation(interpret)
    act(() => result.current.updateDraft('서울 SW'))
    await act(async () => result.current.submitMessage())
    await act(async () => result.current.confirmInterpretation())
    act(() => result.current.updateDraft('부산으로 바꿔줘'))
    await act(async () => result.current.submitMessage())
    act(() => result.current.updateDraft('수출도 추가해줘'))
    await act(async () => result.current.confirmInterpretation())
    expect(search).toHaveBeenCalledOnce()
    expect(result.current.draft).toBe('수출도 추가해줘')
    expect(store.getState().chat.pendingProposal).toEqual(busan)
    act(() => result.current.updateDraft(''))
    await act(async () => result.current.confirmInterpretation())
    expect(search).toHaveBeenCalledTimes(2)
    expect(result.current.confirmedContext).toEqual(busan)
    expect(interpret).toHaveBeenCalledTimes(2)
  })

  it('날짜 답변이 READY가 되면 질문은 지우고 완성된 미확정 제안을 다음 입력에 전달한다', async () => {
    const interpret = vi.fn().mockResolvedValueOnce(clarification).mockResolvedValue(readyConversationProposal(seoulConversationContext))
    const { result, search } = renderConversation(interpret)
    act(() => result.current.updateDraft('설립 2년'))
    await act(async () => result.current.submitMessage())
    act(() => result.current.updateDraft('2024-01-01'))
    await act(async () => result.current.submitMessage())
    act(() => result.current.updateDraft('수출 공고'))
    expect(result.current.interpretation.status).toBe('ready')
    expect(result.current.interpretation.result?.proposedContext).toEqual(seoulConversationContext)
    expect(result.current.pendingClarification).toBeNull()
    await act(async () => result.current.confirmInterpretation())
    expect(search).not.toHaveBeenCalled()
    await act(async () => result.current.submitMessage())
    expect(interpret.mock.calls[2][0]).toEqual({ message: '수출 공고', context: emptyConversationContext, pendingClarification: null, pendingProposal: seoulConversationContext })
  })

  it.each([clarification, readyConversationProposal(seoulConversationContext)])('확인 전 취소는 적용 조건과 검색 호출에 영향을 주지 않는다 ($status)', async (proposal) => {
    const { result, store, search } = renderConversation(vi.fn().mockResolvedValue(proposal))
    act(() => result.current.updateDraft('서울 SW'))
    await act(async () => result.current.submitMessage())
    act(() => result.current.cancelInterpretation())
    expect(result.current.interpretation.status).toBe('idle')
    expect(result.current.pendingClarification).toBeNull()
    expect(store.getState().chat.searchOptions).toEqual({ acceptingOnly: true })
    expect(result.current.draft).toBe('서울 SW')
    await act(async () => result.current.confirmInterpretation())
    expect(search).not.toHaveBeenCalled()
  })

  it('해석 중 중복 제출·새 메시지 입력을 차단하고 취소한 늦은 응답을 무시한다', async () => {
    const pending = deferred<SupportProgramInterpretation>()
    const interpret = vi.fn().mockReturnValue(pending.promise)
    const { result, store, search } = renderConversation(interpret)
    act(() => result.current.updateDraft('서울 SW'))
    let request!: Promise<void>
    act(() => { request = result.current.submitMessage() })
    await act(async () => result.current.submitMessage())
    act(() => result.current.updateDraft('수출'))
    expect(interpret).toHaveBeenCalledOnce()
    expect(result.current.draft).toBe('')
    expect(result.current.confirmedContext).toEqual(emptyConversationContext)
    act(() => result.current.cancelSearch())
    expect(interpret.mock.calls[0][1].aborted).toBe(true)
    pending.resolve(readyConversationProposal(seoulConversationContext))
    await act(async () => request)
    expect(store.getState().chat.interpretation.status).toBe('idle')
    expect(search).not.toHaveBeenCalled()
  })

  it('unmount는 진행 중 해석을 끊지 않고 늦게 도착한 제안을 보지 않은 결과로 남긴다', async () => {
    vi.useFakeTimers()
    const pending = deferred<SupportProgramInterpretation>()
    const interpret = vi.fn().mockReturnValue(pending.promise)
    const { result, store, unmount, search } = renderConversation(interpret)
    act(() => result.current.updateDraft('서울 SW'))
    let request!: Promise<void>
    act(() => { request = result.current.submitMessage() })
    act(() => unmount())
    expect(interpret.mock.calls[0][1].aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    pending.resolve(readyConversationProposal(seoulConversationContext))
    await act(async () => request)
    expect(vi.getTimerCount()).toBe(0)
    expect(store.getState().chat.interpretation.status).toBe('ready')
    expect(store.getState().chat.unseenOutcome).toBe('interpretation-ready')
    expect(search).not.toHaveBeenCalled()
  })

  it.each(['reset'] as const)('%s는 진행 중 해석과 타이머를 취소하고 늦은 제안을 무시한다', async (operation) => {
    vi.useFakeTimers()
    const pending = deferred<SupportProgramInterpretation>()
    const interpret = vi.fn().mockReturnValue(pending.promise)
    const { result, store, unmount, search } = renderConversation(interpret)
    act(() => result.current.updateDraft('서울 SW'))
    let request!: Promise<void>
    act(() => { request = result.current.submitMessage() })
    act(() => { if (operation === 'reset') result.current.startNewConversation(); else unmount() })
    expect(interpret.mock.calls[0][1].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve(readyConversationProposal(seoulConversationContext))
    await act(async () => request)
    expect(store.getState().chat.interpretation.status).toBe('idle')
    expect(store.getState().chat.conversationQuery).toBeNull()
    expect(search).not.toHaveBeenCalled()
  })

  it('40초 해석 제한과 다시 해석은 검색을 실행하지 않고 이전 늦은 응답을 무시한다', async () => {
    vi.useFakeTimers()
    const pending = deferred<SupportProgramInterpretation>()
    const interpret = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(readyConversationProposal(seoulConversationContext))
    const { result, store, search } = renderConversation(interpret)
    act(() => result.current.updateDraft('서울 SW'))
    let first!: Promise<void>
    act(() => { first = result.current.submitMessage() })
    act(() => vi.advanceTimersByTime(39_999))
    expect(result.current.isInterpreting).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.interpretation.error).toBe('조건 해석 시간이 초과되었습니다. 다시 해석해 주세요.')
    expect(store.getState().chat.messages.at(-1)).toMatchObject({ role: 'assistant', failure: 'interpretation',
      text: '조건 해석 시간이 초과되었습니다. 다시 해석해 주세요.' })
    expect(interpret.mock.calls[0][1].aborted).toBe(true)
    expect(interpret).toHaveBeenCalledOnce()
    await act(async () => result.current.retryInterpretation())
    expect(interpret.mock.calls[1][0]).toEqual(interpret.mock.calls[0][0])
    expect(result.current.interpretation.status).toBe('ready')
    expect(search).not.toHaveBeenCalled()
    pending.resolve(clarification)
    await act(async () => first)
    expect(store.getState().chat.interpretation.result?.status).toBe('READY')
    expect(store.getState().chat.messages.filter((message) => message.failure === 'interpretation')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('확인된 검색 실패의 재시도는 해석을 반복하지 않고 같은 확정 command·스냅샷을 사용한다', async () => {
    const context = { ...seoulConversationContext, acceptingOnly: false }
    const interpret = vi.fn().mockResolvedValue(readyConversationProposal(context))
    const search = vi.fn().mockRejectedValueOnce(new Error('search failure')).mockResolvedValue(completeSearchResult({ query: context.query, programs: [supportPrograms[0]] }))
    const { result, store } = renderConversation(interpret, search)
    act(() => result.current.updateDraft('서울 SW 사업화 전체'))
    await act(async () => result.current.submitMessage())
    await act(async () => result.current.confirmInterpretation())
    expect(result.current.canRetrySearch).toBe(true)
    act(() => result.current.updateDraft('아직 보내지 않은 다른 문장'))
    await act(async () => result.current.retrySearch())
    expect(interpret).toHaveBeenCalledOnce()
    expect(search.mock.calls[1][0]).toEqual(search.mock.calls[0][0])
    expect(store.getState().chat.messages.at(-1)).toMatchObject({ searchQuery: '사업화 지원', searchOptions: {
      acceptingOnly: false, companyConditions: context.companyConditions,
    } })
    act(() => result.current.updateDraft('부산으로 변경'))
    await act(async () => result.current.retrySearch())
    expect(search).toHaveBeenCalledTimes(2)
  })

  it.each([
    [new SupportProgramInterpretationError('timeout'), '조건 해석 응답이 지연되어 시간이 초과되었습니다. 잠시 후 다시 해석해 주세요.'],
    [new SupportProgramInterpretationError('unavailable'), '조건 해석 서비스를 일시적으로 이용할 수 없습니다. 잠시 후 다시 해석해 주세요.'],
    [new Error('private server detail'), '메시지의 조건 변경을 해석하지 못했습니다. 다시 해석해 주세요.'],
    [new SupportProgramRequestError('rate-limited', 10), '짧은 시간에 요청이 많아 잠시 제한되었습니다. 약 10초 후 직접 다시 시도해 주세요.'],
    [new SupportProgramRequestError('busy', 10), '현재 다른 요청을 처리하고 있어 새 요청을 시작할 수 없습니다. 약 10초 후 직접 다시 시도해 주세요.'],
  ] as const)('해석 오류 %s를 구분하고 사용자가 다시 해석하기 전에는 재요청하지 않는다', async (failure, message) => {
    vi.useFakeTimers()
    const interpret = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(readyConversationProposal(seoulConversationContext))
    const { result, search } = renderConversation(interpret)
    act(() => result.current.updateDraft('서울 SW 사업화'))
    await act(async () => result.current.submitMessage())
    expect(result.current.interpretation.status).toBe('failed')
    expect(result.current.interpretation.error).toBe(message)
    expect(result.current.interpretation.error).not.toContain('private server detail')
    expect(result.current.pendingClarification).toBeNull()
    expect(result.current.confirmedContext).toEqual(emptyConversationContext)
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => vi.advanceTimersByTimeAsync(40_000))
    expect(interpret).toHaveBeenCalledOnce()
    expect(result.current.interpretation.error).toBe(message)
    expect(search).not.toHaveBeenCalled()

    await act(async () => result.current.retryInterpretation())
    expect(interpret).toHaveBeenCalledTimes(2)
    expect(interpret.mock.calls[1][0]).toEqual(interpret.mock.calls[0][0])
    expect(result.current.interpretation.status).toBe('ready')
    expect(search).not.toHaveBeenCalled()
  })

  it.each(['timeout', 'unavailable'] as const)('취소 후 늦게 도착한 해석 %s 오류는 화면에 반영하지 않는다', async (reason) => {
    const pending = deferred<SupportProgramInterpretation>()
    const interpret = vi.fn().mockReturnValue(pending.promise)
    const { result, search } = renderConversation(interpret)
    act(() => result.current.updateDraft('서울 SW'))
    let request!: Promise<void>
    act(() => { request = result.current.submitMessage() })
    act(() => result.current.cancelInterpretation())
    await act(async () => {
      pending.reject(new SupportProgramInterpretationError(reason))
      await request
    })
    expect(interpret.mock.calls[0][1].aborted).toBe(true)
    expect(result.current.interpretation.status).toBe('idle')
    expect(result.current.interpretation.error).toBeUndefined()
    expect(result.current.draft).toBe('서울 SW')
    expect(interpret).toHaveBeenCalledOnce()
    expect(search).not.toHaveBeenCalled()
  })

  it('해석 장애는 추가 질문이나 단문 검색으로 바꾸지 않으며 수정한 입력은 새 요청이다', async () => {
    const interpret = vi.fn().mockRejectedValueOnce(new Error('private secret')).mockResolvedValue(readyConversationProposal(seoulConversationContext))
    const { result, search } = renderConversation(interpret)
    act(() => result.current.updateDraft('지원금'))
    await act(async () => result.current.submitMessage())
    expect(result.current.interpretation.status).toBe('failed')
    expect(result.current.interpretation.error).not.toContain('private secret')
    expect(result.current.pendingClarification).toBeNull()
    act(() => result.current.updateDraft('서울 SW'))
    await act(async () => result.current.retryInterpretation())
    expect(interpret).toHaveBeenCalledOnce()
    await act(async () => result.current.submitMessage())
    expect(interpret.mock.calls[1][0].message).toBe('서울 SW')
    expect(search).not.toHaveBeenCalled()
  })

  it('확인 중복 실행과 새 대화 이후 확정 command 재사용을 차단한다', async () => {
    const interpret = vi.fn().mockResolvedValue(readyConversationProposal(seoulConversationContext))
    const { result, store, search } = renderConversation(interpret)
    act(() => result.current.updateDraft('서울 SW'))
    await act(async () => result.current.submitMessage())
    await act(async () => Promise.all([result.current.confirmInterpretation(), result.current.confirmInterpretation()]))
    expect(search).toHaveBeenCalledOnce()
    act(() => result.current.startNewConversation())
    expect(result.current.confirmedContext).toEqual(emptyConversationContext)
    expect(store.getState().chat.confirmedSearch).toBeNull()
    expect(createAppStore().getState().chat.searchOptions).toEqual({ acceptingOnly: true })
  })

  it('확인한 검색 의도의 앞뒤 공백 정규화 결과가 실제 요청과 assistant 스냅샷에 일치한다', async () => {
    const { result, store, search } = renderConversation(vi.fn().mockResolvedValue(
      readyConversationProposal({ ...seoulConversationContext, query: '  사업화 지원  ' }),
    ))
    act(() => result.current.updateDraft('사업화'))
    await act(async () => result.current.submitMessage())
    await act(async () => result.current.confirmInterpretation())
    expect(search.mock.calls[0][0].query).toBe('사업화 지원')
    expect(store.getState().chat.conversationQuery).toBe('사업화 지원')
    expect(store.getState().chat.messages.at(-1)?.searchQuery).toBe(search.mock.calls[0][0].query)
  })

  it('대화로 지역 조건을 해제하고 접수 상태를 전체로 바꿔도 확인 전에는 기존 조건을 유지한다', async () => {
    const revisedContext = { ...seoulConversationContext, acceptingOnly: false,
      companyConditions: { ...seoulConversationContext.companyConditions, region: null } }
    const interpret = vi.fn().mockResolvedValueOnce(readyConversationProposal(seoulConversationContext))
      .mockResolvedValueOnce(readyConversationProposal(revisedContext))
    const { result, store, search } = renderConversation(interpret)
    act(() => result.current.updateDraft('서울 SW 사업화'))
    await act(async () => result.current.submitMessage())
    await act(async () => result.current.confirmInterpretation())
    const firstSnapshot = store.getState().chat.messages[1].searchOptions

    act(() => result.current.updateDraft('지역 조건은 빼고 마감 공고도 포함해 줘'))
    await act(async () => result.current.submitMessage())
    expect(result.current.confirmedContext).toEqual(seoulConversationContext)
    expect(search).toHaveBeenCalledOnce()
    await act(async () => result.current.confirmInterpretation())

    expect(result.current.confirmedContext).toEqual(revisedContext)
    expect(search).toHaveBeenLastCalledWith({ query: revisedContext.query, acceptingOnly: false,
      companyConditions: { industry: 'SW', establishedOn: '2024-01-01', supportPurpose: '사업화' } }, expect.any(AbortSignal))
    expect(store.getState().chat.messages[1].searchOptions).toEqual(firstSnapshot)
    expect(firstSnapshot?.companyConditions?.region).toBe('서울')
    expect(firstSnapshot?.acceptingOnly).toBe(true)
  })

  it('대화에서 조건 전체 해제를 확인하면 기업 조건을 생략하고 이후 새 대화는 초기 상태로 시작한다', async () => {
    const clearedContext = { ...emptyConversationContext, query: '지원금' }
    const interpret = vi.fn().mockResolvedValueOnce(readyConversationProposal(seoulConversationContext))
      .mockResolvedValueOnce(readyConversationProposal(clearedContext))
    const { result, store, search } = renderConversation(interpret)
    act(() => result.current.updateDraft('서울 SW 사업화'))
    await act(async () => result.current.submitMessage())
    await act(async () => result.current.confirmInterpretation())
    act(() => result.current.updateDraft('기업 조건을 모두 지우고 지원금 찾아줘'))
    await act(async () => result.current.submitMessage())
    expect(result.current.confirmedContext).toEqual(seoulConversationContext)
    await act(async () => result.current.confirmInterpretation())
    expect(search).toHaveBeenLastCalledWith({ query: '지원금', acceptingOnly: true }, expect.any(AbortSignal))
    expect(result.current.searchOptions.companyConditions).toBeUndefined()

    act(() => result.current.startNewConversation())
    expect(result.current.confirmedContext).toEqual(emptyConversationContext)
    expect(store.getState().chat.confirmedSearch).toBeNull()
    expect(store.getState().chat.messages).toHaveLength(1)
    expect(createAppStore().getState().chat.searchOptions).toEqual({ acceptingOnly: true })
  })

  it('조건을 확인한 검색을 취소해도 확정 조건을 유지하고 늦은 결과를 무시한다', async () => {
    const pending = deferred<Awaited<ReturnType<SearchSupportProgramsUseCase['execute']>>>()
    const search = vi.fn<SearchSupportProgramsUseCase['execute']>().mockReturnValue(pending.promise)
    const { result, store } = renderConversation(vi.fn().mockResolvedValue(readyConversationProposal(seoulConversationContext)), search)
    act(() => result.current.updateDraft('서울 SW 사업화'))
    await act(async () => result.current.submitMessage())
    let request!: Promise<void>
    act(() => { request = result.current.confirmInterpretation() })
    act(() => result.current.cancelSearch())
    expect(result.current.draft).toBe('사업화 지원')
    expect(result.current.confirmedContext).toEqual(seoulConversationContext)
    expect(search.mock.calls[0][1]?.aborted).toBe(true)

    pending.resolve(completeSearchResult({ query: '사업화 지원', programs: [supportPrograms[0]] }))
    await act(async () => request)
    expect(store.getState().chat.messages).toHaveLength(2)
    expect(store.getState().chat.searchStatus).toBe('idle')
  })
})

function renderConversation(interpret: InterpretSupportProgramConversationUseCase['execute'], search = vi.fn<SearchSupportProgramsUseCase['execute']>().mockResolvedValue(completeSearchResult({ query: '사업화 지원', programs: [supportPrograms[0]] }))) {
  const store = createAppStore()
  const StoreProvider = Provider as unknown as ComponentType<PropsWithChildren<{ store: typeof store }>>
  const hook = renderHook(() => useSupportProgramChat({ execute: search }, { execute: interpret }), {
    wrapper: ({ children }: PropsWithChildren) => createElement(StoreProvider, { store }, children),
  })
  return { ...hook, store, search }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}
