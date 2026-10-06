// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAppStore } from '../../../app/store'
import { supportPrograms } from '../../../data/fixtures/supportPrograms'
import type { Account } from '../../../domain/entities/Account'
import type { AssistantAnswer } from '../../../domain/entities/AssistantAnswer'
import type { SavedSupportProgram } from '../../../domain/entities/SavedSupportProgram'
import type { AskAssistantUseCase } from '../../../domain/usecases/AskAssistantUseCase'
import type { BrowseSavedSupportProgramsUseCase } from '../../../domain/usecases/SavedSupportProgramUseCases'
import { sessionRestored, signedIn, signedOut } from '../auth/state/authSlice'
import { userMessage } from './assistantConversation'
import { assistantMessages } from './assistantMessages'
import { AssistantWidget } from './AssistantWidget'
import { assistantConversationStorageKey, useAssistantViewModel } from './useAssistantViewModel'

vi.mock('../partner-proposal/useReceivedProposals', () => ({
  useReceivedProposals: () => ({ phase: 'ready', proposals: [], pendingCount: 0, reload: () => undefined }),
}))

const accountA: Account = {
  email: 'account-a@example.test', role: 'USER', tier: 'MEMBER', emailVerified: true,
  hasPassword: true, accountType: null, onboarded: true, company: null,
}
const accountB: Account = { ...accountA, email: 'account-b@example.test' }
type AskResult = Awaited<ReturnType<AskAssistantUseCase['execute']>>

function answer(text: string): AskResult {
  const value: AssistantAnswer = {
    intent: 'PRODUCT_HELP', answer: text, citations: ['search-score-meaning'],
    clarificationQuestion: null, searchQuery: null, accountTopic: null, navigation: null, cards: [],
  }
  return { outcome: 'answered', answer: value }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function seedConversation(accountEmail: string | null, text = 'A 계정의 비공개 대화') {
  window.sessionStorage.setItem(assistantConversationStorageKey, JSON.stringify({
    accountEmail, messages: [userMessage(text)],
    quickReplies: [{ id: 'private-reply', label: 'A 계정의 이전 알약', kind: 'other' }],
  }))
}

function renderAssistant({ account = accountA, restore = true }: { account?: Account | null; restore?: boolean } = {}) {
  const store = createAppStore()
  if (restore) store.dispatch(sessionRestored(account))
  const ask = { execute: vi.fn<AskAssistantUseCase['execute']>().mockResolvedValue(answer('현재 계정의 답변')) }
  const saved = { execute: vi.fn<BrowseSavedSupportProgramsUseCase['execute']>().mockResolvedValue([]) }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}><MemoryRouter initialEntries={['/app/proposals']}>{children}</MemoryRouter></Provider>
  )
  const view = renderHook(() => useAssistantViewModel(saved, () => null, ask, () => true), { wrapper })
  return { ...view, store, ask, saved }
}

function serialized(value: unknown) { return JSON.stringify(value) }

