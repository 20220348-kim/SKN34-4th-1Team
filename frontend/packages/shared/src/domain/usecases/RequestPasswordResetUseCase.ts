import type { AccountRepository, RequestPasswordResetResult } from '../repositories/AccountRepository'
import { normalizeEmail } from './LogInUseCase'

type RequestPasswordResetRepository = Pick<AccountRepository, 'requestPasswordReset'>

/** 가입 이메일로 비밀번호 재설정 6자리 인증번호를 요청합니다. 미가입·소셜 전용 계정은 결과로 구분해 화면이 안내합니다. */
export class RequestPasswordResetUseCase {
  private readonly repository: RequestPasswordResetRepository

  constructor(repository: RequestPasswordResetRepository) {
    this.repository = repository
  }

  execute(email: string, signal?: AbortSignal): Promise<RequestPasswordResetResult> {
    return this.repository.requestPasswordReset(normalizeEmail(email), signal)
  }
}
