import { planUsageUseCase } from './planUsage'

const originalFetch = globalThis.fetch
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test' })
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.EXPO_PUBLIC_API_BASE_URL })

test('guests read no plan without a token or cookies', async () => {
  globalThis.fetch = jest.fn().mockResolvedValue(json({ plan: null }))
  await expect(planUsageUseCase().usage()).resolves.toEqual({ plan: null })
  const [url, init] = jest.mocked(fetch).mock.calls[0]
  expect(url).toBe('https://api.example.test/api/v1/plan-usage')
  expect(init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store' })
  expect(new Headers(init?.headers).get('Authorization')).toBeNull()
})

test('members read their plan with the bearer session and newer fields do not break it', async () => {
  globalThis.fetch = jest.fn().mockResolvedValue(json({ plan: 'PLUS', items: [] }))
  await expect(planUsageUseCase('owner').usage()).resolves.toEqual({ plan: 'PLUS' })
  expect(new Headers(jest.mocked(fetch).mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer owner')
})

test('an invalid response or a server error is an error instead of a guessed plan', async () => {
  globalThis.fetch = jest.fn().mockResolvedValue(json({ plan: 'GOLD' }))
  await expect(planUsageUseCase('owner').usage()).rejects.toThrow()
  globalThis.fetch = jest.fn().mockResolvedValue(json({ status: 500, code: 'INTERNAL_ERROR' }, 500))
  await expect(planUsageUseCase('owner').usage()).rejects.toMatchObject({ status: 500 })
})
