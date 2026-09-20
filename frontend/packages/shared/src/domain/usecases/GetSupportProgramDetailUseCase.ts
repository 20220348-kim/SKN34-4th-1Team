import type { SupportProgram } from '../entities/SupportProgram'
import type {
  SupportProgramIdentity,
  SupportProgramRepository,
} from '../repositories/SupportProgramRepository'

type SupportProgramDetailRepository = Pick<SupportProgramRepository, 'getDetail'>

/** URL의 공고 원본 식별자로 상세 정보를 가져오는 유스케이스입니다. */
export class GetSupportProgramDetailUseCase {
  private readonly repository: SupportProgramDetailRepository

  constructor(repository: SupportProgramDetailRepository) {
    this.repository = repository
  }

  execute(
    identity: SupportProgramIdentity,
    signal?: AbortSignal,
  ): Promise<SupportProgram | null> {
    return this.repository.getDetail(identity, signal)
  }
}