beforeEach(() => {
  window.sessionStorage.clear()
  vi.stubEnv('VITE_ASSISTANT_AI_ENABLED', 'true')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('도우미 인증 세션 분리', () => {
  it('로그아웃하면 대화·알약·패널·저장소를 비우고 비로그인 질문에도 이전 history를 보내지 않는다', async () => {
    seedConversation(accountA.email)
    const view = renderAssistant()
    act(() => view.result.current.open())
    expect(serialized(view.result.current.messages)).toContain('A 계정의 비공개 대화')

    act(() => view.store.dispatch(signedOut()))
    expect(view.result.current.messages).toEqual([])
    expect(view.result.current.quickReplies).toEqual([])
    expect(view.result.current.isOpen).toBe(false)
    expect(view.result.current.hasUnread).toBe(false)
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toBeNull()

    act(() => view.result.current.submitText('로그아웃 뒤 질문'))
    await waitFor(() => expect(view.result.current.isTyping).toBe(false))
    expect(view.ask.execute.mock.calls[0]![0].history).toEqual([])
  })

  it('로그아웃 없이 A에서 B로 signedIn해도 이전 대화를 표시하거나 history로 보내지 않는다', async () => {
    seedConversation(accountA.email)
    const view = renderAssistant()
    act(() => view.result.current.open())
    act(() => view.store.dispatch(signedIn(accountB)))
    expect(view.result.current.messages).toEqual([])
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toBeNull()

    act(() => view.result.current.submitText('B 계정의 첫 질문'))
    await waitFor(() => expect(view.result.current.isTyping).toBe(false))
    const sent = view.ask.execute.mock.calls[0]![0]
    expect(sent.history).toEqual([])
    expect(serialized(view.result.current.messages)).not.toContain('A 계정의 비공개 대화')
  })

  it.each([accountB, null])('sessionRestored로 다른 계정 또는 비로그인 상태가 되면 대화를 비운다: %s', (next) => {
    seedConversation(accountA.email)
    const view = renderAssistant()
    act(() => view.store.dispatch(sessionRestored(next)))
    expect(view.result.current.messages).toEqual([])
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toBeNull()
  })

  it('새로고침의 인증 확인 전에는 캐시를 표시하지 않고 같은 계정이 확인된 뒤에만 복원한다', () => {
    seedConversation(accountA.email)
    const view = renderAssistant({ restore: false })
    expect(view.result.current.isHidden).toBe(true)
    expect(view.result.current.messages).toEqual([])
    act(() => view.result.current.submitText('인증 확인 전 질문'))
    expect(view.ask.execute).not.toHaveBeenCalled()

    act(() => view.store.dispatch(sessionRestored(accountA)))
    expect(serialized(view.result.current.messages)).toContain('A 계정의 비공개 대화')
    act(() => view.store.dispatch(sessionRestored({ ...accountA, emailVerified: false })))
    expect(serialized(view.result.current.messages)).toContain('A 계정의 비공개 대화')
  })

  it('다른 계정 캐시와 소유자 없는 구버전 캐시는 복원하지 않는다', () => {
    seedConversation(accountA.email)
    const other = renderAssistant({ account: accountB })
    expect(other.result.current.messages).toEqual([])
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toBeNull()
    other.unmount()

    window.sessionStorage.setItem(assistantConversationStorageKey, JSON.stringify({
      messages: [userMessage('구버전 비공개 대화')], quickReplies: [],
    }))
    const legacy = renderAssistant()
    expect(legacy.result.current.messages).toEqual([])
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toBeNull()
  })

  it('위젯이 없어도 signedOut/signedIn 이벤트가 대화 저장소를 즉시 정리한다', () => {
    const store = createAppStore()
    store.dispatch(sessionRestored(accountA))
    seedConversation(accountA.email)
    store.dispatch(signedOut())
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toBeNull()
    seedConversation(accountA.email)
    store.dispatch(signedIn(accountB))
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toBeNull()
  })

  it('위젯이 없어도 최초 인증 복원은 다른 소유자 캐시를 비우고 같은 계정 캐시만 유지한다', () => {
    const same = createAppStore()
    seedConversation(accountA.email)
    same.dispatch(sessionRestored(accountA))
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toContain('A 계정의 비공개 대화')

    const other = createAppStore()
    other.dispatch(sessionRestored(accountB))
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toBeNull()

    const guest = createAppStore()
    seedConversation(accountA.email)
    guest.dispatch(sessionRestored(null))
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toBeNull()
  })

  it('auth 변경 직후 이전 렌더의 handler를 호출해도 이전 history를 전송하지 않는다', () => {
    seedConversation(accountA.email)
    const view = renderAssistant()
    const previous = view.result.current
    act(() => {
      view.store.dispatch(signedIn(accountB))
      previous.submitText('이전 handler에서 보낸 질문')
      previous.pickQuickReply({ id: 'saved', label: '이전 계정 관심 공고', kind: 'saved-programs' })
    })
    expect(view.ask.execute).not.toHaveBeenCalled()
    expect(view.saved.execute).not.toHaveBeenCalled()
    expect(view.result.current.messages).toEqual([])
  })

  it('진행 중 AI 요청을 취소하고 같은 계정 재로그인 뒤의 늦은 성공 응답도 버린다', async () => {
    const pending = deferred<AskResult>()
    const view = renderAssistant()
    view.ask.execute.mockReturnValueOnce(pending.promise)
    act(() => view.result.current.submitText('A의 진행 중 질문'))
    const oldSignal = view.ask.execute.mock.calls[0]![1]!
    expect(view.result.current.isTyping).toBe(true)

    act(() => {
      view.store.dispatch(signedOut())
      view.store.dispatch(signedIn(accountA))
    })
    expect(oldSignal.aborted).toBe(true)
    expect(view.result.current.messages).toEqual([])
    expect(view.result.current.isTyping).toBe(false)
    await act(async () => { pending.resolve(answer('이전 로그인에서 돌아온 비공개 답')); await pending.promise })
    expect(view.result.current.messages).toEqual([])
    expect(view.result.current.hasUnread).toBe(false)
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toBeNull()
  })

  it('A 요청의 늦은 실패가 B의 진행 상태·대화·저장소를 바꾸지 않는다', async () => {
    const old = deferred<AskResult>()
    const current = deferred<AskResult>()
    const view = renderAssistant()
    view.ask.execute.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    act(() => view.result.current.submitText('A의 질문'))
    act(() => view.store.dispatch(signedIn(accountB)))
    act(() => view.result.current.submitText('B의 질문'))
    await act(async () => { old.reject(new Error('이전 요청 실패')); await old.promise.catch(() => undefined) })
    expect(view.result.current.isTyping).toBe(true)
    expect(serialized(view.result.current.messages)).not.toContain('A의 질문')
    expect(serialized(view.result.current.messages)).not.toContain(assistantMessages.loadFailed)
    await act(async () => { current.resolve(answer('B의 답변')); await current.promise })
    expect(serialized(view.result.current.messages)).toContain('B의 답변')
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toContain(accountB.email)
  })

  it('진행 중 관심 공고 조회가 계정 전환 뒤 끝나도 이전 계정 카드를 붙이지 않는다', async () => {
    const pending = deferred<SavedSupportProgram[]>()
    const view = renderAssistant()
    view.saved.execute.mockReturnValueOnce(pending.promise)
    act(() => view.result.current.pickQuickReply({ id: 'saved', label: '내 관심 공고', kind: 'saved-programs' }))
    act(() => view.store.dispatch(signedIn(accountB)))
    await act(async () => {
      pending.resolve([{ savedAt: '2026-10-06T00:00:00', program: { ...supportPrograms[0]!, title: 'A의 비공개 관심 공고' } }])
      await pending.promise
    })
    expect(view.result.current.messages).toEqual([])
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toBeNull()
  })

  it('위젯 unmount 뒤 늦은 AI 응답은 Redux 대화와 저장소를 갱신하지 않는다', async () => {
    const pending = deferred<AskResult>()
    const view = renderAssistant()
    view.ask.execute.mockReturnValueOnce(pending.promise)
    act(() => view.result.current.submitText('화면을 떠나기 전 질문'))
    const before = serialized(view.store.getState().assistant.messages)
    const cached = window.sessionStorage.getItem(assistantConversationStorageKey)
    const signal = view.ask.execute.mock.calls[0]![1]!
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(answer('화면 종료 뒤 비공개 답')); await pending.promise })
    expect(serialized(view.store.getState().assistant.messages)).toBe(before)
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).toBe(cached)
  })

  it('실제 패널에서 계정 전환 시 작성 중인 입력 초안도 사라진다', () => {
    const store = createAppStore()
    store.dispatch(sessionRestored(accountA))
    render(<Provider store={store}><MemoryRouter initialEntries={['/app/proposals']}><AssistantWidget /></MemoryRouter></Provider>)
    fireEvent.click(screen.getByRole('button', { name: assistantMessages.openLauncher }))
    const panel = screen.getByRole('dialog', { name: assistantMessages.name })
    fireEvent.change(within(panel).getByRole('textbox', { name: assistantMessages.placeholder }), { target: { value: 'A가 작성 중인 비공개 초안' } })
    act(() => store.dispatch(signedIn(accountB)))
    expect(screen.queryByRole('dialog', { name: assistantMessages.name })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: assistantMessages.openLauncher }))
    expect((within(screen.getByRole('dialog', { name: assistantMessages.name })).getByRole('textbox', { name: assistantMessages.placeholder }) as HTMLTextAreaElement).value).toBe('')
    expect(window.sessionStorage.getItem(assistantConversationStorageKey)).not.toContain('A가 작성 중인 비공개 초안')
  })
})
