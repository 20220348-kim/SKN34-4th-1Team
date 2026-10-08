import { planUsageSchema } from '@govbiz/shared/data/models/PlanUsageDto'
import type { PlanUsageRepository } from '@govbiz/shared/domain/repositories/PlanUsageRepository'
import { PlanUsageUseCase } from '@govbiz/shared/domain/usecases/PlanUsageUseCase'
import { apiRequest } from './client'

/** 로그인했으면 Bearer 세션의 요금제를, 아니면 요금제 없음을 읽습니다. 응답은 shared 계약으로 검증합니다. */
function repository(accessToken?: string): PlanUsageRepository {
  return {
    usage: async (signal) => planUsageSchema.parse(await apiRequest('/api/v1/plan-usage', { accessToken, signal })),
  }
}

export const planUsageUseCase = (accessToken?: string) => new PlanUsageUseCase(repository(accessToken))
