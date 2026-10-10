import type { PlanUsage, TrialPlanCode } from '../entities/PlanUsage'

export interface PlanTrialRepository {
  /** 출시 전 무료 체험을 시작하고 바뀐 요금제와 이용량을 돌려받습니다. */
  start(plan: TrialPlanCode, signal?: AbortSignal): Promise<PlanUsage>
}
