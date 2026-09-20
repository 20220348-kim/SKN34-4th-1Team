import * as Crypto from 'expo-crypto'
import * as WebBrowser from 'expo-web-browser'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import { getApiBaseUrl } from '../api/client'

export const oauthRedirectUri = 'govbiz://oauth/complete'
export type MobileOAuthProvider = 'google' | 'kakao'
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function supportsNativeOAuth(): boolean {
  return Constants.executionEnvironment !== ExecutionEnvironment.StoreClient
}

async function randomUrlSafe(length: number): Promise<string> {
  return Array.from(await Crypto.getRandomBytesAsync(length), (byte) => alphabet[byte & 63]).join('')
}

export function readOAuthCallback(callbackUrl: string, expectedState: string): string {
  const url = new URL(callbackUrl)
  const expected = new URL(oauthRedirectUri)
  if (url.protocol !== expected.protocol || url.host !== expected.host || url.pathname !== expected.pathname || url.hash || url.username || url.password) {
    throw new Error('올바른 로그인 응답 주소가 아닙니다. 다시 시도해 주세요.')
  }
  if (url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== expectedState) {
    throw new Error('로그인 요청 확인에 실패했습니다. 다시 시도해 주세요.')
  }
  const failure = url.searchParams.get('error')
  if (failure !== null) {
    const messages: Record<string, string> = {
      cancelled: '소셜 로그인이 취소되었습니다.', expired: '로그인 요청이 만료되었습니다. 다시 시도해 주세요.',
      'email-required': '소셜 계정에서 이메일 정보 제공에 동의한 뒤 다시 시도해 주세요.',
      'account-exists': '같은 이메일로 가입한 계정이 있습니다. 기존 로그인 방법을 사용해 주세요.',
      'unlink-pending': '이전 계정의 연결 해제가 진행 중입니다. 잠시 뒤 다시 시도해 주세요.',
      suspended: '현재 사용할 수 없는 계정입니다. 계정 상태를 확인해 주세요.',
      'rate-limited': '로그인 요청이 많습니다. 잠시 뒤 다시 시도해 주세요.',
    }
    throw new Error(messages[failure] ?? '소셜 로그인을 완료하지 못했습니다. 다시 시도해 주세요.')
  }
  const code = url.searchParams.get('code')
  if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code) || url.searchParams.getAll('code').length !== 1) throw new Error('로그인 인증 코드가 없습니다. 다시 시도해 주세요.')
  return code
}

export async function openOAuthLogin(provider: MobileOAuthProvider): Promise<{ code: string; codeVerifier: string; redirectUri: string } | null> {
  if (!supportsNativeOAuth()) throw new Error('소셜 로그인은 GovBiz 개발 빌드 또는 설치된 앱에서 사용할 수 있습니다.')
  const state = await randomUrlSafe(43)
  const codeVerifier = await randomUrlSafe(64)
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, codeVerifier, { encoding: Crypto.CryptoEncoding.BASE64 })
  const codeChallenge = digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const query = new URLSearchParams({ redirectUri: oauthRedirectUri, state, codeChallenge, rememberMe: 'true' })
  const result = await WebBrowser.openAuthSessionAsync(`${getApiBaseUrl()}/api/v1/auth/mobile/oauth/${provider}/authorize?${query}`, oauthRedirectUri)
  if (result.type !== 'success') return null
  return { code: readOAuthCallback(result.url, state), codeVerifier, redirectUri: oauthRedirectUri }
}
