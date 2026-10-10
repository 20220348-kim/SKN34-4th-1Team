import type { TrialPlanCode } from '../entities/PlanUsage'
import type { PlanTrialRepository } from '../repositories/PlanTrialRepository'

/**
 * 출시 전 무료 체험(플러스·프리미엄 각 14일, 요금제마다 한 번)을 시작합니다. 결제 수단을 받지 않아 끝나면 무료로 돌아갑니다.
 * 앱은 요금제를 바꾸는 동작을 두지 않으므로 웹 요금제 화면만 씁니다.
 */
export class PlanTrialUseCase {
  private readonly repository: PlanTrialRepository
  constructor(repository: PlanTrialRepository) { this.repository = repository }
  start(plan: TrialPlanCode, signal?: AbortSignal) { return this.repository.start(plan, signal) }
}
