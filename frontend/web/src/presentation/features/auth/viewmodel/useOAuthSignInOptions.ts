import { useMemo } from 'react'

import { appContainer } from '../../../../app/appContainer'
import { oauthProviderIds, type OAuthProviderId } from '../../../../domain/entities/OAuthProvider'
import type { StartOAuthSignInUseCase } from '../../../../domain/usecases/OAuthSignInUseCases'

type StartUseCase = Pick<StartOAuthSignInUseCase, 'startUrl'>

/** 버튼 하나입니다. [href]는 서버의 로그인 시작 주소에 복귀 경로·로그인 유지 여부를 붙인 값입니다. */
export type OAuthSignInOption = {
  id: OAuthProviderId
  href: string
}

/**
 * 로그인·회원가입 ViewModel이 함께 쓰는 소셜 로그인 버튼 목록입니다. 요청 없이 계산해 화면이 뜨자마자 두 버튼이 보이고,
 * 키가 없는 공급자는 누르면 서버가 로그인 화면으로 돌려보내 안내합니다. 버튼은 링크라 브라우저가 서버 주소로 이동합니다.
 */
export function useOAuthSignInOptions(
  { returnPath, rememberMe }: { returnPath: string; rememberMe: boolean },
  startOAuthSignInUseCase: StartUseCase = appContainer.resolve('startOAuthSignInUseCase'),
): OAuthSignInOption[] {
  return useMemo(
    () => oauthProviderIds.map((id) => ({ id, href: startOAuthSignInUseCase.startUrl(id, { returnPath, rememberMe }) })),
    [startOAuthSignInUseCase, returnPath, rememberMe],
  )
}
