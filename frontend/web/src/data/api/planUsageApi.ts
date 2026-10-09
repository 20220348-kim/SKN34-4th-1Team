import { planUsageSchema, readPlanTrialProblem } from '@govbiz/shared/data/models/PlanUsageDto'
import type { PlanUsage, TrialPlanCode } from '@govbiz/shared/domain/entities/PlanUsage'
import { PlanTrialError } from '@govbiz/shared/domain/errors/PlanTrialError'
import { getCoreApiBaseUrl } from './coreApiConfig'

/** 이용량 조회 실패입니다. 서버 원문 대신 HTTP 상태만 남깁니다. 계약과 다른 응답은 502로 둡니다. */
export class PlanUsageApiError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Core API returned HTTP ${status} for the plan usage request.`)
    this.name = 'PlanUsageApiError'
    this.status = status
  }
}

/** 세션 쿠키로 Core를 부르고 브라우저 캐시를 쓰지 않습니다. 15초 안에 답이 없거나 호출한 화면이 [signal]로 끊으면 멈춥니다. */
async function coreRequest(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(abort, 15_000)
  try {
    return await fetch(`${getCoreApiBaseUrl()}${path}`, { ...init, credentials: 'include', cache: 'no-store', signal: controller.signal })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * 현재 요금제와 기능별 이용량을 읽습니다. 로그인 전에도 부를 수 있고, 세션 쿠키가 있으면 회원 이용량을 받습니다.
 * 이용량은 실행할 때마다 바뀌므로 브라우저 캐시를 쓰지 않고, 15초 안에 답이 없으면 끊습니다.
 */
export async function planUsageRequest(signal?: AbortSignal): Promise<PlanUsage> {
  const response = await coreRequest('/api/v1/plan-usage', { method: 'GET', headers: { Accept: 'application/json' } }, signal)
  if (!response.ok) throw new PlanUsageApiError(response.status)
  const parsed = planUsageSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new PlanUsageApiError(502)
  return parsed.data
}

/** 출시 전 무료 체험을 시작하고 바뀐 요금제와 이용량을 받습니다. 실패하면 서버 원문 대신 상태와 오류 코드만 남깁니다. */
export async function planTrialRequest(plan: TrialPlanCode, signal?: AbortSignal): Promise<PlanUsage> {
  const response = await coreRequest('/api/v1/plan-trials', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }),
  }, signal)
  if (!response.ok) throw readPlanTrialProblem(response.status, await response.json().catch(() => null))
  const parsed = planUsageSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new PlanTrialError(502, 'INVALID_RESPONSE')
  return parsed.data
}
