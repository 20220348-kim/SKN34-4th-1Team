import type { AccountDeletionPreview } from '../entities/AccountDeletionPreview'
import type { AccountRepository, ChangePasswordResult, DeleteAccountResult } from '../repositories/AccountRepository'
import { isValidSignUpPassword, signUpPasswordLength } from './SignUpUseCase'

/** 새 비밀번호로 바꿉니다. 본인 확인은 로그인 세션이 맡고, 새 비밀번호 규칙은 가입과 같으며, 다른 기기의 세션은 서버가 끝냅니다. */
export class ChangePasswordUseCase {
  private readonly repository: Pick<AccountRepository, 'changePassword'>

  constructor(repository: Pick<AccountRepository, 'changePassword'>) {
    this.repository = repository
  }

  execute(newPassword: string, signal?: AbortSignal): Promise<ChangePasswordResult> {
    if (!isValidSignUpPassword(newPassword)) {
      throw new RangeError(`newPassword must be ${signUpPasswordLength.min}~${signUpPasswordLength.max} characters`)
    }
    return this.repository.changePassword(newPassword, signal)
  }
}

/** 삭제 확인 모달을 열 때 함께 사라지는 것들의 수를 읽습니다. */
export class GetAccountDeletionPreviewUseCase {
  private readonly repository: Pick<AccountRepository, 'getDeletionPreview'>

  constructor(repository: Pick<AccountRepository, 'getDeletionPreview'>) {
    this.repository = repository
  }

  execute(signal?: AbortSignal): Promise<AccountDeletionPreview> {
    return this.repository.getDeletionPreview(signal)
  }
}

/** 현재 비밀번호를 확인한 뒤 계정을 삭제합니다. 성공하면 서버가 세션 쿠키를 만료시키고 앱은 힌트를 지웁니다. */
export class DeleteAccountUseCase {
  private readonly repository: Pick<AccountRepository, 'deleteAccount'>

  constructor(repository: Pick<AccountRepository, 'deleteAccount'>) {
    this.repository = repository
  }

  /** 비밀번호가 없는 소셜 가입 계정은 `null`로 부릅니다. 비밀번호가 있는 계정은 빈 문자열을 보낼 수 없습니다. */
  execute(password: string | null, signal?: AbortSignal): Promise<DeleteAccountResult> {
    if (password === '') throw new RangeError('password must not be empty')
    return this.repository.deleteAccount(password, signal)
  }
}
