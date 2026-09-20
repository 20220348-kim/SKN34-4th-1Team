import type { CombinationReviewRepository } from '../../domain/repositories/CombinationReviewRepository'
import type { ReviewDraft, RunRequest } from '../../domain/entities/CombinationReview'
import { combinationReviewRequest as request } from '../api/combinationReviewApi'
import { reviewSchema, reviewPageSchema, runPageSchema, runSchema } from '../models/CombinationReviewDto'
import { CombinationReviewError } from '../../domain/errors/CombinationReviewError'

const cursor = (beforeId?: number) => `?size=20${beforeId === undefined ? '' : `&beforeId=${beforeId}`}`
export class CombinationReviewRepositoryImpl implements CombinationReviewRepository {
  list(beforeId?: number, signal?: AbortSignal) { return request(cursor(beforeId), reviewPageSchema, 'GET', undefined, signal) }
  async get(id: number, signal?: AbortSignal) {
    const review = await request(`/${id}`, reviewSchema, 'GET', undefined, signal)
    if (review.id !== id) throw new CombinationReviewError(502, 'INVALID_RESPONSE')
    return review
  }
  create(draft: ReviewDraft, signal?: AbortSignal) { return request('', reviewSchema, 'POST', draft, signal) }
  delete(id: number, signal?: AbortSignal) { return request<void>(`/${id}`, 'empty', 'DELETE', undefined, signal) }
  replace(id: number, expectedRevision: number, draft: ReviewDraft, signal?: AbortSignal) { return request<void>(`/${id}/inputs`, 'empty', 'PUT', { ...draft, expectedRevision }, signal) }
  runs(id: number, beforeId?: number, signal?: AbortSignal) { return request(`/${id}/runs${cursor(beforeId)}`, runPageSchema, 'GET', undefined, signal) }
  async run(id: number, runId: number, signal?: AbortSignal) {
    const run = await request(`/${id}/runs/${runId}`, runSchema, 'GET', undefined, signal)
    if (run.reviewId !== id || run.id !== runId) throw new CombinationReviewError(502, 'INVALID_RESPONSE')
    return run
  }
  async start(id: number, input: RunRequest, signal?: AbortSignal) {
    const run = await request(`/${id}/runs`, runSchema, 'POST', input, signal)
    if (run.reviewId !== id || run.requestKey !== input.requestKey || run.inputRevision !== input.expectedRevision || run.input.additionalFacts !== input.additionalFacts) throw new CombinationReviewError(502, 'INVALID_RESPONSE')
    return run
  }
  source(id: number, runId: number, documentIndex: number, signal?: AbortSignal) { return request<Blob>(`/${id}/runs/${runId}/sources/${documentIndex}`, null, 'GET', undefined, signal) }
}
