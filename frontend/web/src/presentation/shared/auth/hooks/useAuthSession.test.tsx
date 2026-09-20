// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Provider } from 'react-redux'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAppStore } from '../../../../app/store'
import { selectAuthStatus, sessionRestored } from '../state/authSlice'
import { authSessionMessages, useAuthSession, useRestoreAuthSession } from './useAuthSession'

afterEach(cleanup)

const account = { email: 'manager@company.co.kr', role: 'USER' as const, tier: 'MEMBER' as const, emailVerified: false, hasPassword: true, company: null }
const adminSession = {
  expiresAt: '2026-10-06T12:00:00+09:00',
  account: { email: 'admin@govbiz.local', role: 'ADMIN' as const, tier: 'ADMIN' as const, emailVerified: true, hasPassword: true, company: null },
}

describe('useRestoreAuthSession', () => {
  it('restores the stored session once and marks the app authenticated', async () => {
    const store = createAppStore()
    const execute = vi.fn().mockResolvedValue(account)

    const { rerender } = renderHook(() => useRestoreAuthSession({ execute }), { wrapper: createWrapper(store) })

    await waitFor(() => expect(selectAuthStatus(store.getState())).toBe('authenticated'))
    rerender()
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('falls back to anonymous when the restore request fails', async () => {
    const store = createAppStore()
    const execute = vi.fn().mockRejectedValue(new Error('network'))

    renderHook(() => useRestoreAuthSession({ execute }), { wrapper: createWrapper(store) })

    await waitFor(() => expect(selectAuthStatus(store.getState())).toBe('anonymous'))
  })

  it('does not call the use case again when the status is already known', () => {
    const store = createAppStore()
    store.dispatch(sessionRestored(null))
    const execute = vi.fn()

    renderHook(() => useRestoreAuthSession({ execute }), { wrapper: createWrapper(store) })

    expect(execute).not.toHaveBeenCalled()
  })
})

describe('useAuthSession', () => {
  it('exposes the account and signs out even if the server logout fails', async () => {
    const store = createAppStore()
    store.dispatch(sessionRestored(account))
    const execute = vi.fn().mockRejectedValue(new Error('server down'))

    const { result } = renderHook(() => useAuthSession({ execute }, { execute: vi.fn() }), { wrapper: createWrapper(store) })

    expect(result.current.isAuthenticated).toBe(true)
    expect(result.current.account).toEqual(account)

    await act(async () => {
      await result.current.logOut()
    })

    expect(execute).toHaveBeenCalledOnce()
    expect(result.current.isAuthenticated).toBe(false)
    expect(result.current.account).toBeNull()
  })

  it('signs in as the requested seed role and reports a failure without changing the state', async () => {
    const store = createAppStore()
    store.dispatch(sessionRestored(null))
    const execute = vi.fn().mockResolvedValueOnce(adminSession).mockRejectedValueOnce(new Error('404'))

    const { result } = renderHook(() => useAuthSession({ execute: vi.fn() }, { execute }), { wrapper: createWrapper(store) })

    await act(async () => {
      await expect(result.current.logInAsDeveloper('ADMIN')).resolves.toBe(true)
    })
    expect(execute).toHaveBeenCalledWith('ADMIN')
    expect(result.current.account).toEqual(adminSession.account)
    expect(result.current.devLogInError).toBeNull()

    await act(async () => {
      await result.current.logOut()
    })
    await act(async () => {
      await expect(result.current.logInAsDeveloper('USER')).resolves.toBe(false)
    })
    expect(execute).toHaveBeenLastCalledWith('USER')
    expect(result.current.isAuthenticated).toBe(false)
    expect(result.current.devLogInError).toBe(authSessionMessages.devLogInFailed)
  })
})

function createWrapper(store: ReturnType<typeof createAppStore>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>
  }
}
