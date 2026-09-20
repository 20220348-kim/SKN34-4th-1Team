import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SampleItem } from '../../../domain/entities/SampleItem'
import { SampleItemApiError, prepareSampleItemApi } from '../sampleItemApi'

const item: SampleItem = {
  name: 'Example item',
  category: 'BASIC',
  note: 'Demonstrates a typed API boundary.',
}

const preparationResponse = {
  phase: 'READY_FOR_PROCESSING',
  item,
  processing: {
    status: 'NOT_STARTED',
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('prepareSampleItemApi', () => {
  it('posts the sample item and validates the preparation response', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(preparationResponse))
    vi.stubGlobal('fetch', fetchMock)

    await expect(prepareSampleItemApi(item, controller.signal)).resolves.toEqual(
      preparationResponse,
    )

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v1\/sample-items\/prepare$/)
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    })
    expect(JSON.parse(String(init.body))).toEqual({ item })
  })

  it('rejects a response that violates the typed API contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      ...preparationResponse,
      phase: 'DONE',
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(prepareSampleItemApi(item)).rejects.toThrow()
  })

  it('turns a non-success HTTP response into an API boundary error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 400 })))

    await expect(prepareSampleItemApi(item)).rejects.toBeInstanceOf(SampleItemApiError)
  })
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
