import { describe, expect, it } from 'vitest'
import { planUsageSchema } from './PlanUsageDto'

describe('PlanUsageDto', () => {
  it('reads the current plan, null for guests, and skips fields this client does not know yet', () => {
    expect(planUsageSchema.parse({ plan: 'FREE' })).toEqual({ plan: 'FREE' })
    expect(planUsageSchema.parse({ plan: null }).plan).toBeNull()
    // 다음 단계에서 서버가 기능별 이용량(items)을 더해도 지금 앱은 요금제만 읽습니다.
    expect(planUsageSchema.parse({ plan: 'PREMIUM', items: [{ feature: 'AI_SEARCH' }] })).toEqual({ plan: 'PREMIUM' })
  })

  it('does not guess a plan from a response outside the contract', () => {
    expect(planUsageSchema.safeParse({ plan: 'GOLD' }).success).toBe(false)
    expect(planUsageSchema.safeParse({}).success).toBe(false)
    expect(planUsageSchema.safeParse(null).success).toBe(false)
  })
})
