import type { AccountRepository, RequestPasswordResetResult } from '../repositories/AccountRepository'
import { normalizeEmail } from './LogInUseCase'

type RequestPasswordResetRepository = Pick<AccountRepository, 'requestPasswordReset'>

/** 가입 이메일로 비밀번호 재설정 링크를 요청합니다. 가입 여부와 관계없이 같은 결과라 계정 존재가 드러나지 않습니다. */
export class RequestPasswordResetUseCase {
  private readonly repository: RequestPasswordResetRepository

  constructor(repository: RequestPasswordResetRepository) {
    this.repository = repository
  }

  execute(email: string, signal?: AbortSignal): Promise<RequestPasswordResetResult> {
    return this.repository.requestPasswordReset(normalizeEmail(email), signal)
  }
}
