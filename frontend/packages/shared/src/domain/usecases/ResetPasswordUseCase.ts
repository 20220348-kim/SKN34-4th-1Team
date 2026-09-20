import type { AccountRepository, ResetPasswordResult } from '../repositories/AccountRepository'
import { isValidSignUpPassword, signUpPasswordLength } from './SignUpUseCase'

type ResetPasswordRepository = Pick<AccountRepository, 'resetPassword'>

export type PasswordResetCommand = {
  /** 메일 링크의 일회용 토큰입니다. 43자 URL-safe Base64입니다. */
  token: string
  newPassword: string
}

/** 메일 링크의 토큰으로 새 비밀번호를 저장합니다. 비밀번호 길이 규칙은 가입과 같습니다. */
export class ResetPasswordUseCase {
  private readonly repository: ResetPasswordRepository

  constructor(repository: ResetPasswordRepository) {
    this.repository = repository
  }

  execute(command: PasswordResetCommand, signal?: AbortSignal): Promise<ResetPasswordResult> {
    if (!isValidSignUpPassword(command.newPassword)) {
      throw new RangeError(`password must be ${signUpPasswordLength.min}~${signUpPasswordLength.max} characters`)
    }
    return this.repository.resetPassword(command.token.trim(), command.newPassword, signal)
  }
}
