import type { PlanUsageRepository } from '../repositories/PlanUsageRepository'

/** 현재 요금제와 기능별 남은 사용량을 읽습니다. 로그인 전에는 접속 주소의 AI 대화 검색 체험만 돌려받습니다. */
export class PlanUsageUseCase {
  private readonly repository: PlanUsageRepository
  constructor(repository: PlanUsageRepository) { this.repository = repository }
  usage(signal?: AbortSignal) { return this.repository.usage(signal) }
}
