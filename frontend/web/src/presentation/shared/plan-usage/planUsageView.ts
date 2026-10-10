import {
  findPlanUsageItem,
  hasPlanLimit,
  isNearPlanLimit,
  isPlanLimitReached,
  planQuotaExceededMessage,
  planUsageCountText,
  planUsageFeatureLabels,
  planUsageResetText,
  type LimitedPlanUsageItem,
  type PlanUsage,
  type PlanUsageFeature,
} from '@govbiz/shared/domain/entities/PlanUsage'
import { PlanQuotaExceededError, QuotaUnavailableError } from '@govbiz/shared/domain/errors/PlanQuotaError'

/** 화면 한 곳에 보여 줄 기능 하나의 이용량입니다. 한도에 다다르면 limitMessage로 다 쓴 사실과 다른 방법을 알립니다. */
export type PlanUsageView = {
  item: LimitedPlanUsageItem
  label: string
  /** "오늘 2/10회", 로그인 전 AI 대화 검색은 "로그인 전 체험 1/2회"입니다. */
  countText: string
  isNearLimit: boolean
  isLimitReached: boolean
  resetText: string
  limitMessage: string
}

/**
 * 이용량을 읽지 못했거나 그 기능이 없으면(로그인 전의 회원 전용 기능), 또는 그 요금제가 아직 한도 없이 쓰는 기능이면 null입니다.
 * 화면은 이때 아무것도 그리지 않습니다.
 */
export function planUsageView(usage: PlanUsage | null, feature: PlanUsageFeature): PlanUsageView | null {
  const item = findPlanUsageItem(usage, feature)
  if (usage === null || item === null || !hasPlanLimit(item)) return null
  // 로그인 전 체험은 접속 주소 기준이라 "오늘" 대신 체험임을 앞에 둡니다.
  const countText = usage.plan === null && feature === 'AI_SEARCH'
    ? `로그인 전 체험 ${Math.min(item.used, item.limit)}/${item.limit}회`
    : planUsageCountText(item)
  return {
    item,
    label: planUsageFeatureLabels[feature],
    countText,
    isNearLimit: isNearPlanLimit(item),
    isLimitReached: isPlanLimitReached(item),
    resetText: planUsageResetText(item),
    limitMessage: planQuotaExceededMessage({ ...item, plan: usage.plan }),
  }
}

/** 서버가 요금제 한도(429)나 이용량 확인 실패(503)로 실행하지 않았으면 그 안내 문구이고, 아니면 null입니다. */
export function planQuotaFailureMessage(error: unknown): string | null {
  return error instanceof PlanQuotaExceededError || error instanceof QuotaUnavailableError ? error.message : null
}

/** 진행 막대의 채운 비율(0~100)입니다. 진행 중인 작업 때문에 한도를 넘겨 세어져도 100에서 멈춥니다. */
export function planUsagePercent(item: LimitedPlanUsageItem): number {
  return item.limit > 0 ? Math.round((Math.min(item.used, item.limit) / item.limit) * 100) : 100
}
