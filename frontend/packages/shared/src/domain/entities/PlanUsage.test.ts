import { describe, expect, it } from 'vitest'
import {
  findPlanUsageItem, hasPlanLimit, isNearPlanLimit, isPlanLimitReached, planEndsText, planLabels, planQuotaExceededMessage,
  planUsageCountText, planUsageCountingRules, planUsageDeletionNote, planUsageResetText, planUsageUsedText, remainingPlanUses,
  type LimitedPlanUsageItem, type PlanUsageItem,
} from './PlanUsage'

const daily: LimitedPlanUsageItem = { feature: 'AI_SEARCH', period: 'DAY', limit: 10, used: 8, resetsAt: '2026-10-09T00:00:00+09:00' }
const unlimited: PlanUsageItem = { feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: null, used: 42, resetsAt: daily.resetsAt }
const drafts: LimitedPlanUsageItem = { feature: 'APPLICATION_DRAFT', period: 'MONTH', limit: 3, used: 4, resetsAt: '2026-11-01T00:00:00+09:00' }
// 하루 한도가 다시 채워지기 3시간 전(서울 저녁 9시)입니다.
const evening = Date.parse('2026-10-08T21:00:00+09:00')

describe('PlanUsage', () => {
  it('names every plan in Korean', () => {
    expect(planLabels).toEqual({ FREE: '무료', PLUS: '플러스', PREMIUM: '프리미엄' })
  })

  it('warns while some uses are still left, even for small monthly limits', () => {
    expect(isNearPlanLimit(daily)).toBe(true)
    expect(isNearPlanLimit({ ...daily, used: 7 })).toBe(false)
    // 월 3회는 마지막 1회가 남았을 때 미리 알립니다(80%로 올리면 다 쓴 뒤에야 알리게 됩니다).
    expect(isNearPlanLimit({ ...drafts, used: 1 })).toBe(false)
    expect(isNearPlanLimit({ ...drafts, used: 2 })).toBe(true)
    // 로그인 전 체험 2회는 1회를 쓰면 알립니다. 한도 1회는 미리 알릴 틈이 없습니다.
    expect(isNearPlanLimit({ ...daily, limit: 2, used: 1 })).toBe(true)
    expect(isNearPlanLimit({ ...daily, limit: 1, used: 0 })).toBe(false)
    expect(isPlanLimitReached(daily)).toBe(false)
    expect(remainingPlanUses(daily)).toBe(2)
  })

  it('shows what is left on the line and what was used against the limit in detail', () => {
    expect(planUsageCountText(daily)).toBe('오늘 2회 남음')
    expect(planUsageUsedText(daily)).toBe('10회 중 8회 썼어요')
    // 진행 중인 요청이 남아 한도를 넘겨 세어져도 화면은 한도에서 멈춥니다.
    expect(planUsageCountText({ ...daily, used: 11 })).toBe('오늘 0회 남음')
    expect(planUsageUsedText({ ...daily, used: 11 })).toBe('10회 중 10회 썼어요')
    expect(planUsageCountText(drafts)).toBe('이번 달 0건 남음')
    expect(planUsageUsedText(drafts)).toBe('3건 중 3건 썼어요')
    expect(remainingPlanUses(drafts)).toBe(0)
  })

  it('explains what counts as one use for every feature', () => {
    expect(Object.keys(planUsageCountingRules).sort()).toEqual(['AI_SEARCH', 'APPLICATION_DRAFT', 'COMBINATION_REVIEW', 'EVIDENCE_QUESTION'])
    expect(planUsageCountingRules.AI_SEARCH).toContain('조건을 정리하는 대화와 필터 검색은 세지 않고')
  })

  it('never warns or blocks a plan without a limit and says so instead of a count against a limit', () => {
    expect(hasPlanLimit(unlimited)).toBe(false)
    expect(hasPlanLimit(daily)).toBe(true)
    expect(isNearPlanLimit(unlimited)).toBe(false)
    expect(isPlanLimitReached(unlimited)).toBe(false)
    expect(planUsageCountText(unlimited)).toBe('오늘 42회 · 제한 없음')
    expect(planUsageUsedText(unlimited)).toBeNull()
    expect(planUsageCountText({ ...drafts, limit: null, used: 7 })).toBe('이번 달 7건 · 제한 없음')
  })

  it('says how long until the daily reset instead of a clock time and keeps the date for monthly limits', () => {
    expect(planUsageResetText(daily, evening)).toBe('약 3시간 뒤에 다시 채워져요.')
    // 분은 적지 않고 가까운 시간으로 반올림합니다(3시간 13분 → 약 3시간, 19시간 57분 → 약 20시간).
    expect(planUsageResetText(daily, Date.parse('2026-10-08T20:47:30+09:00'))).toBe('약 3시간 뒤에 다시 채워져요.')
    expect(planUsageResetText(daily, Date.parse('2026-10-08T04:03:00+09:00'))).toBe('약 20시간 뒤에 다시 채워져요.')
    // 1시간이 안 남았으면 1시간 안에, 이미 지났으면(다시 읽기 전) 곧이라고 적습니다.
    expect(planUsageResetText(daily, Date.parse('2026-10-08T23:35:00+09:00'))).toBe('1시간 안에 다시 채워져요.')
    expect(planUsageResetText(daily, Date.parse('2026-10-09T00:00:05+09:00'))).toBe('곧 다시 채워져요.')
    // 달 한도는 서울 날짜 그대로 읽습니다. 기기 시간대로 바꾸면 월초 0시가 전날로 보일 수 있습니다.
    expect(planUsageResetText(drafts, evening)).toBe('11월 1일에 다시 채워져요.')
  })

  it('explains what the user can still do when a quota is used up', () => {
    expect(planQuotaExceededMessage({ ...daily, plan: null, limit: 2 }))
      .toBe('로그인 전 체험 2회를 모두 썼어요. 로그인하면 회원 한도로 이어서 검색할 수 있고, 필터 검색은 계속 쓸 수 있어요.')
    expect(planQuotaExceededMessage({ ...daily, plan: 'FREE' }, evening))
      .toBe('오늘 AI 대화 검색 10회를 모두 썼어요. 약 3시간 뒤에 다시 채워져요. 필터 검색은 계속 쓸 수 있어요.')
    expect(planQuotaExceededMessage({ feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: 10, plan: 'FREE', resetsAt: daily.resetsAt }, evening))
      .toBe('오늘 공고 원문 질문 10회를 모두 썼어요. 약 3시간 뒤에 다시 채워져요.')
    expect(planQuotaExceededMessage({ ...drafts, plan: 'FREE' }))
      .toBe('이번 달 신청 문서 초안 3건을 모두 썼어요. 이미 시작한 공고의 문서는 계속 만들 수 있어요. 11월 1일에 다시 채워져요.')
    expect(planQuotaExceededMessage({ feature: 'COMBINATION_REVIEW', period: 'MONTH', limit: 3, plan: 'FREE', resetsAt: drafts.resetsAt }))
      .toBe('이번 달 중복 검토 3회를 모두 썼어요. 진행 중인 검토도 횟수에 들어가요. 11월 1일에 다시 채워져요.')
  })

  it('counts a pass against its thirty-day period and says when the period and the pass end', () => {
    const pass: LimitedPlanUsageItem = { feature: 'AI_SEARCH', period: 'PLAN', limit: 500, used: 20, resetsAt: '2026-10-31T15:30:00+09:00' }
    expect(planUsageCountText(pass)).toBe('이번 기간 480회 남음')
    expect(planUsageUsedText(pass)).toBe('500회 중 20회 썼어요')
    // 이용권은 산 시각부터 30일이라 날짜와 서울 시각을 함께 적습니다.
    expect(planUsageResetText(pass)).toBe('10월 31일 15:30에 이번 기간이 끝나요.')
    expect(planQuotaExceededMessage({ ...pass, plan: 'PLUS' }))
      .toBe('이번 기간 AI 대화 검색 500회를 모두 썼어요. 10월 31일 15:30에 이번 기간이 끝나요. 필터 검색은 계속 쓸 수 있어요.')
    expect(planQuotaExceededMessage({ feature: 'APPLICATION_DRAFT', period: 'PLAN', limit: 5, plan: 'PLUS', resetsAt: pass.resetsAt }))
      .toBe('이번 기간 신청 문서 초안 5건을 모두 썼어요. 이미 시작한 공고의 문서는 계속 만들 수 있어요. 10월 31일 15:30에 이번 기간이 끝나요.')
    expect(planEndsText({ planEndsAt: '2026-10-31T15:30:00+09:00' })).toBe('10월 31일 15:30까지 이용할 수 있어요.')
    expect(planEndsText({ planEndsAt: null })).toBeNull()
    expect(planEndsText(null)).toBeNull()
    expect(planUsageDeletionNote).toBe('신청 문서와 중복 검토는 지워도 이미 쓴 횟수가 돌아오지 않아요.')
  })

  it('finds a feature only when the usage was loaded', () => {
    expect(findPlanUsageItem(null, 'AI_SEARCH')).toBeNull()
    expect(findPlanUsageItem({ plan: 'FREE', items: [daily] }, 'AI_SEARCH')).toBe(daily)
    expect(findPlanUsageItem({ plan: 'FREE', items: [daily] }, 'EVIDENCE_QUESTION')).toBeNull()
  })
})
