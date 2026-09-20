import type { z } from 'zod'
import { DailyReportError } from '../../domain/errors/DailyReportError'
import { dailyReportProblemSchema } from '../models/DailyReportDto'
import { getCoreApiBaseUrl } from './coreApiConfig'

/** 미리보기 대기를 끝내도 이미 시작한 서버 생성은 계속될 수 있으므로 최신 조회로 확인합니다. */
export async function dailyReportRequest<T>(path: string, method: 'GET' | 'PUT' | 'POST', schema: z.ZodType<T> | 'empty', body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(abort, path.endsWith('/preview') ? 180_000 : 15_000)
  try {
    const response = await fetch(`${getCoreApiBaseUrl()}${path}`, {
      method, credentials: 'include', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const problem = dailyReportProblemSchema.safeParse(await response.json().catch(() => null))
      throw new DailyReportError(response.status, problem.success ? problem.data.code : 'REQUEST_FAILED')
    }
    if (schema === 'empty') {
      if (response.status !== 204) throw new DailyReportError(502, 'INVALID_RESPONSE')
      return undefined as T
    }
    const parsed = schema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) throw new DailyReportError(502, 'INVALID_RESPONSE')
    return parsed.data
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
