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

/** 서버와 같은 규칙(앞뒤 공백 제거·소문자)으로 이메일을 정규화합니다. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
