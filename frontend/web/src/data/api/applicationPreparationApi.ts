import type { z } from 'zod'
import { readPlanQuotaProblem } from '@govbiz/shared/data/models/PlanUsageDto'
import { PlanQuotaExceededError, QuotaUnavailableError } from '@govbiz/shared/domain/errors/PlanQuotaError'
import { ApplicationPreparationError } from '../../domain/errors/ApplicationPreparationError'
import { applicationPreparationProblemSchema } from '../models/ApplicationPreparationDto'
import { getCoreApiBaseUrl } from './coreApiConfig'

export type ApplicationPreparationNotFoundScope = 'feature' | 'preparation'

export async function applicationPreparationRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  signal?: AbortSignal,
  notFoundScope: ApplicationPreparationNotFoundScope = 'feature',
  /** `keepalive`: 화면을 떠나는 순간의 마지막 답변 저장처럼 브라우저가 끊지 않고 보내야 하는 요청입니다. */
  options: { keepalive?: boolean } = {},
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  let timedOut = false
  // 문서 생성은 작업(job) 접수·조회라 짧다. 입력 위치 변경 승인만 원본 재수집을 포함해 길다.
  const timer = setTimeout(() => {
    timedOut = true
    abort()
  }, path.endsWith('/mapping-migration/confirm') ? 90_000 : path.endsWith('/messages') || path.endsWith('/drafts') ? 45_000 : 15_000)
  try {
    const response = await fetch(`${getCoreApiBaseUrl()}/api/v1/application-preparations${path}`, {
      method,
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      ...(options.keepalive ? { keepalive: true } : {}),
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      // 요금제 한도(429 PLAN_QUOTA_EXCEEDED)와 이용량 확인 실패(503 QUOTA_UNAVAILABLE)는 shared 오류로 먼저 바꿉니다.
      const quota = readPlanQuotaProblem(response.status, body)
      if (quota) throw quota
      const problem = applicationPreparationProblemSchema.safeParse(body)
      const serverCode = problem.success ? problem.data.code : null
      let code = serverCode ?? 'REQUEST_FAILED'
      if (path.includes('/forms/discovery-jobs') && serverCode === 'AI_SERVICE_INVALID_RESPONSE') {
        code = 'APPLICATION_FORM_AI_INVALID_RESPONSE'
      } else if (response.status === 404 && serverCode?.startsWith('APPLICATION_FORM_')) {
        code = serverCode
      } else if (response.status === 404 && notFoundScope === 'preparation' && (
        serverCode === 'APPLICATION_PREPARATION_NOT_FOUND' || serverCode === 'APPLICATION_PREPARATION_SECTION_NOT_FOUND'
      )) {
        code = serverCode
      } else if (response.status === 404) {
        code = 'APPLICATION_PREPARATION_API_UNAVAILABLE'
      }
      throw new ApplicationPreparationError(response.status, code,
        problem.success ? problem.data.mappingMigration ?? null : null)
    }
    const payload = response.status === 204 ? undefined : await response.json().catch(() => null)
    const parsed = schema.safeParse(payload)
    if (!parsed.success) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return parsed.data
  } catch (error) {
    if (error instanceof ApplicationPreparationError || error instanceof PlanQuotaExceededError || error instanceof QuotaUnavailableError) throw error
    if (signal?.aborted) throw error
    if (timedOut) throw new ApplicationPreparationError(504, 'REQUEST_TIMEOUT')
    throw new ApplicationPreparationError(0, 'REQUEST_FAILED')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

export function downloadApplicationDocument(id: number, fileId: number, signal?: AbortSignal): Promise<Blob> {
  return downloadApplicationBinary(`/api/v1/application-preparations/${id}/documents/${fileId}/download`, signal)
}

export function downloadApplicationDocumentArchive(id: number, revision: number, signal?: AbortSignal): Promise<Blob> {
  return downloadApplicationBinary(`/api/v1/application-preparations/${id}/documents/archive?revision=${revision}`, signal)
}

async function downloadApplicationBinary(path: string, signal?: AbortSignal): Promise<Blob> {
  const timeout = AbortSignal.timeout(60_000)
  try {
    const response = await fetch(`${getCoreApiBaseUrl()}${path}`, {
      credentials: 'include', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) {
      const problem = applicationPreparationProblemSchema.safeParse(await response.json().catch(() => null))
      throw new ApplicationPreparationError(response.status, problem.success ? problem.data.code : 'REQUEST_FAILED')
    }
    const type = response.headers.get('content-type')?.split(';')[0]
    if (!type || !['application/pdf', 'application/x-hwp', 'application/hwp+zip', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(type)) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    const blob = await response.blob()
    if (blob.size === 0 || blob.size > 32 * 1024 * 1024) throw new ApplicationPreparationError(502, 'INVALID_RESPONSE')
    return blob
  } catch (error) {
    if (signal?.aborted || error instanceof ApplicationPreparationError) throw error
    throw new ApplicationPreparationError(timeout.aborted ? 504 : 0, timeout.aborted ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED')
  }
}
