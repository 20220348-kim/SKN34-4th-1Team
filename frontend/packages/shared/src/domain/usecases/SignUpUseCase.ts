import type {
  AccountRepository,
  AccountSignUp,
  SignUpResult,
} from '../repositories/AccountRepository'
import { normalizeEmail } from './LogInUseCase'

type SignUpRepository = Pick<AccountRepository, 'signUp'>

/** 비밀번호 길이 규칙입니다. 서버와 같은 값이며 72자는 BCrypt가 반영하는 최대 길이입니다. */
export const signUpPasswordLength = { min: 8, max: 72 } as const

export function isValidSignUpPassword(password: string): boolean {
  return password.length >= signUpPasswordLength.min && password.length <= signUpPasswordLength.max
}

/** 정규화한 이메일과 입력한 비밀번호 그대로 가입을 요청합니다. 성공하면 서버가 바로 세션을 발급합니다. */
export class SignUpUseCase {
  private readonly repository: SignUpRepository

  constructor(repository: SignUpRepository) {
    this.repository = repository
  }

  execute(command: AccountSignUp, signal?: AbortSignal): Promise<SignUpResult> {
    if (!isValidSignUpPassword(command.password)) {
      throw new RangeError(`password must be ${signUpPasswordLength.min}~${signUpPasswordLength.max} characters`)
    }
    return this.repository.signUp(
      { email: normalizeEmail(command.email), password: command.password, emailPassToken: command.emailPassToken.trim() },
      signal,
    )
  }
}
