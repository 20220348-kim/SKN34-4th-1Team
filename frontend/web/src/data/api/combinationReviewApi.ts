import type { z } from 'zod'
import { CombinationReviewError } from '../../domain/errors/CombinationReviewError'
import { reviewProblemSchema } from '../models/CombinationReviewDto'
import { getCoreApiBaseUrl } from './coreApiConfig'

/** 분석은 접수만 요청한다. 15초 후 HTTP 대기를 끝내도 접수된 서버 작업이 취소되지는 않는다. */
export async function combinationReviewRequest<T>(path: string, schema: z.ZodType<T> | null | 'empty', method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(abort, 15_000)
  try {
    const response = await fetch(`${getCoreApiBaseUrl()}/api/v1/combination-reviews${path}`, {
      method, credentials: 'include', cache: 'no-store', signal: controller.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const problem = reviewProblemSchema.safeParse(await response.json().catch(() => null))
      const code = problem.success ? problem.data.code : response.status === 404 ? 'COMBINATION_REVIEW_API_UNAVAILABLE' : 'REQUEST_FAILED'
      throw new CombinationReviewError(response.status, code, problem.success ? problem.data.runId ?? null : null, response.headers.get('Retry-After'))
    }
    if (schema === 'empty') {
      if (response.status !== 204) throw new CombinationReviewError(502, 'INVALID_RESPONSE')
      return undefined as T
    }
    if (!schema) return await response.blob() as T
    const parsed = schema.safeParse(await response.json())
    if (!parsed.success) throw new CombinationReviewError(502, 'INVALID_RESPONSE')
    return parsed.data
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
