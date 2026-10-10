export type PlanCode = 'FREE' | 'PLUS' | 'PREMIUM'
export type PlanUsageFeature = 'AI_SEARCH' | 'EVIDENCE_QUESTION'
export type PlanUsagePeriod = 'DAY'

/** 한 기능의 이번 기간 사용량입니다. limit이 null이면 그 요금제는 아직 한도를 정하지 않아 제한하지 않습니다. */
export type PlanUsageItem = {
  feature: PlanUsageFeature
  period: PlanUsagePeriod
  limit: number | null
  used: number
  /** 다음 초기화 시각(서울 +09:00, ISO 8601)입니다. */
  resetsAt: string
}

/** 한도가 정해진 기능의 사용량입니다. 이용량 줄과 한도 안내는 이 경우에만 그립니다. */
export type LimitedPlanUsageItem = PlanUsageItem & { limit: number }

/** 현재 요금제와 기능별 사용량입니다. 로그인하지 않았으면 plan이 null이고 AI 대화 검색 체험만 있습니다. */
export type PlanUsage = { plan: PlanCode | null; items: PlanUsageItem[] }

export const planLabels: Record<PlanCode, string> = { FREE: '무료', PLUS: '플러스', PREMIUM: '프리미엄' }

export const planUsageFeatureLabels: Record<PlanUsageFeature, string> = {
  AI_SEARCH: 'AI 대화 검색',
  EVIDENCE_QUESTION: '공고 원문 질문',
}

export function findPlanUsageItem(usage: PlanUsage | null, feature: PlanUsageFeature): PlanUsageItem | null {
  return usage?.items.find((item) => item.feature === feature) ?? null
}

export function hasPlanLimit(item: PlanUsageItem): item is LimitedPlanUsageItem {
  return item.limit !== null
}

export function remainingPlanUses(item: LimitedPlanUsageItem): number {
  return Math.max(0, item.limit - item.used)
}

/** 다 쓰기 전에 알릴 시점입니다. 한도의 80%부터 미리 보여 줍니다. 한도가 없으면 알리지 않습니다. */
export function isNearPlanLimit(item: PlanUsageItem): boolean {
  return item.limit !== null && item.limit > 0 && item.used >= Math.ceil(item.limit * 0.8)
}

export function isPlanLimitReached(item: PlanUsageItem): boolean {
  return item.limit !== null && item.used >= item.limit
}

/** 예: "오늘 8/10회". 한도가 없으면 "오늘 8회 · 제한 없음"입니다. 진행 중인 요청 때문에 한도를 넘겨 보이지 않게 한도에서 멈춥니다. */
export function planUsageCountText(item: PlanUsageItem): string {
  if (item.limit === null) return `오늘 ${item.used}회 · 제한 없음`
  return `오늘 ${Math.min(item.used, item.limit)}/${item.limit}회`
}

/** 예: "자정(서울 시간)에 다시 채워져요." */
export function planUsageResetText(_item: Pick<PlanUsageItem, 'period' | 'resetsAt'>): string {
  return '자정(서울 시간)에 다시 채워져요.'
}

export type PlanQuotaExceeded = Pick<PlanUsageItem, 'feature' | 'period' | 'resetsAt'> & { limit: number; plan: PlanCode | null }

/** 한도를 다 썼을 때 사용자에게 보여 줄 한 문단입니다. 계속 쓸 수 있는 다른 방법을 함께 알립니다. */
export function planQuotaExceededMessage(quota: PlanQuotaExceeded): string {
  const reset = planUsageResetText(quota)
  switch (quota.feature) {
    case 'AI_SEARCH':
      return quota.plan === null
        ? `로그인 전 체험 ${quota.limit}회를 모두 썼어요. 로그인하면 회원 한도로 이어서 검색할 수 있고, 필터 검색은 계속 쓸 수 있어요.`
        : `오늘 AI 대화 검색 ${quota.limit}회를 모두 썼어요. ${reset} 필터 검색은 계속 쓸 수 있어요.`
    case 'EVIDENCE_QUESTION':
      return `오늘 공고 원문 질문 ${quota.limit}회를 모두 썼어요. ${reset}`
  }
}

export const quotaUnavailableMessage = '지금은 이용량을 확인할 수 없어 실행하지 않았어요. 잠시 후 다시 시도해 주세요.'
