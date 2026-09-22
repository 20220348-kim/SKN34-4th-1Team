import type {
  AccountRepository,
  AccountSignUp,
  SignUpResult,
} from '../repositories/AccountRepository'
import { normalizeEmail } from './LogInUseCase'

type SignUpRepository = Pick<AccountRepository, 'signUp'>

/** 비밀번호 길이 규칙입니다. 서버와 같이 최소 8자이며 BCrypt의 UTF-8 72바이트 한도를 지킵니다. */
export const signUpPasswordLength = { min: 8, max: 72, maxBytes: 72 } as const

/** 웹과 네이티브에서 같은 UTF-8 바이트 수를 계산합니다. */
export function isPasswordWithinByteLimit(password: string): boolean {
  let bytes = 0
  for (const character of password) {
    const point = character.codePointAt(0)!
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes > signUpPasswordLength.maxBytes) return false
  }
  return true
}

export function isValidSignUpPassword(password: string): boolean {
  return password.length >= signUpPasswordLength.min && password.length <= signUpPasswordLength.max && isPasswordWithinByteLimit(password)
}

/** 정규화한 이메일과 입력한 비밀번호 그대로 가입을 요청합니다. 성공하면 서버가 바로 세션을 발급합니다. */
export class SignUpUseCase {
  private readonly repository: SignUpRepository

  constructor(repository: SignUpRepository) {
    this.repository = repository
  }

  execute(command: AccountSignUp, signal?: AbortSignal): Promise<SignUpResult> {
    if (!isValidSignUpPassword(command.password)) {
      throw new RangeError(`password must be ${signUpPasswordLength.min}~${signUpPasswordLength.max} characters and at most ${signUpPasswordLength.maxBytes} UTF-8 bytes`)
    }
    return this.repository.signUp(
      { email: normalizeEmail(command.email), password: command.password, emailPassToken: command.emailPassToken.trim() },
      signal,
    )
  }
}
