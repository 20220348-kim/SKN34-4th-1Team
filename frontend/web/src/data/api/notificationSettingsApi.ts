import type { z } from 'zod'
import { notificationSettingsProblemSchema } from '@govbiz/shared/data/models/NotificationSettingsDto'
import { NotificationSettingsError } from '@govbiz/shared/domain/errors/NotificationSettingsError'
import { getCoreApiBaseUrl } from './coreApiConfig'

/** 본인 알림 설정 요청입니다. 세션 쿠키로 인증하고, 실패하면 서버 원문 대신 상태와 오류 코드만 전달합니다. */
export async function notificationSettingsRequest<T>(method: 'GET' | 'PUT', schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(abort, 15_000)
  try {
    const response = await fetch(`${getCoreApiBaseUrl()}/api/v1/me/notification-settings`, {
      method, credentials: 'include', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const problem = notificationSettingsProblemSchema.safeParse(await response.json().catch(() => null))
      throw new NotificationSettingsError(response.status, problem.success ? problem.data.code : 'REQUEST_FAILED')
    }
    const parsed = schema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) throw new NotificationSettingsError(502, 'INVALID_RESPONSE')
    return parsed.data
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
