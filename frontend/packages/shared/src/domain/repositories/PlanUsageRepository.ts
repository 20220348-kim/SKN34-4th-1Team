import type { PlanUsage } from '../entities/PlanUsage'

export interface PlanUsageRepository {
  usage(signal?: AbortSignal): Promise<PlanUsage>
}
