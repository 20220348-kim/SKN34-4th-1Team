import { ApiError, apiRequest, createApiFetch, getApiBaseUrl } from './client'

describe('native API boundary', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test' })
  afterEach(() => { globalThis.fetch = originalFetch; delete process.env.EXPO_PUBLIC_API_BASE_URL; jest.useRealTimers() })

  it('rejects an external destination before attaching a token', async () => {
    globalThis.fetch = jest.fn()
    await expect(createApiFetch('private-token')('https://other.example.test/api/v1/auth/me')).rejects.toThrow('허용되지 않은')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('never mixes bearer requests with browser cookies', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 })
    await createApiFetch('private-token')('https://api.example.test/api/v1/auth/mobile/logout', {
      method: 'POST', credentials: 'include', headers: { Cookie: 'govbiz_session=browser-session' },
    })
    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
    expect(init.headers.get('Cookie')).toBeNull()
    expect(init.headers.get('Authorization')).toBe('Bearer private-token')
  })

  it('preserves cancellation and rejects unsafe base URLs', async () => {
    const controller = new AbortController(); controller.abort()
    globalThis.fetch = jest.fn().mockImplementation((_url, init) => {
      expect(init.signal.aborted).toBe(true)
      return Promise.reject(new Error('aborted'))
    })
    await expect(createApiFetch()('https://api.example.test/api/v1/auth/me', { signal: controller.signal })).rejects.toThrow('aborted')
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://user:password@api.example.test'
    expect(getApiBaseUrl).toThrow('HTTPS origin')
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://public.example.test'
    expect(getApiBaseUrl).toThrow('HTTPS origin')
  })

  it('exposes only stable error metadata, not private server details', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429,
      json: async () => ({ code: 'RATE_LIMITED', retryAfterSeconds: 30, detail: 'private database details' }) })
    try {
      await apiRequest('/api/v1/auth/mobile/login', { method: 'POST', body: { email: 'a@example.test' } })
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 30 })
      expect((error as Error).message).not.toContain('database')
    }
  })
})
