import { afterEach, describe, expect, it, vi } from 'vitest'

import { CoreApiRequestError, fetchCoreApiHealth } from '../fetchCoreApiHealth'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchCoreApiHealth', () => {
  it('gets and validates Core API health with the supplied abort signal', async () => {
    const controller = new AbortController()
    const response = { service: 'govbiz-core-service', status: 'up' }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchCoreApiHealth(controller.signal)).resolves.toEqual(response)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v1\/health$/)
    expect(init.signal).toBe(controller.signal)
  })

  it('rejects a response that violates the health contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 1 })))

    await expect(fetchCoreApiHealth()).rejects.toThrow()
  })

  it('turns a non-success response into a safe API boundary error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))

    await expect(fetchCoreApiHealth()).rejects.toBeInstanceOf(CoreApiRequestError)
  })

  it('propagates request cancellation to the caller', async () => {
    const controller = new AbortController()
    const aborted = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(aborted), { once: true })
      },
    )))

    const request = fetchCoreApiHealth(controller.signal)
    controller.abort()

    await expect(request).rejects.toBe(aborted)
  })
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
