import { restoreSearchResults } from './searchResults'
import { programDetail } from '../test/preparationFixtures'

const resultToken = '00000000-0000-4000-8000-000000000001'
const program = { ...programDetail, matchedReasons: [], recommendationScore: null, eligibilityReview: null }
const context = { query: '제조 지원', acceptingOnly: true, companyConditions: { region: null, industry: null, establishedOn: null, supportPurpose: null } }
const response = { query: context.query, programs: [program], totalCount: 1, resultToken: null, expiresAt: null, context }
const oldFetch = globalThis.fetch
const oldBase = process.env.EXPO_PUBLIC_API_BASE_URL
afterEach(() => { globalThis.fetch = oldFetch; if (oldBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = oldBase })
test('the existing restore HTTP contract uses Bearer authentication, omits cookies and maps DTOs to domain results', async () => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com'
  globalThis.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }))
  const restored = await restoreSearchResults('verified', resultToken)
  const [url, options] = jest.mocked(fetch).mock.calls[0]
  expect(url).toBe('https://api.example.com/api/v1/support-programs/search/results')
  expect(options?.credentials).toBe('omit')
  expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer verified')
  expect(options?.body).toBe(JSON.stringify({ resultToken }))
  expect(restored.programs[0]).toEqual(expect.objectContaining({ id: program.id }))
  expect(restored.programs[0]).not.toHaveProperty('evidenceQuestionSupported')
  expect(fetch).toHaveBeenCalledTimes(1)
})
test.each([[401, 'unauthorized'], [410, 'expired'], [503, 'unavailable']])('HTTP %s remains an explicit %s restore failure', async (status, reason) => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com'
  globalThis.fetch = jest.fn().mockResolvedValue(new Response(null, { status: Number(status) }))
  await expect(restoreSearchResults('verified', resultToken)).rejects.toMatchObject({ reason })
  expect(fetch).toHaveBeenCalledTimes(1)
})
