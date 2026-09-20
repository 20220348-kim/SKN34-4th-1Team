// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppStore } from '../../../../app/store'
import type { Account } from '../../../../domain/entities/Account'
import type { ChatConversationDetail, ChatConversationPage, ChatConversationSummary } from '../../../../domain/entities/ChatConversation'
import type { ChatConversationRepository } from '../../../../domain/repositories/ChatConversationRepository'
import { emptyConversationContext, readyConversationProposal, seoulConversationContext } from '../../../../data/fixtures/supportProgramConversation'
import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import { completeSearchResult } from '../../../../data/fixtures/supportProgramSearchResult'
import { sessionRestored, signedIn, signedOut } from '../../../shared/auth/state/authSlice'
import { conversationReset, createChatConversationSnapshot, draftChanged, interpretationStarted, interpretationSucceeded, proposalConfirmed, searchStarted, searchSucceeded } from '../state/chatSlice'
import { useChatHistory } from './useChatHistory'

const account: Account = { email: 'first@test.local', tier: 'MEMBER', role: 'USER', emailVerified: true, hasPassword: true, company: null }
const other = { ...account, email: 'other@test.local' }
const summary = (id: string, version = 1): ChatConversationSummary => ({ id, version, title: '서울 AI', updatedAt: '2026-09-12T12:00:00' })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function harness(auth: Account | null = account) {
  const store = createAppStore(); store.dispatch(sessionRestored(auth))
  const api: ChatConversationRepository = {
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }), get: vi.fn(),
    save: vi.fn().mockImplementation(async (_email, id, version) => summary(id, version + 1)),
  }
  const hook = renderHook(() => useChatHistory(api), { wrapper: ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider> })
  return { store, api, ...hook }
}
function savedDetail(id = 'saved'): ChatConversationDetail {
  const store = createAppStore()
  const started = interpretationStarted({ message: '서울 AI 지원사업', context: emptyConversationContext }, id)
  store.dispatch(started)
  store.dispatch(interpretationSucceeded({ requestId: started.payload.requestId, result: readyConversationProposal(seoulConversationContext) }))
  store.dispatch(proposalConfirmed(started.payload.requestId))
  const search = searchStarted('서울 AI', undefined, id)
  store.dispatch(search)
  store.dispatch(searchSucceeded({ ...completeSearchResult({ query: '서울 AI', programs: [supportPrograms[0]] }), requestId: search.payload.requestId }))
  return { conversation: summary(id), snapshot: createChatConversationSnapshot(store.getState().chat) }
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('로그인 계정별 대화 기록 수명', () => {
  it('현재 대화를 삭제하면 초기화하고 늦은 저장·AI 응답이 기록을 되살리지 않는다', async () => {
    const { store, api, result } = harness()
    const pendingSave = deferred<ChatConversationSummary>()
    vi.mocked(api.save).mockReturnValueOnce(pendingSave.promise)
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    const started = interpretationStarted({ message: '삭제할 질문', context: emptyConversationContext }, 'delete-me')
    act(() => store.dispatch(started))
    await act(async () => { expect(await result.current.remove('delete-me')).toBe(true) })
    expect(result.current.items).toEqual([])
    expect(result.current.activeId).toBeNull()
    await act(async () => pendingSave.resolve(summary('delete-me')))
    act(() => store.dispatch(interpretationSucceeded({ requestId: started.payload.requestId, result: readyConversationProposal(seoulConversationContext) })))
    act(() => result.current.retrySave())
    expect(api.save).toHaveBeenCalledOnce()
    expect(result.current.items).toEqual([])
    expect(result.current.saveError).toBe(false)
    expect(store.getState().chat.messages).toHaveLength(1)
    await act(async () => { expect(await result.current.open('delete-me')).toBe(false) })
    expect(api.get).not.toHaveBeenCalled()
  })

  it('삭제 중 중복 요청을 막고 다른 대화로 전환해도 그 대화는 유지한다', async () => {
    const { store, api, result } = harness()
    const pending = deferred<void>()
    vi.mocked(api.delete).mockReturnValueOnce(pending.promise)
    const otherDetail = savedDetail('other')
    vi.mocked(api.get).mockResolvedValue(otherDetail)
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    act(() => store.dispatch(interpretationStarted({ message: '삭제할 질문', context: emptyConversationContext }, 'first')))
    let removing!: Promise<boolean>
    act(() => { removing = result.current.remove('first') })
    expect(result.current.deletingId).toBe('first')
    await act(async () => {
      expect(await result.current.remove('first')).toBe(false)
      expect(await result.current.open('first')).toBe(false)
      expect(await result.current.open('other')).toBe(true)
    })
    await act(async () => { pending.resolve(); expect(await removing).toBe(true) })
    expect(result.current.activeId).toBe('other')
    expect(store.getState().chat.messages).toEqual(otherDetail.snapshot.messages)
    expect(api.delete).toHaveBeenCalledOnce()
  })

  it('삭제 전에 시작한 목록·상세의 늦은 응답을 무시한다', async () => {
    const { api, result } = harness()
    const pendingList = deferred<ChatConversationPage>()
    const pendingGet = deferred<ChatConversationDetail>()
    vi.mocked(api.list).mockReturnValueOnce(pendingList.promise)
    vi.mocked(api.get).mockReturnValueOnce(pendingGet.promise)
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    let opening!: Promise<boolean>
    act(() => { opening = result.current.open('saved') })
    await act(async () => { await result.current.remove('saved') })
    expect(vi.mocked(api.get).mock.calls[0][2]?.aborted).toBe(true)
    await act(async () => {
      pendingGet.resolve(savedDetail()); pendingList.resolve({ items: [summary('saved')], nextCursor: null })
      expect(await opening).toBe(false)
    })
    expect(result.current.items).toEqual([])
    expect(result.current.activeId).toBeNull()
  })

  it('삭제 실패 시 대화와 목록을 보존하고 재시도 성공 후에만 비운다', async () => {
    const { store, api, result } = harness()
    vi.mocked(api.delete).mockRejectedValueOnce(new Error('offline'))
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    act(() => store.dispatch(interpretationStarted({ message: '보존할 질문', context: emptyConversationContext }, 'keep')))
    await act(async () => { expect(await result.current.remove('keep')).toBe(false) })
    expect(result.current.deleteError).toContain('삭제를 확인하지 못했습니다')
    expect(result.current.items.map((item) => item.id)).toEqual(['keep'])
    expect(result.current.activeId).toBe('keep')
    expect(result.current.deletingId).toBeNull()
    await act(async () => { expect(await result.current.remove('keep')).toBe(true) })
    expect(result.current.deleteError).toBeNull()
    expect(result.current.items).toEqual([])
  })

  it('계정이 바뀌면 삭제 요청을 취소하고 이전 계정의 응답이 새 대화를 초기화하지 않는다', async () => {
    const { store, api, result } = harness()
    const pending = deferred<void>(); vi.mocked(api.delete).mockReturnValueOnce(pending.promise)
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    let removing!: Promise<boolean>
    act(() => { removing = result.current.remove('same-id') })
    act(() => { store.dispatch(signedOut()); store.dispatch(signedIn(other)) })
    act(() => store.dispatch(interpretationStarted({ message: '새 계정 대화', context: emptyConversationContext }, 'same-id')))
    expect(vi.mocked(api.delete).mock.calls[0][2]?.aborted).toBe(true)
    await act(async () => { pending.resolve(); expect(await removing).toBe(false) })
    expect(result.current.items.map((item) => item.id)).toEqual(['same-id'])
    expect(result.current.activeId).toBe('same-id')
    expect(result.current.deletingId).toBeNull()
  })

  it('비로그인·초안·빈 새 대화는 기록을 생성하거나 API를 호출하지 않는다', async () => {
    const { store, api, result } = harness(null)
    act(() => { store.dispatch(draftChanged('작성 중')); store.dispatch(interpretationStarted({ message: '비회원 질문', context: emptyConversationContext })) })
    await act(async () => {})
    expect(api.list).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled(); expect(result.current.items).toEqual([])
    act(() => store.dispatch(signedIn(account)))
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    act(() => { store.dispatch(draftChanged('아직 미전송')); store.dispatch(conversationReset()) })
    expect(api.save).not.toHaveBeenCalled(); expect(result.current.items).toEqual([])
  })

  it('한 대화의 저장 중 도착한 답변은 새 버전으로 이어서 저장하고 새 대화는 별도 기록을 만든다', async () => {
    const { store, api, result } = harness()
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    const pending = deferred<ChatConversationSummary>()
    vi.mocked(api.save).mockReturnValueOnce(pending.promise)
    const started = interpretationStarted({ message: '서울 AI', context: emptyConversationContext }, 'first')
    act(() => store.dispatch(started))
    expect(result.current.items[0].id).toBe('first')
    act(() => store.dispatch(interpretationSucceeded({ requestId: started.payload.requestId, result: readyConversationProposal(seoulConversationContext) })))
    expect(api.save).toHaveBeenCalledOnce()
    await act(async () => pending.resolve(summary('first')))
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.save).mock.calls[1].slice(0, 3)).toEqual([account.email, 'first', 1])
    expect(vi.mocked(api.save).mock.calls[1][3].interpretation.status).toBe('ready')
    act(() => { store.dispatch(conversationReset()); store.dispatch(interpretationStarted({ message: '부산 지원', context: emptyConversationContext }, 'second')) })
    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['second', 'first']))
    expect(result.current.items).toHaveLength(2)
  })

  it('DB 기록을 열면 메시지·검색 결과·조건을 복원하고 미전송 초안·실행 중 요청은 복원하지 않는다', async () => {
    const { store, api, result } = harness()
    const detail = savedDetail()
    vi.mocked(api.get).mockResolvedValue(detail)
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    act(() => store.dispatch(draftChanged('이 창의 미전송 초안')))
    await act(async () => { expect(await result.current.open('saved')).toBe(true) })
    expect(store.getState().chat.messages).toEqual(detail.snapshot.messages)
    expect(store.getState().chat.searchOptions).toEqual(detail.snapshot.searchOptions)
    expect(store.getState().chat).toMatchObject({ draft: '', activeRequestId: null, activeSearchContext: null, searchStatus: 'idle' })
    expect(api.save).not.toHaveBeenCalled()
  })

  it('미확정 제안도 다시 열 수 있고 이전 진행 중 해석의 늦은 응답은 복원 대화에 섞이지 않는다', async () => {
    const { store, api, result } = harness()
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    const first = interpretationStarted({ message: '서울 AI', context: emptyConversationContext }, 'first')
    act(() => { store.dispatch(first); store.dispatch(interpretationSucceeded({ requestId: first.payload.requestId, result: readyConversationProposal(seoulConversationContext) })) })
    const second = interpretationStarted({ message: '부산 AI', context: emptyConversationContext }, 'second')
    act(() => { store.dispatch(conversationReset()); store.dispatch(second) })
    // 진행 중 해석을 두고 다른 대화를 열면(확인은 화면이 먼저 받음) 해석을 끊고 엽니다.
    expect(result.current.needsCancelToOpen('first')).toBe(true)
    await act(async () => { await result.current.open('first') })
    expect(store.getState().chat.interpretation.status).toBe('ready')
    expect(store.getState().chat.pendingProposal).toEqual(seoulConversationContext)
    act(() => store.dispatch(interpretationSucceeded({ requestId: second.payload.requestId, result: { status: 'ANSWERED', answer: '늦은 다른 답변', proposedContext: emptyConversationContext, clarificationQuestion: null, changedFields: [] } })))
    expect(store.getState().chat.messages.some((message) => message.text === '늦은 다른 답변')).toBe(false)
    expect(api.get).not.toHaveBeenCalled()
  })

  it('로그아웃·계정 변경 시 저장과 조회를 취소하고 늦은 응답을 폐기한다', async () => {
    const { store, api, result } = harness()
    const pendingSave = deferred<ChatConversationSummary>(); const pendingGet = deferred<ChatConversationDetail>()
    vi.mocked(api.save).mockReturnValue(pendingSave.promise); vi.mocked(api.get).mockReturnValue(pendingGet.promise)
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    act(() => store.dispatch(interpretationStarted({ message: '개인 질문', context: emptyConversationContext }, 'private')))
    let opening!: Promise<boolean>
    act(() => { opening = result.current.open('saved') })
    act(() => { store.dispatch(signedOut()); store.dispatch(signedIn(other)) })
    expect(vi.mocked(api.save).mock.calls[0][4]?.aborted).toBe(true)
    expect(vi.mocked(api.get).mock.calls[0][2]?.aborted).toBe(true)
    await act(async () => { pendingSave.resolve(summary('private')); pendingGet.resolve(savedDetail()); await opening })
    expect(result.current.items).toEqual([])
    expect(store.getState().chat.messages).toHaveLength(1)
    expect(store.getState().chat.accountEmail).toBe(other.email)
  })

  it('저장 실패를 표시하고 수동 재시도로 현재 창의 최신 기록을 보존한다', async () => {
    const { store, api, result } = harness()
    vi.mocked(api.save).mockRejectedValueOnce(new Error('network'))
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    act(() => store.dispatch(interpretationStarted({ message: '서울 AI', context: emptyConversationContext }, 'first')))
    await waitFor(() => expect(result.current.saveError).toBe(true))
    expect(result.current.items).toHaveLength(1)
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true)
    act(() => result.current.retrySave())
    await waitFor(() => expect(result.current.saveError).toBe(false))
    expect(api.save).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.save).mock.calls[1][2]).toBe(0)
  })

  it('조회 중 새 입력이 생기면 이전 조회가 현재 대화를 덮지 않는다', async () => {
    const { store, api, result } = harness()
    const pending = deferred<ChatConversationDetail>(); vi.mocked(api.get).mockReturnValue(pending.promise)
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    let opening!: Promise<boolean>
    act(() => { opening = result.current.open('saved') })
    act(() => store.dispatch(draftChanged('새 입력')))
    await act(async () => { pending.resolve(savedDetail()); expect(await opening).toBe(false) })
    expect(store.getState().chat.draft).toBe('새 입력')
    expect(store.getState().chat.messages).toHaveLength(1)
  })

  it('목록 오류와 빈 목록을 구분하고 커서로 다음 기록을 중복 없이 붙인다', async () => {
    const { api, result } = harness()
    vi.mocked(api.list).mockRejectedValueOnce(new Error('offline'))
    await waitFor(() => expect(result.current.loadError).toBeTruthy())
    vi.mocked(api.list).mockResolvedValueOnce({ items: [summary('new')], nextCursor: 10 })
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.nextCursor).toBe(10))
    vi.mocked(api.list).mockResolvedValueOnce({ items: [summary('new'), summary('old')], nextCursor: null })
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['new', 'old']))
    expect(vi.mocked(api.list).mock.calls.at(-1)?.slice(0, 2)).toEqual([account.email, 10])
  })
})

