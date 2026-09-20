import { describe, expect, it } from 'vitest'

import { createAppStore } from '../../../../app/store'
import {
  selectAuthStatus,
  selectCurrentAccount,
  selectIsAuthenticated,
  sessionRestored,
  signedIn,
  signedOut,
} from './authSlice'

const account = { email: 'manager@company.co.kr', role: 'USER' as const, tier: 'MEMBER' as const, emailVerified: false, hasPassword: true, company: null }

describe('authSlice', () => {
  it('starts unknown until the stored session is checked', () => {
    const store = createAppStore()

    expect(selectAuthStatus(store.getState())).toBe('unknown')
    expect(selectIsAuthenticated(store.getState())).toBe(false)

    store.dispatch(sessionRestored(null))
    expect(selectAuthStatus(store.getState())).toBe('anonymous')
    expect(selectCurrentAccount(store.getState())).toBeNull()
  })

  it('keeps the account while signed in and drops it on sign-out', () => {
    const store = createAppStore()

    store.dispatch(sessionRestored(account))
    expect(selectIsAuthenticated(store.getState())).toBe(true)

    store.dispatch(signedOut())
    expect(selectAuthStatus(store.getState())).toBe('anonymous')

    store.dispatch(signedIn(account))
    expect(selectCurrentAccount(store.getState())).toEqual(account)
  })
})
