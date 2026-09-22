import { normalizeEmail } from '../entities/EmailAddress'
import type {
  AccountLogIn,
  AccountRepository,
  LogInResult,
} from '../repositories/AccountRepository'

type LogInRepository = Pick<AccountRepository, 'logIn'>

/** 정규화한 이메일과 입력한 비밀번호 그대로 로그인을 요청합니다. */
export class LogInUseCase {
  private readonly repository: LogInRepository

  constructor(repository: LogInRepository) {
    this.repository = repository
  }

  execute(command: AccountLogIn, signal?: AbortSignal): Promise<LogInResult> {
    return this.repository.logIn({
      email: normalizeEmail(command.email),
      password: command.password,
      rememberMe: command.rememberMe,
    }, signal)
  }
}

// 이메일 정규화·형식 검사는 EmailAddress 엔티티에 있습니다. 기존 import 경로를 위해 다시 내보냅니다.
export { normalizeEmail }
