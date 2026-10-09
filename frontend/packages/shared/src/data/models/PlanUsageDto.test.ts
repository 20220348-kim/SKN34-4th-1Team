import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanQuotaExceededError, QuotaUnavailableError } from '../../domain/errors/PlanQuotaError'
import { PlanTrialError, planTrialErrorMessage } from '../../domain/errors/PlanTrialError'
import { planUsageSchema, readPlanQuotaProblem, readPlanTrialProblem } from './PlanUsageDto'

afterEach(() => { vi.useRealTimers() })

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

  it('reads a pass period and when the pass ends, and treats a missing end as none', () => {
    const parsed = planUsageSchema.parse({
      plan: 'PLUS',
      planEndsAt: '2026-10-31T15:30:00+09:00',
      items: [{ feature: 'AI_SEARCH', period: 'PLAN', limit: 500, used: 20, resetsAt: '2026-10-31T15:30:00+09:00' }],
    })
    expect(parsed.planEndsAt).toBe('2026-10-31T15:30:00+09:00')
    expect(parsed.items.map((item) => item.period)).toEqual(['PLAN'])
    // 끝나는 때를 보내지 않던 Core의 응답도 끝나는 때 없이 읽습니다.
    expect(planUsageSchema.parse({ plan: 'FREE', items: [] }).planEndsAt).toBeNull()
    expect(planUsageSchema.safeParse({ plan: 'PLUS', planEndsAt: 'next month', items: [] }).success).toBe(false)
  })

  it('turns only the plan quota problem contracts into errors', () => {
    // 안내 문구는 받은 때부터 하루 한도가 다시 채워질 때까지 남은 시간을 적습니다(서울 저녁 9시 → 3시간 뒤).
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-08T21:00:00+09:00'))
    const exceeded = readPlanQuotaProblem(429, {
      type: 'urn:govbiz:problem:plan-quota-exceeded', title: 'Plan Quota Exceeded', status: 429, detail: 'x', instance: '/api',
      code: 'PLAN_QUOTA_EXCEEDED', feature: 'EVIDENCE_QUESTION', period: 'DAY', plan: 'FREE', limit: 10, used: 10,
      resetsAt: '2026-10-09T00:00:00+09:00', retryAfterSeconds: 10800,
    })
    expect(exceeded).toBeInstanceOf(PlanQuotaExceededError)
    expect(exceeded?.message).toBe('오늘 공고 원문 질문 10회를 모두 썼어요. 약 3시간 뒤에 다시 채워져요.')
    expect(readPlanQuotaProblem(503, { status: 503, code: 'QUOTA_UNAVAILABLE' })).toBeInstanceOf(QuotaUnavailableError)
    // 분당 요청 제한은 다른 계약이라 여기서 바꾸지 않습니다.
    expect(readPlanQuotaProblem(429, { status: 429, code: 'SUPPORT_PROGRAM_RATE_LIMITED', retryAfterSeconds: 5 })).toBeNull()
    expect(readPlanQuotaProblem(503, { status: 503, code: 'SUPPORT_PROGRAM_BUSY' })).toBeNull()
    expect(readPlanQuotaProblem(500, null)).toBeNull()
  })

  it('reads who assigned the plan and the trials still available, ignoring values this client does not know', () => {
    const parsed = planUsageSchema.parse({
      plan: 'PLUS', planEndsAt: '2026-10-22T21:00:00+09:00', planSource: 'TRIAL', trialsAvailable: ['PREMIUM', 'GOLD', 'FREE'], items: [],
    })
    expect(parsed.planSource).toBe('TRIAL')
    expect(parsed.trialsAvailable).toEqual(['PREMIUM'])
    // 체험 기능이 없던 Core의 응답은 출처 없음·시작할 체험 없음으로 읽습니다.
    const older = planUsageSchema.parse({ plan: 'FREE', items: [] })
    expect(older.planSource).toBeNull()
    expect(older.trialsAvailable).toEqual([])
    expect(planUsageSchema.parse({ plan: 'PLUS', planSource: 'PARTNER', trialsAvailable: 'PLUS', items: [] }))
      .toMatchObject({ planSource: null, trialsAvailable: [] })
  })

  it('turns a refused trial into a stable code and a message without the server text', () => {
    const used = readPlanTrialProblem(409, { status: 409, code: 'PLAN_TRIAL_USED', detail: 'server text' })
    expect(used).toBeInstanceOf(PlanTrialError)
    expect([used.status, used.code]).toEqual([409, 'PLAN_TRIAL_USED'])
    expect(readPlanTrialProblem(403, { code: 'PLAN_TRIAL_EMAIL_UNVERIFIED' }).code).toBe('PLAN_TRIAL_EMAIL_UNVERIFIED')
    expect(readPlanTrialProblem(401, null).code).toBe('AUTHENTICATION_REQUIRED')
    expect(readPlanTrialProblem(500, { code: 'INTERNAL' }).code).toBe('REQUEST_FAILED')
    expect(planTrialErrorMessage(used)).toBe('이 요금제는 이미 체험했어요. 요금제마다 한 번만 체험할 수 있어요.')
    expect(planTrialErrorMessage(new Error('network'))).toBe('체험을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.')
  })
})
