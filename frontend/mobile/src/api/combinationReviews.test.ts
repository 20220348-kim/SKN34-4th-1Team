import { MobileCombinationReviewRepository, reviewErrorMessage } from './combinationReviews'
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

test('step input saves use separate authenticated create and versioned replace contracts without an analysis key or facts', async () => {
  const draft = { title: '단계 저장 검토', programs: mobileReview.programs }
  const changed = { ...draft, title: '수정한 검토' }
  const saved = { ...mobileReview, ...draft }
  const updated = { ...saved, ...changed, inputRevision: 2 }
  jest.mocked(fetch).mockResolvedValueOnce(response(saved, 201)).mockResolvedValueOnce(response(undefined, 204)).mockResolvedValueOnce(response(updated))
  const repository = new MobileCombinationReviewRepository('owner-token')
  await repository.create(draft)
  await repository.replace(5, 1, changed)
  await expect(repository.get(5)).resolves.toMatchObject(updated)
  const calls = jest.mocked(fetch).mock.calls
  expect(calls[0][0]).toBe('https://api.example.test/api/v1/combination-reviews')
  expect(calls[0][1]?.method).toBe('POST')
  expect(JSON.parse(String(calls[0][1]?.body))).toEqual(draft)
  expect(calls[1][0]).toBe('https://api.example.test/api/v1/combination-reviews/5/inputs')
  expect(calls[1][1]?.method).toBe('PUT')
  expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ ...changed, expectedRevision: 1 })
  for (const [url, init] of calls) {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer owner-token')
    expect(String(url)).not.toContain('/runs')
    if (init?.body) {
      expect(JSON.parse(String(init.body))).not.toHaveProperty('requestKey')
      expect(JSON.parse(String(init.body))).not.toHaveProperty('additionalFacts')
    }
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

test('a deletion conflict retains its server code and explains that the review is protected', async () => {
  jest.mocked(fetch).mockResolvedValueOnce(response({ code: 'COMBINATION_REVIEW_DELETE_CONFLICT' }, 409))
  let failure: unknown
  try { await new MobileCombinationReviewRepository('owner').delete(5) } catch (error) { failure = error }
  expect(failure).toMatchObject({ status: 409, code: 'COMBINATION_REVIEW_DELETE_CONFLICT' })
  expect(reviewErrorMessage(failure)).toContain('검토를 삭제할 수 없어요')
  expect(reviewErrorMessage(failure)).toContain('검토와 실행 기록은 유지됩니다')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(jest.mocked(fetch).mock.calls[0][1]?.method).toBe('DELETE')
})
