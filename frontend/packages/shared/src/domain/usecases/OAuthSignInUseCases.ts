import type { Account } from '../entities/Account'
import type { OAuthProviderId } from '../entities/OAuthProvider'
import type { AccountRepository } from '../repositories/AccountRepository'

type OAuthStartRepository = Pick<AccountRepository, 'oauthStartUrl'>
type OAuthSignInRepository = Pick<AccountRepository, 'completeOAuthSignIn'>

/**
 * 소셜 로그인 버튼이 여는 주소를 요청 없이 계산합니다. 화면은 이 주소를 링크로 바로 그리고, 키가 없는 공급자는 서버가
 * 로그인 화면으로 돌려보내 안내합니다.
 */
export class StartOAuthSignInUseCase {
  private readonly repository: OAuthStartRepository

  constructor(repository: OAuthStartRepository) {
    this.repository = repository
  }

  /** 서버 시작 주소에 로그인 뒤 돌아올 앱 경로와 로그인 상태 유지 여부를 붙입니다. 복귀 경로는 서버도 다시 확인합니다. */
  startUrl(provider: OAuthProviderId, options: { returnPath: string; rememberMe: boolean }): string {
    const params = new URLSearchParams()
    if (options.returnPath) params.set('next', options.returnPath)
    if (options.rememberMe) params.set('rememberMe', 'true')
    const base = this.repository.oauthStartUrl(provider)
    const query = params.toString()
    return query ? `${base}?${query}` : base
  }
}

/** 서버 콜백이 세션 쿠키를 심은 뒤 로그인한 계정을 확인합니다. 세션이 없으면 null입니다. */
export class CompleteOAuthSignInUseCase {
  private readonly repository: OAuthSignInRepository

  constructor(repository: OAuthSignInRepository) {
    this.repository = repository
  }

  execute(signal?: AbortSignal): Promise<Account | null> {
    return this.repository.completeOAuthSignIn(signal)
  }
}
