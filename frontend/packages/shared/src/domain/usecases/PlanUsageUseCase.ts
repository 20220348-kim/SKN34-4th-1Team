import type { PlanUsageRepository } from '../repositories/PlanUsageRepository'

/** 현재 요금제를 읽습니다. 로그인 전에는 요금제 없이 돌려받습니다. */
export class PlanUsageUseCase {
  private readonly repository: PlanUsageRepository
  constructor(repository: PlanUsageRepository) { this.repository = repository }
  usage(signal?: AbortSignal) { return this.repository.usage(signal) }
}
