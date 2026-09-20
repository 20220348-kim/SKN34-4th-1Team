import type { SupportProgramSearchReadiness } from '../entities/SupportProgramSearchReadiness'
import type { SupportProgramRepository } from '../repositories/SupportProgramRepository'

type SupportProgramSearchReadinessRepository = Pick<
  SupportProgramRepository,
  'getSearchReadiness'
>

/** 검색 전에 공고 데이터와 검색 인덱스가 준비됐는지 확인합니다. */
export class GetSupportProgramSearchReadinessUseCase {
  private readonly repository: SupportProgramSearchReadinessRepository

  constructor(repository: SupportProgramSearchReadinessRepository) {
    this.repository = repository
  }

  execute(signal?: AbortSignal): Promise<SupportProgramSearchReadiness> {
    return this.repository.getSearchReadiness(signal)
  }
}
