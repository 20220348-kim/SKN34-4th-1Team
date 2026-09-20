import type { AccountRepository, VerifySignupEmailCodeResult } from '../repositories/AccountRepository'
import { normalizeEmail } from './LogInUseCase'

type VerifySignupEmailCodeRepository = Pick<AccountRepository, 'verifySignupEmailCode'>

/** 인증번호 형식입니다. 서버와 같은 6자리 숫자입니다. */
export function isValidSignupEmailCode(code: string): boolean {
  return /^[0-9]{6}$/.test(code)
}

/** 메일로 받은 인증번호를 확인하고 가입 요청에 실을 통행 토큰을 받습니다. */
export class VerifySignupEmailCodeUseCase {
  private readonly repository: VerifySignupEmailCodeRepository

  constructor(repository: VerifySignupEmailCodeRepository) {
    this.repository = repository
  }

  execute(email: string, code: string, signal?: AbortSignal): Promise<VerifySignupEmailCodeResult> {
    const trimmed = code.trim()
    if (!isValidSignupEmailCode(trimmed)) throw new RangeError('code must be 6 digits')
    return this.repository.verifySignupEmailCode(normalizeEmail(email), trimmed, signal)
  }
}
