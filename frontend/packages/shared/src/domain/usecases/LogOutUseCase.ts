import type { AccountRepository } from '../repositories/AccountRepository'

type LogOutRepository = Pick<AccountRepository, 'logOut'>

/** 서버 세션을 삭제하고 브라우저에 저장된 토큰을 지웁니다. */
export class LogOutUseCase {
  private readonly repository: LogOutRepository

  constructor(repository: LogOutRepository) {
    this.repository = repository
  }

  execute(signal?: AbortSignal): Promise<void> {
    return this.repository.logOut(signal)
  }
}