describe('진행 중 검색과 대화 열기', () => {
  it('검색 중에는 다른 대화만 확인이 필요하고, 열면 요청을 끊고 취소 상태로 저장한 뒤 연다', async () => {
    const { store, api, result } = harness()
    const detail = savedDetail()
    vi.mocked(api.get).mockResolvedValue(detail)
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    expect(result.current.needsCancelToOpen('saved')).toBe(false)
    const started = searchStarted('대구 R&D', undefined, 'running')
    const controller = new AbortController()
    act(() => {
      store.dispatch(started)
      store.dispatch((_dispatch, _getState, requests) => {
        requests.search = { requestId: started.payload.requestId, controller, timeoutId: setTimeout(() => {}, 90_000), query: '대구 R&D' }
      })
    })
    // 지금 보고 있는 대화를 다시 여는 것은 검색을 끊지 않으므로 확인이 필요 없습니다.
    expect(result.current.needsCancelToOpen('running')).toBe(false)
    expect(result.current.needsCancelToOpen('saved')).toBe(true)
    await act(async () => { expect(await result.current.open('running')).toBe(true) })
    expect(controller.signal.aborted).toBe(false)
    expect(store.getState().chat.searchStatus).toBe('pending')

    await act(async () => { expect(await result.current.open('saved')).toBe(true) })
    expect(controller.signal.aborted).toBe(true)
    expect(store.getState().chat.messages).toEqual(detail.snapshot.messages)
    // 떠난 대화는 '완료되지 않은 검색'이 아니라 취소된 상태(검색어를 초안으로 되돌림)로 저장됩니다.
    const savedRunning = vi.mocked(api.save).mock.calls.filter((call) => call[1] === 'running').at(-1)
    expect(savedRunning?.[3]).toMatchObject({ searchStatus: 'idle', searchError: null })
    expect(savedRunning?.[3].messages.some((message) => message.failure === 'search')).toBe(false)
  })
})
