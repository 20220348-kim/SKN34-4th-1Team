import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlanUsageItem } from '@govbiz/shared/domain/entities/PlanUsage'
import { PlanUsageRepositoryImpl } from './PlanUsageRepositoryImpl'

// 다른 기능 테스트에서는 setupPlanUsage가 이 경계를 막아 둡니다. 여기서는 실제 HTTP 계약을 확인합니다.
vi.unmock('../api/planUsageApi')

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const aiSearch: PlanUsageItem = { feature: 'AI_SEARCH', period: 'DAY', limit: 10, used: 3, resetsAt: '2026-10-09T00:00:00+09:00' }
// 진행 중인 요청 때문에 한도를 넘겨 세어진 사용량도 그대로 받습니다. 화면 문구가 한도에서 멈춥니다.
const questions: PlanUsageItem = { feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: 10, used: 11, resetsAt: '2026-10-09T00:00:00+09:00' }
const drafts: PlanUsageItem = { feature: 'APPLICATION_DRAFT', period: 'MONTH', limit: 3, used: 4, resetsAt: '2026-11-01T00:00:00+09:00' }

describe('요금제 이용량 API 경계', () => {
  it('세션 쿠키와 no-store로 GET하고, 앱이 모르는 기능은 빼고 읽는다', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      plan: 'FREE', items: [aiSearch, questions, drafts, { ...aiSearch, feature: 'FUTURE_FEATURE' }],
    }))
    vi.stubGlobal('fetch', fetcher)

    // 끝나는 때·배정 출처·체험 목록을 보내지 않으면 끝나는 때 없이, 시작할 체험 없이 읽습니다.
    expect(await new PlanUsageRepositoryImpl().usage())
      .toEqual({ plan: 'FREE', planEndsAt: null, planSource: null, trialsAvailable: [], items: [aiSearch, questions, drafts] })
    const [url, init] = fetcher.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/plan-usage')
    expect(init).toMatchObject({ method: 'GET', credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } })
  })

  it('로그인 전 응답은 요금제 없이 AI 대화 검색 체험만 읽는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ plan: null, items: [{ ...aiSearch, limit: 2, used: 1 }] })))
    expect(await new PlanUsageRepositoryImpl().usage())
      .toEqual({ plan: null, planEndsAt: null, planSource: null, trialsAvailable: [], items: [{ ...aiSearch, limit: 2, used: 1 }] })
  })

  it('30일 이용권은 이번 기간 사용량과 이용권이 끝나는 때를 읽는다', async () => {
    const endsAt = '2026-10-31T15:30:00+09:00'
    const pass = { plan: 'PLUS', planEndsAt: endsAt, items: [{ ...aiSearch, period: 'PLAN', limit: 500, used: 20, resetsAt: endsAt }] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(pass)))
    expect(await new PlanUsageRepositoryImpl().usage()).toEqual({ ...pass, planSource: null, trialsAvailable: [] })
  })

  it('HTTP 오류와 계약과 다른 응답을 정상 이용량으로 숨기지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 'QUOTA_UNAVAILABLE', detail: 'redis down' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ plan: 'GOLD', items: [] }))
      .mockResolvedValueOnce(new Response('not json')))
    const repository = new PlanUsageRepositoryImpl()
    await expect(repository.usage()).rejects.toMatchObject({ name: 'PlanUsageApiError', status: 503 })
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
