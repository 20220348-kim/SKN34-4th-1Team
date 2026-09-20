import type { Account } from '../entities/Account'
import type { AccountRepository } from '../repositories/AccountRepository'

type CurrentAccountRepository = Pick<AccountRepository, 'getCurrentAccount'>

/** 앱 시작 시 저장된 세션으로 로그인 상태를 복원합니다. */
export class GetCurrentAccountUseCase {
  private readonly repository: CurrentAccountRepository

  constructor(repository: CurrentAccountRepository) {
    this.repository = repository
  }

  execute(signal?: AbortSignal): Promise<Account | null> {
    return this.repository.getCurrentAccount(signal)
  }
}
