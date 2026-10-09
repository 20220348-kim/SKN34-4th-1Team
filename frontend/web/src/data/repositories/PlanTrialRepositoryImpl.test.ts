import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanTrialRepositoryImpl } from './PlanTrialRepositoryImpl'

// 다른 기능 테스트에서는 setupPlanUsage가 이용량 조회만 막아 둡니다. 여기서는 체험 시작의 실제 HTTP 계약을 확인합니다.
vi.unmock('../api/planUsageApi')

afterEach(() => { vi.unstubAllGlobals() })

const endsAt = '2026-10-22T21:00:00+09:00'

describe('출시 전 무료 체험 API 경계', () => {
  it('세션 쿠키로 요금제만 POST하고 바뀐 요금제와 이용량을 읽는다', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      plan: 'PLUS', planEndsAt: endsAt, planSource: 'TRIAL', trialsAvailable: ['PREMIUM'],
      items: [{ feature: 'AI_SEARCH', period: 'PLAN', limit: 500, used: 0, resetsAt: endsAt }],
    }, { status: 201 }))
    vi.stubGlobal('fetch', fetcher)

    const usage = await new PlanTrialRepositoryImpl().start('PLUS')
    expect(usage).toMatchObject({ plan: 'PLUS', planEndsAt: endsAt, planSource: 'TRIAL', trialsAvailable: ['PREMIUM'] })
    const [url, init] = fetcher.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/plan-trials')
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', cache: 'no-store', body: '{"plan":"PLUS"}',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' } })
  })

  it('거절과 계약과 다른 응답을 서버 원문 없이 상태와 코드로만 알린다', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 'PLAN_TRIAL_USED', detail: 'server text' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ code: 'PLAN_TRIAL_EMAIL_UNVERIFIED' }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ plan: 'GOLD', items: [] }, { status: 201 })))
    const repository = new PlanTrialRepositoryImpl()
    await expect(repository.start('PLUS')).rejects.toMatchObject({ name: 'PlanTrialError', status: 409, code: 'PLAN_TRIAL_USED', message: 'PLAN_TRIAL_USED' })
    await expect(repository.start('PREMIUM')).rejects.toMatchObject({ status: 403, code: 'PLAN_TRIAL_EMAIL_UNVERIFIED' })
    await expect(repository.start('PLUS')).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' })
  })
})
