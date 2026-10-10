import { planUsageSchema } from '@govbiz/shared/data/models/PlanUsageDto'
import type { PlanUsage } from '@govbiz/shared/domain/entities/PlanUsage'
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

/**
 * 현재 요금제와 기능별 이용량을 읽습니다. 로그인 전에도 부를 수 있고, 세션 쿠키가 있으면 회원 이용량을 받습니다.
 * 이용량은 실행할 때마다 바뀌므로 브라우저 캐시를 쓰지 않고, 15초 안에 답이 없으면 끊습니다.
 */
export async function planUsageRequest(signal?: AbortSignal): Promise<PlanUsage> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(abort, 15_000)
  try {
    const response = await fetch(`${getCoreApiBaseUrl()}/api/v1/plan-usage`, {
      method: 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new PlanUsageApiError(response.status)
    const parsed = planUsageSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) throw new PlanUsageApiError(502)
    return parsed.data
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
