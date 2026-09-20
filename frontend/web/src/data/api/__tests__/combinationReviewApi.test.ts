import { afterEach, describe, expect, it, vi } from 'vitest'
import { CombinationReviewRepositoryImpl } from '../../repositories/CombinationReviewRepositoryImpl'
import { runSchema } from '../../models/CombinationReviewDto'
import { reviewFixture, runFixture } from '../../../presentation/features/combination-review/testing/reviewFixtures'
import { CombinationReviewUseCase } from '../../../domain/usecases/CombinationReviewUseCase'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const repository = new CombinationReviewRepositoryImpl()
const request = { expectedRevision: runFixture.inputRevision, additionalFacts: runFixture.input.additionalFacts, requestKey: runFixture.requestKey }
describe('combination review HTTP boundary', () => {
  it('uses session cookies, cursor, full input revision and explicit run POST', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ items: [], nextBeforeId: null })).mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(Response.json(runFixture, { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    await repository.list(20)
    await repository.replace(12, 2, { title: reviewFixture.title, programs: reviewFixture.programs })
    await repository.start(12, request)
    expect(fetch.mock.calls[0][0]).toContain('?size=20&beforeId=20')
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'PUT', credentials: 'include', cache: 'no-store' })
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ expectedRevision: 2, programs: reviewFixture.programs })
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual(request)
  })
  it.each(['QUEUED', 'RUNNING', 'FAILED', 'INTERRUPTED', 'UNKNOWN'] as const)('does not turn HTTP 200 %s into success', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...runFixture, status, analysis: null })))
    expect((await repository.start(12, request)).status).toBe(status)
  })
  it('accepts HTTP 202 as a queued run, not a completed analysis', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...runFixture, status: 'QUEUED', analysis: null, evidence: null, configuration: null, finishedAt: null }, { status: 202 })))
    expect((await repository.start(12, request)).status).toBe('QUEUED')
  })
  it.each([401, 403, 404, 409, 422, 429, 503])('keeps HTTP %s and failure runId separate', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ code: 'SOURCE_UNSUPPORTED', runId: 30 }, { status, headers: { 'Retry-After': '60' } })))
    await expect(repository.start(12, request)).rejects.toMatchObject({ status, runId: 30, retryAfter: '60' })
  })
  it('rejects malformed results and references instead of showing a judgment', () => {
    expect(runSchema.safeParse(runFixture).success).toBe(true)
    const invalid = structuredClone(runFixture)
    invalid.analysis!.pairs[0].secondProgramIndex = 2
    expect(runSchema.safeParse(invalid).success).toBe(false)
    invalid.analysis!.pairs[0].secondProgramIndex = 1
    invalid.analysis!.pairs[0].stages[0].citations[0].quote = '원문에 없는 허용'
    expect(runSchema.safeParse(invalid).success).toBe(false)
    expect(runSchema.safeParse({ ...runFixture, status: 'FAILED' }).success).toBe(false)
  })
  it('rejects a valid-looking response belonging to a different review or request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ ...runFixture, reviewId: 99 })).mockResolvedValueOnce(Response.json(runFixture)))
    await expect(repository.run(12, 30)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(repository.start(12, { ...request, additionalFacts: '다른 설명' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('accepts the real PUT 204 contract without parsing JSON or issuing another GET', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    await expect(repository.replace(12, 2, reviewFixture)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('deletes the owned review with an explicit DELETE and accepts only 204', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    await expect(repository.delete(12)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toMatch(/\/api\/v1\/combination-reviews\/12$/)
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'DELETE', credentials: 'include', cache: 'no-store' })
  })
  it('distinguishes an absent endpoint from an owned review not found', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: 404, error: 'Not Found' }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ code: 'COMBINATION_REVIEW_NOT_FOUND' }, { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    await expect(repository.create(reviewFixture)).rejects.toMatchObject({ code: 'COMBINATION_REVIEW_API_UNAVAILABLE' })
    await expect(repository.get(12)).rejects.toMatchObject({ code: 'COMBINATION_REVIEW_NOT_FOUND' })
  })
  it('downloads the zero-based source with session cookies', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('source-bytes'))
    vi.stubGlobal('fetch', fetch)
    expect(await (await repository.source(12, 30, 0)).text()).toBe('source-bytes')
    expect(fetch.mock.calls[0][0]).toContain('/12/runs/30/sources/0')
    expect(fetch.mock.calls[0][1].credentials).toBe('include')
  })
  it('rejects duplicate selection and invalid title before HTTP', () => {
    const useCase = new CombinationReviewUseCase(repository)
    expect(() => useCase.create({ title: '검토', programs: [reviewFixture.programs[0], reviewFixture.programs[0]] })).toThrow('중복')
    expect(() => useCase.create({ title: ' ', programs: reviewFixture.programs })).toThrow('제목')
  })
})
