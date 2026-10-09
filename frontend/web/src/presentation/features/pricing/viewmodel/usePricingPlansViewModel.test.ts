import { describe, expect, it } from 'vitest'
import type { PlanUsage } from '@govbiz/shared/domain/entities/PlanUsage'
import { pricingPlanAction } from './usePricingPlansViewModel'

const ready = (usage: Partial<PlanUsage>) => ({ status: 'ready' as const, usage: { plan: 'FREE' as const, items: [], ...usage } })

describe('pricingPlanAction', () => {
  it('sends guests to search on the free card and to login on the paid cards', () => {
    expect(['FREE', 'PLUS', 'PREMIUM'].map((code) => pricingPlanAction(code as 'FREE', null))).toEqual(['search', 'login', 'login'])
    expect(pricingPlanAction('PLUS', { status: 'loading' })).toBe('loading')
    expect(pricingPlanAction('FREE', { status: 'failed' })).toBe('search')
  })

  it('marks the current plan, the trials still open, lower plans and used trials', () => {
    const freeMember = ready({ trialsAvailable: ['PREMIUM'] })
    expect(pricingPlanAction('FREE', freeMember)).toBe('current')
    expect(pricingPlanAction('PLUS', freeMember)).toBe('trialUsed')
    expect(pricingPlanAction('PREMIUM', freeMember)).toBe('trial')
    const premiumTrial = ready({ plan: 'PREMIUM', planSource: 'TRIAL', trialsAvailable: [] })
    expect(pricingPlanAction('FREE', premiumTrial)).toBe('included')
    expect(pricingPlanAction('PLUS', premiumTrial)).toBe('included')
    expect(pricingPlanAction('PREMIUM', premiumTrial)).toBe('current')
    // 운영자가 배정한 플러스를 쓰는 동안 프리미엄은 체험할 수 없습니다.
    expect(pricingPlanAction('PREMIUM', ready({ plan: 'PLUS', planSource: 'OPERATOR', trialsAvailable: [] }))).toBe('unavailable')
    // 체험 목록을 보내지 않던 Core 응답이면 체험 버튼을 두지 않습니다.
    expect(pricingPlanAction('PLUS', ready({}))).toBe('trialUsed')
  })
})
