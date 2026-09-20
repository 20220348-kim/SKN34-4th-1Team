import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { z } from 'zod'
import { accountDtoSchema, currentAccountResponseDtoSchema, toAccount } from '@govbiz/shared/data/models/AccountDto'
import type { Account } from '@govbiz/shared/domain/entities/Account'
import type { AccountSignUp } from '@govbiz/shared/domain/repositories/AccountRepository'
import { normalizeEmail } from '@govbiz/shared/domain/usecases/LogInUseCase'
import { apiRequest, ApiError, getApiBaseUrl } from '../api/client'
import { openOAuthLogin, type MobileOAuthProvider } from './oauth'
import { clearStoredSession, readStoredSession, saveStoredSession, type StoredSession } from './storage'

const mobileSessionSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  expiresAt: z.string().datetime({ offset: true }),
  account: accountDtoSchema,
})
export type MobileSession = StoredSession & { account: Account }
type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'unavailable'
type AuthContextValue = {
  status: AuthStatus
  session: MobileSession | null
  restoreError: string | null
  signIn(email: string, password: string): Promise<void>
  signUp(input: AccountSignUp): Promise<void>
  signInWithOAuth(provider: MobileOAuthProvider): Promise<void>
  signOut(): Promise<void>
  invalidateSession(): Promise<void>
  refreshSession(): Promise<void>
}
const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [session, setSession] = useState<MobileSession | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const sessionRef = useRef<MobileSession | null>(null)
  const credentialsRef = useRef<StoredSession | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const revisionRef = useRef(0)
  const baseUrl = getApiBaseUrl()

  const beginRequest = useCallback(() => {
    requestRef.current?.abort()
    requestRef.current = new AbortController()
    revisionRef.current += 1
    return { revision: revisionRef.current, signal: requestRef.current.signal }
  }, [])

  const invalidateSession = useCallback(async () => {
    beginRequest()
    sessionRef.current = null
    credentialsRef.current = null
    setSession(null)
    setStatus('signedOut')
    setRestoreError(null)
    try {
      await clearStoredSession(baseUrl)
    } catch {
      setRestoreError('기기에 저장된 로그인 정보를 지우지 못했습니다. 앱을 닫기 전에 로그아웃을 다시 시도해 주세요.')
      throw new Error('기기의 로그인 정보를 지우지 못했습니다. 다시 시도해 주세요.')
    }
  }, [baseUrl, beginRequest])

  const refreshSession = useCallback(async () => {
    const { revision, signal } = beginRequest()
    const current = sessionRef.current
    if (!current) setStatus('loading')
    setRestoreError(null)
    try {
      const stored = current ?? await readStoredSession(baseUrl)
      if (revision !== revisionRef.current) return
      if (!stored || Date.parse(stored.expiresAt) <= Date.now()) {
        await invalidateSession()
        return
      }
      credentialsRef.current = stored
      const response = currentAccountResponseDtoSchema.parse(await apiRequest('/api/v1/auth/me', { accessToken: stored.accessToken, signal }))
      if (revision !== revisionRef.current) return
      const next = { ...stored, account: toAccount(response.account) }
      sessionRef.current = next
      setSession(next)
      setStatus('signedIn')
    } catch (error) {
      if (signal.aborted || revision !== revisionRef.current) return
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        await invalidateSession().catch(() => undefined)
        return
      }
      // An offline device must not discard a still-valid token or render another user's data.
      if (!current) {
        setSession(null)
        setStatus('unavailable')
      }
      setRestoreError('로그인 상태를 확인하지 못했습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.')
    }
  }, [baseUrl, beginRequest, invalidateSession])

  const authenticate = useCallback(async (path: string, body: unknown) => {
    const { revision, signal } = beginRequest()
    const response = mobileSessionSchema.parse(await apiRequest(path, { method: 'POST', body, signal }))
    if (signal.aborted || revision !== revisionRef.current) return
    if (Date.parse(response.expiresAt) <= Date.now()) throw new Error('만료된 로그인 응답입니다. 다시 로그인해 주세요.')
    const next: MobileSession = { accessToken: response.accessToken, expiresAt: response.expiresAt, account: toAccount(response.account) }
    credentialsRef.current = next
    try {
      await saveStoredSession(baseUrl, next)
    } catch {
      await apiRequest('/api/v1/auth/mobile/logout', { method: 'POST', accessToken: next.accessToken }).catch(() => undefined)
      throw new Error('로그인 정보를 기기에 안전하게 저장하지 못했습니다. 다시 시도해 주세요.')
    }
    if (signal.aborted || revision !== revisionRef.current) return
    sessionRef.current = next
    setSession(next)
    setStatus('signedIn')
    setRestoreError(null)
  }, [baseUrl, beginRequest])

  const signIn = useCallback((email: string, password: string) => authenticate('/api/v1/auth/mobile/login', {
    email: normalizeEmail(email), password, rememberMe: true,
  }), [authenticate])
  const signUp = useCallback((input: AccountSignUp) => authenticate('/api/v1/auth/mobile/signup', {
    ...input, email: normalizeEmail(input.email),
  }), [authenticate])
  const signInWithOAuth = useCallback(async (provider: MobileOAuthProvider) => {
    const { revision, signal } = beginRequest()
    const exchange = await openOAuthLogin(provider)
    if (!exchange || signal.aborted || revision !== revisionRef.current) return
    await authenticate('/api/v1/auth/mobile/oauth/exchange', exchange)
  }, [authenticate, beginRequest])
  const signOut = useCallback(async () => {
    const current = credentialsRef.current
    let localError: unknown = null
    try { await invalidateSession() } catch (error) { localError = error }
    if (current) {
      try {
        await apiRequest('/api/v1/auth/mobile/logout', { method: 'POST', accessToken: current.accessToken })
      } catch {
        throw new Error(localError ? '기기 로그인 정보와 서버 세션을 지우지 못했습니다. 로그아웃을 다시 시도해 주세요.' : '이 기기에서 로그아웃했습니다. 서버 세션은 연결 문제로 종료하지 못해 만료 시 종료됩니다.')
      }
    }
    if (localError) throw localError
  }, [invalidateSession])

  useEffect(() => {
    void refreshSession()
    return () => { requestRef.current?.abort(); revisionRef.current += 1 }
  }, [refreshSession])

  useEffect(() => {
    if (!session) return
    let timer: ReturnType<typeof setTimeout>
    const checkExpiration = () => {
      clearTimeout(timer)
      const remaining = Date.parse(session.expiresAt) - Date.now()
      if (remaining <= 0) void invalidateSession().catch(() => undefined)
      else timer = setTimeout(checkExpiration, Math.min(remaining, 2_147_483_647))
    }
    checkExpiration()
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') checkExpiration() })
    return () => { clearTimeout(timer); subscription.remove() }
  }, [session, invalidateSession])

  return <AuthContext.Provider value={{ status, session, restoreError, signIn, signUp, signInWithOAuth, signOut, invalidateSession, refreshSession }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (value === null) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
