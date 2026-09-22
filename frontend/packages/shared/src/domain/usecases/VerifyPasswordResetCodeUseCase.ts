import type { AccountRepository, VerifyPasswordResetCodeResult } from '../repositories/AccountRepository'
import { normalizeEmail } from '../entities/EmailAddress'
import { isValidSignupEmailCode } from './VerifySignupEmailCodeUseCase'

type VerifyPasswordResetCodeRepository = Pick<AccountRepository, 'verifyPasswordResetCode'>

/** 비밀번호 찾기에서 메일로 받은 6자리 인증번호를 확인하고 새 비밀번호 저장에 쓸 통행 토큰을 받습니다. 인증번호 형식은 가입과 같습니다. */
export class VerifyPasswordResetCodeUseCase {
  private readonly repository: VerifyPasswordResetCodeRepository

  constructor(repository: VerifyPasswordResetCodeRepository) {
    this.repository = repository
  }

  execute(email: string, code: string, signal?: AbortSignal): Promise<VerifyPasswordResetCodeResult> {
    const trimmed = code.trim()
    if (!isValidSignupEmailCode(trimmed)) throw new RangeError('code must be 6 digits')
    return this.repository.verifyPasswordResetCode(normalizeEmail(email), trimmed, signal)
  }
}
