export type PlanCode = 'FREE' | 'PLUS' | 'PREMIUM'

/** 현재 요금제입니다. 로그인하지 않았으면 plan이 null입니다. */
export type PlanUsage = { plan: PlanCode | null }

export const planLabels: Record<PlanCode, string> = { FREE: '무료', PLUS: '플러스', PREMIUM: '프리미엄' }
