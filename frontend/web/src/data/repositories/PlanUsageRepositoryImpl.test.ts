import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanUsageRepositoryImpl } from './PlanUsageRepositoryImpl'

// 다른 기능 테스트에서는 setupPlanUsage가 이 경계를 막아 둡니다. 여기서는 실제 HTTP 계약을 확인합니다.
vi.unmock('../api/planUsageApi')

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('요금제 API 경계', () => {
  it('세션 쿠키와 no-store로 GET하고, 앱이 모르는 필드는 빼고 요금제만 읽는다', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ plan: 'FREE', items: [] }))
    vi.stubGlobal('fetch', fetcher)

    expect(await new PlanUsageRepositoryImpl().usage()).toEqual({ plan: 'FREE' })
    const [url, init] = fetcher.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/plan-usage')
    expect(init).toMatchObject({ method: 'GET', credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } })
  })

  it('로그인 전 응답은 요금제 없이 읽는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ plan: null })))
    expect(await new PlanUsageRepositoryImpl().usage()).toEqual({ plan: null })
  })

  it('HTTP 오류와 계약과 다른 응답을 정상 요금제로 숨기지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 'INTERNAL_ERROR', detail: 'db down' }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ plan: 'GOLD' }))
      .mockResolvedValueOnce(new Response('not json')))
    const repository = new PlanUsageRepositoryImpl()
    await expect(repository.usage()).rejects.toMatchObject({ name: 'PlanUsageApiError', status: 500 })
    await expect(repository.usage()).rejects.toMatchObject({ status: 502 })
    await expect(repository.usage()).rejects.toMatchObject({ status: 502 })
  })

  it('15초 안에 답이 없으면 끊고, 화면이 떠나 취소하면 요청도 취소한다', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetcher)
    const repository = new PlanUsageRepositoryImpl()

    const timedOut = expect(repository.usage()).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await timedOut

    const controller = new AbortController()
    const cancelled = expect(repository.usage(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await cancelled
    expect(fetcher.mock.calls[1]![1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
