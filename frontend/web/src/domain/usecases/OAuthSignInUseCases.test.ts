import { describe, expect, it } from 'vitest'

import type { OAuthProviderId } from '../entities/OAuthProvider'
import { StartOAuthSignInUseCase } from './OAuthSignInUseCases'

const absolute = new StartOAuthSignInUseCase({
  oauthStartUrl: (provider: OAuthProviderId) => `http://127.0.0.1:5173/api/v1/auth/oauth/${provider}/authorize`,
})

describe('StartOAuthSignInUseCase', () => {
  it('서버 시작 주소에 복귀 경로와 로그인 상태 유지를 붙인다', () => {
    expect(absolute.startUrl('kakao', { returnPath: '/app/partners?tab=mine', rememberMe: true }))
      .toBe('http://127.0.0.1:5173/api/v1/auth/oauth/kakao/authorize?next=%2Fapp%2Fpartners%3Ftab%3Dmine&rememberMe=true')
  })

  it('복귀 경로가 없고 로그인 유지를 끄면 시작 주소만 연다', () => {
    expect(absolute.startUrl('google', { returnPath: '', rememberMe: false }))
      .toBe('http://127.0.0.1:5173/api/v1/auth/oauth/google/authorize')
  })

  it('Compose처럼 같은 origin의 상대 주소도 그대로 쓴다', () => {
    const relative = new StartOAuthSignInUseCase({ oauthStartUrl: (provider) => `/api/v1/auth/oauth/${provider}/authorize` })

    expect(relative.startUrl('google', { returnPath: '/app/chat', rememberMe: false }))
      .toBe('/api/v1/auth/oauth/google/authorize?next=%2Fapp%2Fchat')
  })
})
