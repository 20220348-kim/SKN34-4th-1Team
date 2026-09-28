import type {
  AccountRepository,
  AccountSignUp,
  SignUpResult,
} from '../repositories/AccountRepository'
import { normalizeEmail } from './LogInUseCase'

type SignUpRepository = Pick<AccountRepository, 'signUp'>

/** 비밀번호 길이 규칙입니다. 서버와 같이 8~72자이며 BCrypt의 UTF-8 72바이트 한도도 문자 규칙과 별개로 지킵니다. */
export const signUpPasswordLength = { min: 8, max: 72, maxBytes: 72 } as const

/** 웹과 네이티브에서 같은 UTF-8 바이트 수를 계산합니다. 허용 문자를 넓혀도 BCrypt 한도가 남도록 따로 둡니다. */
export function isPasswordWithinByteLimit(password: string): boolean {
  let bytes = 0
  for (const character of password) {
    const point = character.codePointAt(0)!
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes > signUpPasswordLength.maxBytes) return false
  }
  return true
}

/** 국내 서비스 관례대로 영문 대·소문자, 숫자, 특수문자(공백을 뺀 ASCII)만 받습니다. 한글·이모지·공백은 거부합니다. */
export const signUpPasswordPattern = /^[\x21-\x7e]*$/

export function hasAllowedSignUpPasswordCharacters(password: string): boolean {
  return signUpPasswordPattern.test(password)
}

export type SignUpPasswordIssue = 'tooShort' | 'tooLong' | 'invalidCharacter'

/** 규칙에 어긋난 첫 이유입니다. 길이, 문자 종류, 바이트 순으로 보며 맞으면 null입니다. */
export function signUpPasswordIssue(password: string): SignUpPasswordIssue | null {
  if (password.length < signUpPasswordLength.min) return 'tooShort'
  if (password.length > signUpPasswordLength.max) return 'tooLong'
  if (!hasAllowedSignUpPasswordCharacters(password)) return 'invalidCharacter'
  if (!isPasswordWithinByteLimit(password)) return 'tooLong'
  return null
}

export function isValidSignUpPassword(password: string): boolean {
  return signUpPasswordIssue(password) === null
}

/** 정규화한 이메일과 입력한 비밀번호 그대로 가입을 요청합니다. 성공하면 서버가 바로 세션을 발급합니다. */
export class SignUpUseCase {
  private readonly repository: SignUpRepository

  constructor(repository: SignUpRepository) {
    this.repository = repository
  }

  execute(command: AccountSignUp, signal?: AbortSignal): Promise<SignUpResult> {
    if (!isValidSignUpPassword(command.password)) {
      throw new RangeError(`password must be ${signUpPasswordLength.min}~${signUpPasswordLength.max} ASCII letters, digits or symbols and at most ${signUpPasswordLength.maxBytes} UTF-8 bytes`)
    }
    return this.repository.signUp(
      { email: normalizeEmail(command.email), password: command.password, emailPassToken: command.emailPassToken.trim() },
      signal,
    )
  }
}
