import { describe, expect, it } from 'vitest'
import { planLabels } from './PlanUsage'

describe('PlanUsage', () => {
  it('names every plan in Korean', () => {
    expect(planLabels).toEqual({ FREE: '무료', PLUS: '플러스', PREMIUM: '프리미엄' })
  })
})
