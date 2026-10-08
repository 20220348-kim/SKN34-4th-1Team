import { toSupportProgramDetail } from '@govbiz/shared/data/models/SupportProgramDto'
import { readPlanQuotaProblem } from '@govbiz/shared/data/models/PlanUsageDto'
import { PlanQuotaExceededError, QuotaUnavailableError } from '@govbiz/shared/domain/errors/PlanQuotaError'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { createSupportProgramClient } from '@govbiz/shared/data/api/supportProgramClient'
import { SupportProgramInterpretationApiError, SupportProgramRequestApiError, SupportProgramSearchTimeoutApiError, SupportProgramEvidenceApiError } from '@govbiz/shared/data/api/supportProgramApi'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function getApiBaseUrl(): string {
  const value = process.env.EXPO_PUBLIC_API_BASE_URL?.trim() || (__DEV__ ? 'http://localhost:8080' : '')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('앱의 API 주소가 설정되지 않았습니다.') }
  const localHost = /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(__DEV__ && url.protocol === 'http:' && localHost))) {
    throw new Error('API 주소는 HTTPS origin이어야 합니다. 개발 중에는 로컬 HTTP 주소를 사용할 수 있습니다.')
  }
  return url.origin
}

/** 인증 헤더는 설정한 API에만 보내며 브라우저 쿠키를 섞지 않습니다. */
export function createApiFetch(accessToken?: string): typeof fetch {
  return async (input, init) => {
    const baseUrl = getApiBaseUrl()
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== baseUrl || !url.pathname.startsWith('/api/')) {
      throw new Error('허용되지 않은 API 주소입니다.')
    }
    const controller = new AbortController()
    const externalSignal = init?.signal
    const abort = () => controller.abort()
    if (externalSignal?.aborted) controller.abort()
    else externalSignal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, 120_000)
    const headers = new Headers(init?.headers)
    headers.delete('Cookie')
    headers.delete('Authorization')
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
    try {
      const response = await fetch(url.href, {
        ...init, headers, credentials: 'omit', redirect: 'error', signal: controller.signal,
      })
      if (accessToken && response.status === 401) {
        throw new ApiError(401, '로그인이 만료되었습니다. 다시 로그인해 주세요.')
      }
      return response
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', abort)
    }
  }
}

export type ApiRequestOptions = {
  method?: string
  body?: unknown
  accessToken?: string
  signal?: AbortSignal
}

export async function apiRequest(path: string, options: ApiRequestOptions = {}): Promise<unknown> {
  if (!path.startsWith('/api/')) throw new Error('허용되지 않은 API 경로입니다.')
  const response = await createApiFetch(options.accessToken)(`${getApiBaseUrl()}${path}`, {
    method: options.method ?? 'GET',
    headers: { Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: options.signal,
    cache: 'no-store',
  })
  if (!response.ok) {
    const problem: unknown = await response.json().catch(() => null)
    const data = problem && typeof problem === 'object' ? problem as Record<string, unknown> : {}
    const retryAfterSeconds = Number.isInteger(data.retryAfterSeconds) && Number(data.retryAfterSeconds) > 0 ? Number(data.retryAfterSeconds) : null
    // 요금제 한도 문제 응답은 shared 안내 문구를 씁니다. 분당 요청 제한 같은 다른 429는 아래 일반 문구를 유지합니다.
    const quota = readPlanQuotaProblem(response.status, problem)
    if (quota) {
      throw new ApiError(response.status, quota.message,
        quota instanceof PlanQuotaExceededError ? 'PLAN_QUOTA_EXCEEDED' : 'QUOTA_UNAVAILABLE', retryAfterSeconds)
    }
    const message = response.status === 401 ? '로그인이 만료되었습니다. 다시 로그인해 주세요.'
      : response.status === 429 ? '요청이 많습니다. 잠시 후 다시 시도해 주세요.'
        : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
    throw new ApiError(response.status, message, typeof data.code === 'string' ? data.code : null, retryAfterSeconds)
  }
  return response.status === 204 ? undefined : response.json()
}

export function programClient(accessToken?: string) {
  return createSupportProgramClient({ baseUrl: getApiBaseUrl, credentials: 'omit', fetch: createApiFetch(accessToken) })
}

/** 공개 응답에서 내부 상세 모델로의 변환은 모바일 API 경계에서 수행합니다. */
export async function readProgramDetail(client: ReturnType<typeof programClient>, identity: SupportProgramIdentity, signal?: AbortSignal) {
  const dto = await client.getDetail(identity, signal)
  return dto ? toSupportProgramDetail(dto) : null
}

export function errorMessage(error: unknown): string {
  // 요금제 한도 오류는 shared 공고 클라이언트(검색·원문 질문)가 안내 문구를 담아 던집니다.
  if (error instanceof PlanQuotaExceededError || error instanceof QuotaUnavailableError) return error.message
  if (error instanceof SupportProgramRequestApiError) return error.code === 'SUPPORT_PROGRAM_RATE_LIMITED'
    ? '요청이 많아요. 안내된 대기 시간 뒤 다시 시도해 주세요.' : '현재 처리 중인 요청이 많아요. 잠시 후 다시 시도해 주세요.'
  if (error instanceof SupportProgramInterpretationApiError) return error.reason === 'timeout'
    ? '검색 조건을 정리하는 시간이 초과됐어요. 입력한 내용은 유지돼요.' : '검색 조건 해석 서비스를 이용할 수 없어요. 입력한 내용은 유지돼요.'
  if (error instanceof SupportProgramSearchTimeoutApiError) return '검색 결과를 확인하지 못했어요. 다시 검색하면 새 요청이므로 먼저 입력한 조건을 확인해 주세요.'
  if (error instanceof SupportProgramEvidenceApiError) return error.status === 504
    ? '원문 답변을 확인하는 시간이 초과됐어요. 입력한 질문은 유지돼요.' : '원문 답변을 불러오지 못했어요. 입력한 질문을 확인하고 다시 시도해 주세요.'
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.name === 'AbortError') return '요청이 취소되었거나 시간이 초과되었습니다. 다시 시도해 주세요.'
  return '연결하지 못했거나 응답을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.'
}

/** 검증된 요청 제한 응답의 대기 시간만 화면에 전달합니다. */
export function requestRetryAfterSeconds(error: unknown): number | null {
  const value = error instanceof SupportProgramRequestApiError || error instanceof ApiError ? error.retryAfterSeconds : null
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

export function requestResultUnconfirmed(error: unknown): boolean {
  return error instanceof SupportProgramSearchTimeoutApiError
    || error instanceof SupportProgramInterpretationApiError && error.reason === 'timeout'
    || error instanceof Error && ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)
}
