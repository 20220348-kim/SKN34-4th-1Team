import { Text } from 'react-native'
import { act, render, waitFor } from '@testing-library/react-native'
import * as SecureStore from 'expo-secure-store'
import { apiRequest, ApiError } from '../api/client'
import { AuthProvider, useAuth } from './session'

jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' }))
jest.mock('./oauth', () => ({ openOAuthLogin: jest.fn() }))
jest.mock('../api/client', () => ({
  apiRequest: jest.fn(), getApiBaseUrl: () => 'https://api.example.com',
  ApiError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status } },
}))

const account = { email: 'first@example.com', role: 'USER', tier: 'MEMBER', emailVerified: true, company: null, hasPassword: true, accountType: null, onboardingPurpose: null, onboarded: true }
const response = () => ({ accessToken: 'test-token', tokenType: 'Bearer', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), account })
let current: ReturnType<typeof useAuth>
function Probe() { current = useAuth(); return <Text>{current.status}:{current.session?.account.email ?? 'none'}</Text> }
function mount() { return render(<AuthProvider><Probe /></AuthProvider>) }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (value: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => {
  jest.mocked(SecureStore.getItemAsync).mockReset().mockResolvedValue(null)
  jest.mocked(SecureStore.setItemAsync).mockReset().mockResolvedValue(undefined)
  jest.mocked(SecureStore.deleteItemAsync).mockReset().mockResolvedValue(undefined)
  jest.mocked(apiRequest).mockReset()
})
afterEach(() => jest.useRealTimers())

test('restored credentials are verified before revealing any account', async () => {
  const stored = response()
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify(stored))
  const request = deferred<unknown>()
  jest.mocked(apiRequest).mockReturnValue(request.promise)
  const view = mount()
  await waitFor(() => expect(apiRequest).toHaveBeenCalled())
  expect(view.getByText('loading:none')).toBeTruthy()
  await act(async () => request.resolve({ account }))
  expect(view.getByText('signedIn:first@example.com')).toBeTruthy()
})

test('a revoked token is removed while an offline restore retains credentials for retry', async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify(response()))
  jest.mocked(apiRequest).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new ApiError(401, 'expired'))
  const view = mount()
  await waitFor(() => expect(view.getByText('unavailable:none')).toBeTruthy())
  expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled()
  await act(async () => current.refreshSession())
  expect(view.getByText('signedOut:none')).toBeTruthy()
  expect(SecureStore.deleteItemAsync).toHaveBeenCalled()
})

test('sign-in writes only token and expiry to device-only storage', async () => {
  const session = response()
  jest.mocked(apiRequest).mockResolvedValue(session)
  mount()
  await waitFor(() => expect(current.status).toBe('signedOut'))
  await act(async () => current.signIn(' FIRST@example.com ', 'password123'))
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/auth/mobile/login', expect.objectContaining({ body: { email: 'first@example.com', password: 'password123', rememberMe: true } }))
  const persisted = JSON.parse(jest.mocked(SecureStore.setItemAsync).mock.calls[0][1])
  expect(persisted).toEqual({ accessToken: session.accessToken, expiresAt: session.expiresAt })
  expect(jest.mocked(SecureStore.setItemAsync).mock.calls[0][2]).toEqual({ keychainAccessible: 'device-only' })
})

test('a late sign-in response cannot sign a user back in after logout', async () => {
  const request = deferred<unknown>()
  jest.mocked(apiRequest).mockReturnValue(request.promise)
  mount()
  await waitFor(() => expect(current.status).toBe('signedOut'))
  let signingIn!: Promise<void>
  await act(async () => { signingIn = current.signIn('first@example.com', 'password123') })
  await act(async () => current.signOut())
  await act(async () => { request.resolve(response()); await signingIn })
  expect(current.status).toBe('signedOut')
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
})

test('logout clears local state and reports a failed server revocation', async () => {
  jest.mocked(apiRequest).mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('offline'))
  mount()
  await waitFor(() => expect(current.status).toBe('signedOut'))
  await act(async () => current.signIn('first@example.com', 'password123'))
  await act(async () => { await expect(current.signOut()).rejects.toThrow('이 기기에서 로그아웃했습니다') })
  expect(current.session).toBeNull()
  expect(current.status).toBe('signedOut')
  expect(SecureStore.deleteItemAsync).toHaveBeenCalled()
})

test('session expiration removes private account state and stored credentials', async () => {
  jest.useFakeTimers()
  const expiresAt = new Date(Date.now() + 1000).toISOString()
  jest.mocked(apiRequest).mockResolvedValue({ ...response(), expiresAt })
  mount()
  await act(async () => {})
  await act(async () => current.signIn('first@example.com', 'password123'))
  expect(current.status).toBe('signedIn')
  await act(async () => { jest.advanceTimersByTime(1001) })
  expect(current.status).toBe('signedOut')
  expect(current.session).toBeNull()
  expect(SecureStore.deleteItemAsync).toHaveBeenCalled()
})

test('sign-out during a pending secure write prevents a stale login and deletes after that write', async () => {
  const write = deferred<void>()
  jest.mocked(SecureStore.setItemAsync).mockReturnValueOnce(write.promise)
  jest.mocked(apiRequest).mockResolvedValue(response())
  mount()
  await waitFor(() => expect(current.status).toBe('signedOut'))
  let signingIn!: Promise<void>
  await act(async () => { signingIn = current.signIn('first@example.com', 'password123') })
  await waitFor(() => expect(SecureStore.setItemAsync).toHaveBeenCalled())
  let signingOut!: Promise<void>
  await act(async () => { signingOut = current.signOut() })
  expect(current.status).toBe('signedOut')
  await act(async () => { write.resolve(); await signingIn; await signingOut })
  expect(current.status).toBe('signedOut')
  expect(current.session).toBeNull()
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/auth/mobile/logout', expect.objectContaining({ accessToken: 'test-token' }))
})

test('an old restore response cannot replace a newer login', async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify(response()))
  const restore = deferred<unknown>()
  jest.mocked(apiRequest).mockReturnValueOnce(restore.promise).mockResolvedValueOnce({ ...response(), accessToken: 'new-token', account: { ...account, email: 'second@example.com' } })
  mount()
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/v1/auth/me', expect.anything()))
  await act(async () => current.signIn('second@example.com', 'password123'))
  await act(async () => restore.resolve({ account }))
  expect(current.session?.account.email).toBe('second@example.com')
  expect(current.session?.accessToken).toBe('new-token')
})
