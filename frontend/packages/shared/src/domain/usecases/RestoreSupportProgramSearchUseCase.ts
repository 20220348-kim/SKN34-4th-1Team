import type { SupportProgramRepository } from '../repositories/SupportProgramRepository'

/** 저장된 추천 결과를 읽으며 해석·검색·모델 호출을 다시 실행하지 않습니다. */
export class RestoreSupportProgramSearchUseCase {
  private readonly repository: Pick<SupportProgramRepository, 'restoreSearch'>

  constructor(repository: Pick<SupportProgramRepository, 'restoreSearch'>) {
    this.repository = repository
  }

  execute(resultToken: string, signal?: AbortSignal) {
    return this.repository.restoreSearch(resultToken, signal)
  }
}
