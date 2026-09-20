// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAppStore } from '../../../app/store'
import { supportPrograms } from '../../../data/fixtures/supportPrograms'
import { sessionRestored } from '../auth/state/authSlice'
import {
  supportProgramSaveMessages,
  supportProgramSaveNoticeDurationMs,
  useSupportProgramSaveViewModel,
} from './useSupportProgramSaveViewModel'

const identity = { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN-1' }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

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
    expect(useCases.remove.execute).toHaveBeenCalledWith(identity)
  })

  it('비로그인은 요청 없이 로그인 뒤 같은 공고로 돌아오는 경로만 만든다', () => {
    const check = vi.fn()
    const { result } = renderHook(() => useSupportProgramSaveViewModel(identity, { check: { execute: check } }), { wrapper: wrapper(false) })

    expect(result.current.isAuthenticated).toBe(false)
    expect(result.current.loginPath).toBe(`/login?next=${encodeURIComponent('/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN-1')}`)
    expect(check).not.toHaveBeenCalled()
  })
})
