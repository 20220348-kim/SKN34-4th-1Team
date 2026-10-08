import { describe, expect, it } from 'vitest'
import {
  findPlanUsageItem, hasPlanLimit, isNearPlanLimit, isPlanLimitReached, planLabels, planQuotaExceededMessage, planUsageCountText,
  planUsageResetText, remainingPlanUses, type LimitedPlanUsageItem, type PlanUsageItem,
} from './PlanUsage'

const daily: LimitedPlanUsageItem = { feature: 'AI_SEARCH', period: 'DAY', limit: 10, used: 8, resetsAt: '2026-10-09T00:00:00+09:00' }
const unlimited: PlanUsageItem = { feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: null, used: 42, resetsAt: daily.resetsAt }
const drafts: LimitedPlanUsageItem = { feature: 'APPLICATION_DRAFT', period: 'MONTH', limit: 3, used: 4, resetsAt: '2026-11-01T00:00:00+09:00' }

describe('PlanUsage', () => {
  it('names every plan in Korean', () => {
    expect(planLabels).toEqual({ FREE: '무료', PLUS: '플러스', PREMIUM: '프리미엄' })
  })

  it('warns from 80% of the limit and stops the visible count at the limit', () => {
    expect(isNearPlanLimit(daily)).toBe(true)
    expect(isNearPlanLimit({ ...daily, used: 7 })).toBe(false)
    expect(isPlanLimitReached(daily)).toBe(false)
    expect(remainingPlanUses(daily)).toBe(2)
    expect(planUsageCountText(daily)).toBe('오늘 8/10회')
    // 진행 중인 요청이 남아 한도를 넘겨 세어져도 화면은 한도에서 멈춥니다.
    expect(planUsageCountText({ ...daily, used: 11 })).toBe('오늘 10/10회')
    // 진행 중인 작업이 남아 월 한도를 넘겨 세어져도 화면은 한도에서 멈춥니다.
    expect(planUsageCountText(drafts)).toBe('이번 달 3/3건')
    expect(remainingPlanUses(drafts)).toBe(0)
  })

  it('never warns or blocks a plan without a limit and says so instead of a count against a limit', () => {
    expect(hasPlanLimit(unlimited)).toBe(false)
    expect(hasPlanLimit(daily)).toBe(true)
    expect(isNearPlanLimit(unlimited)).toBe(false)
    expect(isPlanLimitReached(unlimited)).toBe(false)
    expect(planUsageCountText(unlimited)).toBe('오늘 42회 · 제한 없음')
    expect(planUsageCountText({ ...drafts, limit: null, used: 7 })).toBe('이번 달 7건 · 제한 없음')
  })

  it('reads the reset date in Seoul time instead of the device time zone', () => {
    expect(planUsageResetText(daily)).toBe('자정(서울 시간)에 다시 채워져요.')
    expect(planUsageResetText(drafts)).toBe('11월 1일에 다시 채워져요.')
  })

  it('explains what the user can still do when a quota is used up', () => {
    expect(planQuotaExceededMessage({ ...daily, plan: null, limit: 2 }))
      .toBe('로그인 전 체험 2회를 모두 썼어요. 로그인하면 회원 한도로 이어서 검색할 수 있고, 필터 검색은 계속 쓸 수 있어요.')
    expect(planQuotaExceededMessage({ ...daily, plan: 'FREE' }))
      .toBe('오늘 AI 대화 검색 10회를 모두 썼어요. 자정(서울 시간)에 다시 채워져요. 필터 검색은 계속 쓸 수 있어요.')
    expect(planQuotaExceededMessage({ feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: 10, plan: 'FREE', resetsAt: daily.resetsAt }))
      .toBe('오늘 공고 원문 질문 10회를 모두 썼어요. 자정(서울 시간)에 다시 채워져요.')
    expect(planQuotaExceededMessage({ ...drafts, plan: 'FREE' }))
      .toBe('이번 달 신청 문서 초안 3건을 모두 썼어요. 이미 시작한 공고의 문서는 계속 만들 수 있어요. 11월 1일에 다시 채워져요.')
    expect(planQuotaExceededMessage({ feature: 'COMBINATION_REVIEW', period: 'MONTH', limit: 3, plan: 'FREE', resetsAt: drafts.resetsAt }))
      .toBe('이번 달 중복 검토 3회를 모두 썼어요. 진행 중인 검토도 횟수에 들어가요. 11월 1일에 다시 채워져요.')
  })

  it('finds a feature only when the usage was loaded', () => {
    expect(findPlanUsageItem(null, 'AI_SEARCH')).toBeNull()
    expect(findPlanUsageItem({ plan: 'FREE', items: [daily] }, 'AI_SEARCH')).toBe(daily)
    expect(findPlanUsageItem({ plan: 'FREE', items: [daily] }, 'EVIDENCE_QUESTION')).toBeNull()
  })
})
