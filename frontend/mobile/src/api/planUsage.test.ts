import { planUsageUseCase } from './planUsage'

const originalFetch = globalThis.fetch
const resetsAt = '2026-10-09T00:00:00+09:00'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test' })
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.EXPO_PUBLIC_API_BASE_URL })

test('guests read the trial usage of their connection without a token or cookies', async () => {
  const trial = { plan: null, items: [{ feature: 'AI_SEARCH', period: 'DAY', limit: 2, used: 1, resetsAt }] }
  globalThis.fetch = jest.fn().mockResolvedValue(json(trial))
  await expect(planUsageUseCase().usage()).resolves.toEqual({ ...trial, planEndsAt: null, planSource: null, trialsAvailable: [] })
  const [url, init] = jest.mocked(fetch).mock.calls[0]
  expect(url).toBe('https://api.example.test/api/v1/plan-usage')
  expect(init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store' })
  expect(new Headers(init?.headers).get('Authorization')).toBeNull()
})

test('members read their pass with the bearer session and a newer unknown feature does not hide the rest', async () => {
  const endsAt = '2026-10-31T15:30:00+09:00'
  const search = { feature: 'AI_SEARCH', period: 'PLAN', limit: 500, used: 2, resetsAt: endsAt }
  globalThis.fetch = jest.fn().mockResolvedValue(json({
    plan: 'PLUS', planEndsAt: endsAt, items: [search, { feature: 'FUTURE_FEATURE', period: 'DAY', limit: 1, used: 0, resetsAt }],
  }))
  await expect(planUsageUseCase('owner').usage()).resolves.toEqual({ plan: 'PLUS', planEndsAt: endsAt, planSource: null, trialsAvailable: [], items: [search] })
  expect(new Headers(jest.mocked(fetch).mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer owner')
})

test('an invalid response or an unchecked usage is an error instead of an empty usage', async () => {
  globalThis.fetch = jest.fn().mockResolvedValue(json({ plan: 'GOLD', items: [] }))
  await expect(planUsageUseCase('owner').usage()).rejects.toThrow()
  globalThis.fetch = jest.fn().mockResolvedValue(json({ status: 503, code: 'QUOTA_UNAVAILABLE' }, 503))
  await expect(planUsageUseCase('owner').usage()).rejects.toMatchObject({ status: 503, code: 'QUOTA_UNAVAILABLE' })
})
