import * as Crypto from 'expo-crypto'
import * as WebBrowser from 'expo-web-browser'
import { openOAuthLogin, readOAuthCallback } from './oauth'

jest.mock('expo-constants', () => ({ __esModule: true, default: { executionEnvironment: 'standalone' }, ExecutionEnvironment: { StoreClient: 'storeClient' } }))
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: jest.fn(), digestStringAsync: jest.fn(), CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, CryptoEncoding: { BASE64: 'base64' } }))
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(), WebBrowserResultType: { CANCEL: 'cancel' } }))
jest.mock('../api/client', () => ({ getApiBaseUrl: () => 'https://api.example.com' }))
const code = 'a'.repeat(43)

test('OAuth callback rejects wrong destinations, mismatched state, repeated codes, and errors', () => {
  expect(readOAuthCallback(`govbiz://oauth/complete?code=${code}&state=expected`, 'expected')).toBe(code)
  for (const url of [
    `other://oauth/complete?code=${code}&state=expected`,
    `govbiz://oauth/other?code=${code}&state=expected`,
    `govbiz://oauth/complete?code=${code}&state=unexpected`,
    `govbiz://oauth/complete?code=${code}&code=${code}&state=expected`,
    'govbiz://oauth/complete?error=failed&state=expected',
    'govbiz://oauth/complete?code=invalid&state=expected',
  ]) expect(() => readOAuthCallback(url, 'expected')).toThrow()
})

test('system-browser OAuth uses PKCE and only returns a matching one-time code', async () => {
  jest.mocked(Crypto.getRandomBytesAsync).mockImplementation(async (length) => new Uint8Array(length).fill(0))
  jest.mocked(Crypto.digestStringAsync).mockResolvedValue('ab+c/d==')
  jest.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({ type: 'success', url: `govbiz://oauth/complete?code=${code}&state=${'A'.repeat(43)}` })
  expect(await openOAuthLogin('google')).toEqual({ code, codeVerifier: 'A'.repeat(64), redirectUri: 'govbiz://oauth/complete' })
  const start = new URL(jest.mocked(WebBrowser.openAuthSessionAsync).mock.calls[0][0])
  expect(start.pathname).toBe('/api/v1/auth/mobile/oauth/google/authorize')
  expect(start.searchParams.get('codeChallenge')).toBe('ab-c_d')
  expect(start.searchParams.has('codeVerifier')).toBe(false)
})

test('cancelling the browser does not produce an exchange code', async () => {
  jest.mocked(Crypto.getRandomBytesAsync).mockImplementation(async (length) => new Uint8Array(length))
  jest.mocked(Crypto.digestStringAsync).mockResolvedValue('digest')
  jest.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({ type: WebBrowser.WebBrowserResultType.CANCEL })
  expect(await openOAuthLogin('kakao')).toBeNull()
})
