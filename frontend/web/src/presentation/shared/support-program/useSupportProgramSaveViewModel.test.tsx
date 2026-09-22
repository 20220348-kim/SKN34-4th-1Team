// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAppStore } from '../../../app/store'
import { supportPrograms } from '../../../data/fixtures/supportPrograms'
import { sessionRestored, signedIn, signedOut } from '../auth/state/authSlice'
import {
  supportProgramSaveMessages,
  supportProgramSaveNoticeDurationMs,
  useSupportProgramSaveViewModel,
} from './useSupportProgramSaveViewModel'

const identity = { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN-1' }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

function wrapper(authenticated: boolean) {
  const store = createAppStore()
  store.dispatch(sessionRestored(authenticated ? { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null } : null))
  return ({ children }: { children: ReactNode }) => (
    <Provider store={store}><MemoryRouter initialEntries={['/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN-1']}>{children}</MemoryRouter></Provider>
  )
}

describe('useSupportProgramSaveViewModel', () => {
  it('담은 뒤 안내는 정해진 시간이 지나면 스스로 사라지고, 같은 문구가 다시 나오면 다시 센다', async () => {
    const useCases = {
      check: { execute: vi.fn().mockResolvedValue(false) },
      save: { execute: vi.fn().mockResolvedValue({ outcome: 'saved', saved: { savedAt: '2026-09-12T10:00:00', program: supportPrograms[0]! } }) },
      remove: { execute: vi.fn().mockResolvedValue(undefined) },
    }
    const { result } = renderHook(() => useSupportProgramSaveViewModel(identity, useCases), { wrapper: wrapper(true) })
    await act(async () => { await Promise.resolve() })
    expect(result.current.isSaved).toBe(false)

    await act(async () => { await result.current.toggle() })
    expect(result.current.isSaved).toBe(true)
    expect(result.current.notice?.text).toBe(supportProgramSaveMessages.saved)

    act(() => { vi.advanceTimersByTime(supportProgramSaveNoticeDurationMs - 1) })
    expect(result.current.notice?.text).toBe(supportProgramSaveMessages.saved)
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current.notice).toBeNull()

    // 빼기 뒤에도 안내가 새로 세어져 다시 사라집니다.
    await act(async () => { await result.current.toggle() })
    expect(result.current.notice?.text).toBe(supportProgramSaveMessages.removed)
    act(() => { vi.advanceTimersByTime(supportProgramSaveNoticeDurationMs) })
    expect(result.current.notice).toBeNull()
    expect(useCases.remove.execute).toHaveBeenCalledWith(identity, expect.any(AbortSignal))
  })

  it('비로그인은 요청 없이 로그인 뒤 같은 공고로 돌아오는 경로만 만든다', () => {
    const check = vi.fn()
    const { result } = renderHook(() => useSupportProgramSaveViewModel(identity, { check: { execute: check } }), { wrapper: wrapper(false) })

    expect(result.current.isAuthenticated).toBe(false)
    expect(result.current.loginPath).toBe(`/login?next=${encodeURIComponent('/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN-1')}`)
    expect(check).not.toHaveBeenCalled()
  })
})


describe('관심 공고 저장 요청 수명', () => {
  function setup() {
    const store = createAppStore()
    store.dispatch(signedIn({ email: 'first@example.com', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null }))
    const useCases = {
      check: { execute: vi.fn().mockResolvedValue(false) },
      save: { execute: vi.fn() },
      remove: { execute: vi.fn() },
    }
    const Wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}><MemoryRouter>{children}</MemoryRouter></Provider>
    const hook = renderHook(({ program }) => useSupportProgramSaveViewModel(program, useCases), { initialProps: { program: identity }, wrapper: Wrapper })
    return { ...hook, store, useCases }
  }

  it('이전 공고의 늦은 저장 응답을 새 공고에 반영하지 않는다', async () => {
    const save = deferred<{ outcome: 'saved'; saved: { savedAt: string; program: typeof supportPrograms[number] } }>()
    const { result, rerender, useCases } = setup()
    useCases.save.execute.mockReturnValue(save.promise)
    await act(async () => {})
    let pending!: Promise<void>
    act(() => { pending = result.current.toggle() })
    const savingSignal = useCases.save.execute.mock.calls[0]?.[1] as AbortSignal | undefined
    rerender({ program: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN-2' } })
    await act(async () => {})
    await act(async () => { save.resolve({ outcome: 'saved', saved: { savedAt: '2026-09-22T10:00:00', program: supportPrograms[0]! } }); await pending })
    expect(result.current.isSaved).toBe(false)
    expect(result.current.notice).toBeNull()
    expect(result.current.isBusy).toBe(false)
    expect(savingSignal?.aborted).toBe(true)
  })

  it('로그인 계정이 바뀌면 같은 공고도 저장 상태를 다시 확인한다', async () => {
    const { result, store, useCases } = setup()
    await act(async () => {})
    useCases.check.execute.mockResolvedValueOnce(true)
    await act(async () => { store.dispatch(signedIn({ email: 'second@example.com', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null })) })
    expect(useCases.check.execute).toHaveBeenCalledTimes(2)
    expect(result.current.isSaved).toBe(true)
    await act(async () => { store.dispatch(signedOut()) })
    expect(result.current.isSaved).toBeNull()
  })

  it('같은 이벤트에서 연속 호출해도 저장 요청을 한 번만 보낸다', async () => {
    const save = deferred<{ outcome: 'not-found' }>()
    const { result, useCases } = setup()
    useCases.save.execute.mockReturnValue(save.promise)
    await act(async () => {})
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => { first = result.current.toggle(); second = result.current.toggle() })
    await act(async () => { save.resolve({ outcome: 'not-found' }); await Promise.all([first, second]) })
    expect(useCases.save.execute).toHaveBeenCalledTimes(1)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
