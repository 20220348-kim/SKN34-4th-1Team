import { PlanQuotaExceededError, QuotaUnavailableError } from '@govbiz/shared/domain/errors/PlanQuotaError'
import { ApiError, apiRequest, createApiFetch, errorMessage, getApiBaseUrl, programClient, readProgramDetail, requestResultUnconfirmed, requestRetryAfterSeconds } from './client'
import { SupportProgramInterpretationApiError, SupportProgramRequestApiError, SupportProgramSearchTimeoutApiError } from '@govbiz/shared/data/api/supportProgramApi'
import { programDetail } from '../test/preparationFixtures'

test('validated request failures distinguish interpretation, admission and unconfirmed search results', () => {
  const limited = new SupportProgramRequestApiError('SUPPORT_PROGRAM_RATE_LIMITED', 20)
  expect(requestRetryAfterSeconds(limited)).toBe(20)
  expect(requestResultUnconfirmed(limited)).toBe(false)
  expect(errorMessage(limited)).toContain('요청이 많아요')
  const timeout = new SupportProgramSearchTimeoutApiError()
  expect(requestResultUnconfirmed(timeout)).toBe(true)
  expect(requestResultUnconfirmed(new TypeError('Network request failed'))).toBe(true)
  expect(requestRetryAfterSeconds(timeout)).toBeNull()
  expect(errorMessage(timeout)).toContain('새 요청')
  expect(errorMessage(new SupportProgramInterpretationApiError('unavailable'))).toContain('조건 해석')
  expect(requestRetryAfterSeconds(new ApiError(429, 'invalid wait', null, Number.MAX_VALUE))).toBeNull()
})

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


describe('plan quota problems', () => {
  const originalFetch = globalThis.fetch
  const usedUp = '오늘 AI 대화 검색 10회를 모두 썼어요. 자정(서울 시간)에 다시 채워져요. 필터 검색은 계속 쓸 수 있어요.'
  const unavailable = '지금은 이용량을 확인할 수 없어 실행하지 않았어요. 잠시 후 다시 시도해 주세요.'
  const exceeded = { code: 'PLAN_QUOTA_EXCEEDED', feature: 'AI_SEARCH', period: 'DAY', plan: 'FREE', limit: 10, used: 10,
    resetsAt: '2026-10-09T00:00:00+09:00', retryAfterSeconds: 3600, detail: 'private server text' }
  const problem = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify({ status, ...body }),
    { status, headers: { 'Content-Type': 'application/problem+json' } })
  beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test' })
  afterEach(() => { globalThis.fetch = originalFetch; delete process.env.EXPO_PUBLIC_API_BASE_URL })

  it('explains a used-up plan limit with the shared message and keeps its retry time', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(problem(429, exceeded))
    const failure = await apiRequest('/api/v1/support-programs/search', { method: 'POST', body: { query: '사업화 지원' }, accessToken: 'owner' })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 429, code: 'PLAN_QUOTA_EXCEEDED', retryAfterSeconds: 3600, message: usedUp })
    expect(errorMessage(failure)).toBe(usedUp)
  })

  it('reports an unchecked plan usage as a failure instead of a normal result', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(problem(503, { code: 'QUOTA_UNAVAILABLE' }))
    await expect(apiRequest('/api/v1/plan-usage')).rejects.toMatchObject({ status: 503, code: 'QUOTA_UNAVAILABLE', message: unavailable })
  })

  it('keeps the per-minute request limit separate from the plan limit', async () => {
    const search = { method: 'POST', body: { query: '사업화 지원' } }
    globalThis.fetch = jest.fn().mockResolvedValue(problem(429, { code: 'SUPPORT_PROGRAM_RATE_LIMITED', retryAfterSeconds: 30 }))
    await expect(apiRequest('/api/v1/support-programs/search', search)).rejects.toMatchObject({ status: 429, code: 'SUPPORT_PROGRAM_RATE_LIMITED',
      retryAfterSeconds: 30, message: '요청이 많습니다. 잠시 후 다시 시도해 주세요.' })
    // 계약과 다른 한도 응답은 한도 안내로 꾸미지 않습니다.
    globalThis.fetch = jest.fn().mockResolvedValue(problem(429, { ...exceeded, feature: 'UNKNOWN_FEATURE' }))
    await expect(apiRequest('/api/v1/support-programs/search', search)).rejects.toMatchObject({ status: 429, message: '요청이 많습니다. 잠시 후 다시 시도해 주세요.' })
  })

  it('shows the shared message for quota errors thrown by the shared program client', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(problem(429, exceeded))
    const failure = await programClient('owner').search({ query: '사업화 지원', acceptingOnly: true }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PlanQuotaExceededError)
    expect(errorMessage(failure)).toBe(usedUp)
    expect(errorMessage(new QuotaUnavailableError())).toBe(unavailable)
  })
})

describe('mobile detail reader through the shared HTTP client', () => {
  const originalFetch = globalThis.fetch
  const identity = { sourceCode: 'BIZINFO', sourceProgramId: 'P/123' }
  beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test' })
  afterEach(() => { globalThis.fetch = originalFetch; delete process.env.EXPO_PUBLIC_API_BASE_URL })

  it('reads the selected public detail as an internal model through the configured mobile fetch', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ ...programDetail, regions: ['서울'], categories: ['기술'], internalDebug: 'server-only' }) })
    const result = await readProgramDetail(programClient('owner'), identity)
    expect(result).toMatchObject({ id: identity.sourceProgramId, title: programDetail.title, regions: ['서울'], categories: ['기술'] })
    expect(result).not.toHaveProperty('internalDebug')
    const [request, init] = (globalThis.fetch as jest.Mock).mock.calls[0]
    const url = new URL(request)
    expect(url.origin).toBe('https://api.example.test')
    expect(url.searchParams.get('sourceCode')).toBe(identity.sourceCode)
    expect(url.searchParams.get('sourceProgramId')).toBe(identity.sourceProgramId)
    expect(init.headers.get('Authorization')).toBe('Bearer owner')
    expect(init.credentials).toBe('omit')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps an absent detail distinct from a failed request', async () => {
    const json = jest.fn()
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, json })
    await expect(readProgramDetail(programClient(), identity)).resolves.toBeNull()
    expect(json).not.toHaveBeenCalled()
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 })
    await expect(readProgramDetail(programClient(), identity)).rejects.toThrow()
  })

  it.each([
    { ...programDetail, id: 'another-program' },
    { ...programDetail, regions: '서울' },
  ])('rejects an incorrect identity or invalid DTO before exposing detail data', async payload => {
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload })
    await expect(readProgramDetail(programClient(), identity)).rejects.toThrow()
  })
})
