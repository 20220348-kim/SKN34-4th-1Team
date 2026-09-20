import type { z } from 'zod'
import { getCoreApiBaseUrl } from './coreApiConfig'

export class ChatConversationApiError extends Error {
  readonly status: number
  constructor(status: number) { super(`대화 기록 요청 실패 (${status})`); this.name = 'ChatConversationApiError'; this.status = status }
}

/** 대화 기록 API에는 항상 본인의 세션 쿠키를 사용하고 HTTP 캐시는 사용하지 않습니다. */
export async function chatConversationRequest<T>(accountEmail: string, path: string, schema: z.ZodType<T>, signal?: AbortSignal, body?: unknown, method: 'GET' | 'PUT' | 'DELETE' = body === undefined ? 'GET' : 'PUT'): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 20_000)
  try {
    const response = await fetch(`${getCoreApiBaseUrl()}/api/v1/me/chat-conversations${path}`, {
      method, credentials: 'include', cache: 'no-store', signal: controller.signal,
      // 다른 탭에서 계정이 바뀌었을 때 이전 화면의 대화를 새 계정에 저장하는 것을 서버에서 거부합니다.
      headers: { Accept: 'application/json', 'X-Chat-Account': encodeURIComponent(accountEmail), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new ChatConversationApiError(response.status)
    if (method === 'DELETE') {
      if (response.status !== 204) throw new Error('잘못된 대화 삭제 응답입니다.')
      return schema.parse(undefined)
    }
    return schema.parse(await response.json())
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
