import type { TrialPlanCode } from '@govbiz/shared/domain/entities/PlanUsage'
import type { PlanTrialRepository } from '@govbiz/shared/domain/repositories/PlanTrialRepository'
import { planTrialRequest } from '../api/planUsageApi'

export class PlanTrialRepositoryImpl implements PlanTrialRepository {
  start(plan: TrialPlanCode, signal?: AbortSignal) { return planTrialRequest(plan, signal) }
}
