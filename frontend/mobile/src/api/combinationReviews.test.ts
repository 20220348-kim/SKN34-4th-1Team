import { MobileCombinationReviewRepository } from './combinationReviews'
import { mobileReview, reviewRequestKey, reviewRunFixture } from '../test/reviewFixtures'

const originalFetch = globalThis.fetch
const response = (value: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status,
  json: async () => value, headers: { get: () => null }, blob: async () => new Blob(['official source']) } as unknown as Response)
beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'; globalThis.fetch = jest.fn() })
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.EXPO_PUBLIC_API_BASE_URL; jest.useRealTimers() })

test('reads use native bearer auth and never submit an analysis request', async () => {
  jest.mocked(fetch).mockResolvedValueOnce(response(mobileReview)).mockResolvedValueOnce(response({ items: [reviewRunFixture()], nextBeforeId: null }))
  const repository = new MobileCombinationReviewRepository('private-token')
  await repository.get(5); await repository.runs(5)
  for (const [, init] of jest.mocked(fetch).mock.calls) {
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' })
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-token')
    expect(new Headers(init?.headers).get('Cookie')).toBeNull()
  }
})

test('202 admission preserves the submitted key, input revision and additional facts', async () => {
  const request = { expectedRevision: 1, requestKey: reviewRequestKey, additionalFacts: '동일 비용' }
  const run = reviewRunFixture()
  jest.mocked(fetch).mockResolvedValue(response({ ...run, input: { ...run.input, additionalFacts: request.additionalFacts } }, 202))
  await new MobileCombinationReviewRepository('owner').start(5, request)
  const [url, init] = jest.mocked(fetch).mock.calls[0]
  expect(url).toBe('https://api.example.test/api/v1/combination-reviews/5/runs')
  expect(JSON.parse(String(init?.body))).toEqual(request)
})

test('foreign run identities and malformed references are rejected', async () => {
  jest.mocked(fetch).mockResolvedValueOnce(response({ ...reviewRunFixture(), reviewId: 7 }))
  await expect(new MobileCombinationReviewRepository('owner').run(5, 6)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  const success = reviewRunFixture('SUCCEEDED')
  success.analysis!.pairs[0].stages[0].citations[0].evidenceId = 'missing'
  jest.mocked(fetch).mockResolvedValueOnce(response(success))
  await expect(new MobileCombinationReviewRepository('owner').run(5, 6)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})

test('repeated cursors, wrong empty responses and stable HTTP failures are not normal data', async () => {
  const repository = new MobileCombinationReviewRepository('owner')
  jest.mocked(fetch).mockResolvedValueOnce(response({ items: [{ ...mobileReview, id: 10 }], nextBeforeId: 10 }))
  await expect(repository.list(10)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  jest.mocked(fetch).mockResolvedValueOnce(response({}, 200))
  await expect(repository.replace(5, 1, mobileReview)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  jest.mocked(fetch).mockResolvedValueOnce(response({ code: 'RUN_QUEUE_UNAVAILABLE', runId: 6, detail: 'private server text' }, 503))
  await expect(repository.start(5, { expectedRevision: 1, requestKey: reviewRequestKey, additionalFacts: '' }))
    .rejects.toMatchObject({ status: 503, code: 'RUN_QUEUE_UNAVAILABLE', runId: 6, message: 'RUN_QUEUE_UNAVAILABLE' })
})

test('analysis admission stops HTTP waiting at 15 seconds without submitting another request', async () => {
  jest.useFakeTimers()
  jest.mocked(fetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error) })
  }))
  const result = new MobileCombinationReviewRepository('owner').start(5, { expectedRevision: 1, requestKey: reviewRequestKey, additionalFacts: '' })
  const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await jest.advanceTimersByTimeAsync(15_000)
  await rejection
  expect(fetch).toHaveBeenCalledTimes(1)
})
