import type { PlanUsageRepository } from '@govbiz/shared/domain/repositories/PlanUsageRepository'
import { planUsageRequest } from '../api/planUsageApi'

export class PlanUsageRepositoryImpl implements PlanUsageRepository {
  usage(signal?: AbortSignal) { return planUsageRequest(signal) }
}
