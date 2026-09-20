import type { AccountRepository, SendSignupEmailCodeResult } from '../repositories/AccountRepository'
import { normalizeEmail } from './LogInUseCase'

type SendSignupEmailCodeRepository = Pick<AccountRepository, 'sendSignupEmailCode'>

/** 가입할 이메일로 6자리 인증번호를 요청합니다. 이미 가입된 이메일이면 서버가 409로 알려 줍니다. */
export class SendSignupEmailCodeUseCase {
  private readonly repository: SendSignupEmailCodeRepository

  constructor(repository: SendSignupEmailCodeRepository) {
    this.repository = repository
  }

  execute(email: string, signal?: AbortSignal): Promise<SendSignupEmailCodeResult> {
    return this.repository.sendSignupEmailCode(normalizeEmail(email), signal)
  }
}
