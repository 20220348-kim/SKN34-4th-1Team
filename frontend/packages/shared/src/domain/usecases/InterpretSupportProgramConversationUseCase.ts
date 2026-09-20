import type { SupportProgramInterpretRequest } from '../entities/SupportProgramConversation'
import type { SupportProgramRepository } from '../repositories/SupportProgramRepository'

/** 새 발화의 변경안을 얻을 뿐, 조건 적용이나 공고 검색은 실행하지 않습니다. */
export class InterpretSupportProgramConversationUseCase {
  private readonly repository: Pick<SupportProgramRepository, 'interpretConversation'>

  constructor(repository: Pick<SupportProgramRepository, 'interpretConversation'>) {
    this.repository = repository
  }

  execute(command: SupportProgramInterpretRequest, signal?: AbortSignal) {
    return this.repository.interpretConversation(command, signal)
  }
}
