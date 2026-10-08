import { describe, expect, it } from 'vitest'
import { PlanQuotaExceededError, QuotaUnavailableError } from '../../domain/errors/PlanQuotaError'
import { planUsageSchema, readPlanQuotaProblem } from './PlanUsageDto'

describe('PlanUsageDto', () => {
  it('keeps known features and skips a feature this client does not know yet', () => {
    const parsed = planUsageSchema.parse({
      plan: 'FREE',
      items: [
        { feature: 'AI_SEARCH', period: 'DAY', limit: 10, used: 3, resetsAt: '2026-10-09T00:00:00+09:00' },
        { feature: 'APPLICATION_DRAFT', period: 'MONTH', limit: 3, used: 1, resetsAt: '2026-11-01T00:00:00+09:00' },
        { feature: 'FUTURE_FEATURE', period: 'DAY', limit: 5, used: 0, resetsAt: '2026-10-09T00:00:00+09:00' },
      ],
    })
    expect(parsed.items.map((item) => item.feature)).toEqual(['AI_SEARCH', 'APPLICATION_DRAFT'])
    expect(planUsageSchema.parse({ plan: null, items: [] }).plan).toBeNull()
    expect(planUsageSchema.safeParse({ plan: 'GOLD', items: [] }).success).toBe(false)
  })

  it('reads a null limit as a plan without a limit yet', () => {
    const parsed = planUsageSchema.parse({
      plan: 'PREMIUM',
      items: [{ feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: null, used: 42, resetsAt: '2026-10-09T00:00:00+09:00' }],
    })
    expect(parsed.items).toEqual([{ feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: null, used: 42, resetsAt: '2026-10-09T00:00:00+09:00' }])
  })

  it('turns only the plan quota problem contracts into errors', () => {
    const exceeded = readPlanQuotaProblem(429, {
      type: 'urn:govbiz:problem:plan-quota-exceeded', title: 'Plan Quota Exceeded', status: 429, detail: 'x', instance: '/api',
      code: 'PLAN_QUOTA_EXCEEDED', feature: 'EVIDENCE_QUESTION', period: 'DAY', plan: 'FREE', limit: 10, used: 10,
      resetsAt: '2026-10-09T00:00:00+09:00', retryAfterSeconds: 10800,
    })
    expect(exceeded).toBeInstanceOf(PlanQuotaExceededError)
    expect(exceeded?.message).toBe('오늘 공고 원문 질문 10회를 모두 썼어요. 자정(서울 시간)에 다시 채워져요.')
    expect(readPlanQuotaProblem(503, { status: 503, code: 'QUOTA_UNAVAILABLE' })).toBeInstanceOf(QuotaUnavailableError)
    // 분당 요청 제한은 다른 계약이라 여기서 바꾸지 않습니다.
    expect(readPlanQuotaProblem(429, { status: 429, code: 'SUPPORT_PROGRAM_RATE_LIMITED', retryAfterSeconds: 5 })).toBeNull()
    expect(readPlanQuotaProblem(503, { status: 503, code: 'SUPPORT_PROGRAM_BUSY' })).toBeNull()
    expect(readPlanQuotaProblem(500, null)).toBeNull()
  })
})
