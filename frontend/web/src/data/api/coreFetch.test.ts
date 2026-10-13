import { afterEach, expect, it, vi } from 'vitest'

import { coreFetch, onCoreSessionEnded } from './coreFetch'

afterEach(() => { vi.unstubAllGlobals() })

it('401이면 등록한 곳에 세션이 끝났다고 알리고 응답은 그대로 돌려준다', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
  const listener = vi.fn()
  const stop = onCoreSessionEnded(listener)

  const response = await coreFetch('/api/v1/me/saved-programs')

  expect(response.status).toBe(401)
  expect(listener).toHaveBeenCalledOnce()
  stop()
  await coreFetch('/api/v1/me/saved-programs')
  expect(listener).toHaveBeenCalledOnce()
})

it.each([200, 403, 404, 500])('%s는 세션이 끝났다는 신호가 아니다', async (status) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })))
  const listener = vi.fn()
  const stop = onCoreSessionEnded(listener)

  await coreFetch('/api/v1/me/saved-programs', { method: 'GET' })

  expect(listener).not.toHaveBeenCalled()
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/v1/me/saved-programs', { method: 'GET' })
  stop()
})
