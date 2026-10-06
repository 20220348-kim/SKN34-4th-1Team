import type { z } from 'zod'
import { reviewPageSchema, reviewProblemSchema, reviewSchema, runPageSchema, runSchema } from '@govbiz/shared/data/models/CombinationReviewDto'
import type { SupportProgram } from '@govbiz/shared/domain/entities/SupportProgram'
import { CombinationReviewError } from '@govbiz/shared/domain/errors/CombinationReviewError'
import type { ReviewDraft, RunRequest } from '@govbiz/shared/domain/entities/CombinationReview'
import type { CombinationReviewRepository } from '@govbiz/shared/domain/repositories/CombinationReviewRepository'
import { ApiError, createApiFetch, getApiBaseUrl } from './client'
import { listSavedPrograms } from './savedPrograms'

export async function listReviewSavedPrograms(token: string, signal?: AbortSignal): Promise<SupportProgram[]> {
  return (await listSavedPrograms(token, signal)).map(item => item.program)
}

/** Native transport for the existing review contract; reads never submit analysis. */
export class MobileCombinationReviewRepository implements CombinationReviewRepository {
  constructor(private readonly token: string) {}

  private async request<T>(path: string, schema: z.ZodType<T> | 'empty' | null, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(abort, 15_000)
    try {
      const response = await createApiFetch(this.token)(`${getApiBaseUrl()}/api/v1/combination-reviews${path}`, {
        method, cache: 'no-store', signal: controller.signal,
        headers: { Accept: schema === null ? 'application/octet-stream' : 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        const problem = reviewProblemSchema.safeParse(await response.json().catch(() => null))
        throw new CombinationReviewError(response.status, problem.success ? problem.data.code : 'REQUEST_FAILED',
          problem.success ? problem.data.runId ?? null : null, response.headers.get('Retry-After'))
      }
      if (schema === 'empty') {
        if (response.status !== 204) throw new CombinationReviewError(502, 'INVALID_RESPONSE')
        return undefined as T
      }
      if (schema === null) return await response.blob() as T
      let payload: unknown
      try { payload = await response.json() } catch { throw new CombinationReviewError(502, 'INVALID_RESPONSE') }
      const parsed = schema.safeParse(payload)
      if (!parsed.success) throw new CombinationReviewError(502, 'INVALID_RESPONSE')
      return parsed.data
    } catch (error) {
      if (error instanceof ApiError) throw new CombinationReviewError(error.status, error.code ?? 'REQUEST_FAILED')
      throw error
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }

  async list(beforeId?: number, signal?: AbortSignal) {
    const page = await this.request(`?size=20${beforeId === undefined ? '' : `&beforeId=${beforeId}`}`, reviewPageSchema, 'GET', undefined, signal)
    if (new Set(page.items.map(item => item.id)).size !== page.items.length
      || page.items.some((item, index) => index > 0 && page.items[index - 1].id <= item.id)
      || page.items.some(item => beforeId !== undefined && item.id >= beforeId)
      || (page.nextBeforeId !== null && (page.nextBeforeId !== page.items.at(-1)?.id || (beforeId !== undefined && page.nextBeforeId >= beforeId)))) {
      throw new CombinationReviewError(502, 'INVALID_RESPONSE')
    }
    return page
  }
  async get(id: number, signal?: AbortSignal) {
    const review = await this.request(`/${id}`, reviewSchema, 'GET', undefined, signal)
    if (review.id !== id) throw new CombinationReviewError(502, 'INVALID_RESPONSE')
    return review
  }
  create(draft: ReviewDraft, signal?: AbortSignal) { return this.request('', reviewSchema, 'POST', draft, signal) }
  delete(id: number, signal?: AbortSignal) { return this.request<void>(`/${id}`, 'empty', 'DELETE', undefined, signal) }
  replace(id: number, expectedRevision: number, draft: ReviewDraft, signal?: AbortSignal) {
    return this.request<void>(`/${id}/inputs`, 'empty', 'PUT', { ...draft, expectedRevision }, signal)
  }
  async runs(id: number, beforeId?: number, signal?: AbortSignal) {
    const page = await this.request(`/${id}/runs?size=20${beforeId === undefined ? '' : `&beforeId=${beforeId}`}`, runPageSchema, 'GET', undefined, signal)
    if (new Set(page.items.map(item => item.id)).size !== page.items.length
      || page.items.some((item, index) => index > 0 && page.items[index - 1].id <= item.id)
      || page.items.some(item => beforeId !== undefined && item.id >= beforeId)
      || (page.nextBeforeId !== null && (page.nextBeforeId !== page.items.at(-1)?.id || (beforeId !== undefined && page.nextBeforeId >= beforeId)))) {
      throw new CombinationReviewError(502, 'INVALID_RESPONSE')
    }
    return page
  }
  async run(id: number, runId: number, signal?: AbortSignal) {
    const run = await this.request(`/${id}/runs/${runId}`, runSchema, 'GET', undefined, signal)
    if (run.reviewId !== id || run.id !== runId) throw new CombinationReviewError(502, 'INVALID_RESPONSE')
    return run
  }
  async start(id: number, input: RunRequest, signal?: AbortSignal) {
    const run = await this.request(`/${id}/runs`, runSchema, 'POST', input, signal)
    if (run.reviewId !== id || run.requestKey !== input.requestKey || run.inputRevision !== input.expectedRevision
      || run.input.additionalFacts !== input.additionalFacts) throw new CombinationReviewError(502, 'INVALID_RESPONSE')
    return run
  }
  source(id: number, runId: number, documentIndex: number, signal?: AbortSignal) {
    return this.request<Blob>(`/${id}/runs/${runId}/sources/${documentIndex}`, null, 'GET', undefined, signal)
  }
}

export function reviewErrorMessage(error: unknown): string {
  if (error instanceof CombinationReviewError) {
    if (error.status === 401) return '로그인이 만료됐어요. 다시 로그인해 주세요.'
    if (error.status === 403) return '이 검토에 접근할 수 없어요. 계정 상태를 확인해 주세요.'
    if (error.status === 404) return '검토 또는 실행을 찾을 수 없어요.'
    if (error.code === 'COMBINATION_REVIEW_DELETE_CONFLICT') return '대기·분석 중이거나 결과 확인이 필요한 실행이 있어 검토를 삭제할 수 없어요. 검토와 실행 기록은 유지됩니다. 실행 상태를 확인해 주세요.'
    if (error.status === 409) return '저장된 입력이나 분석 요청이 변경됐어요. 작성한 내용은 유지됩니다. 최신 검토와 실행 이력을 확인해 주세요.'
    if (error.status === 429) return '요청량 또는 진행 중인 분석 한도에 도달했어요. 잠시 후 다시 확인해 주세요.'
    if (error.code === 'RUN_QUEUE_UNAVAILABLE') return '지금은 분석 요청을 접수할 수 없어요. 잠시 후 다시 시도해 주세요.'
    if (error.status === 422) return '선택한 공고나 공식 자료를 자동 분석할 수 없어요. 공식 원문을 확인해 주세요.'
    return '서버 응답을 확인하지 못했어요. 저장된 검토와 실행 이력을 다시 확인해 주세요.'
  }
  if (error instanceof Error && ['제목은', '비교할', '같은 공고', '실행 입력', '선택한 공고', '저장된 입력', '보관한 분석 요청', '분석 요청', '완료 여부'].some(prefix => error.message.startsWith(prefix))) return error.message
  return '요청 결과를 확인하지 못했어요. 분석 접수 응답이 유실됐다면 같은 요청으로 확인해 주세요.'
}
