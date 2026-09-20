// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import middleware from './middleware.ts'

describe('Vercel 운영 API 라우팅', () => {
  beforeEach(() => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('GOVBIZ_API_ORIGIN', 'https://test-distribution.cloudfront.net')
    vi.stubEnv('GOVBIZ_FRONTEND_ORIGIN', 'https://govbiz-test.vercel.app')
    vi.stubEnv('GOVBIZ_PROXY_SECRET', 'a'.repeat(64))
  })
  afterEach(() => vi.unstubAllEnvs())

  const request = (ip = '203.0.113.12', url = 'https://govbiz-test.vercel.app/api/v1/support-programs/search?query=서울') =>
    new Request(url, { headers: { 'x-vercel-forwarded-for': ip } })

  it('API 접두사와 쿼리를 보존하고 개인별 응답의 캐시를 끈다', () => {
    const response = middleware(request())
    const target = new URL(response.headers.get('x-middleware-rewrite')!)
    expect(target.origin).toBe('https://test-distribution.cloudfront.net')
    expect(target.pathname).toBe('/api/v1/support-programs/search')
    expect(target.searchParams.get('query')).toBe('서울')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-vercel-enable-rewrite-caching')).toBe('0')
  })

  it('쿠키·Origin을 전달하되 위조 전달 헤더와 비밀키는 덮어쓴다', () => {
    const incoming = new Request('https://govbiz-test.vercel.app/api/v1/auth/login', {
      method: 'POST', body: '{"email":"test@example.com"}', headers: {
        'content-type': 'application/json', cookie: 'session=test',
        origin: 'https://govbiz-test.vercel.app', 'x-vercel-forwarded-for': '2001:db8::1',
        'x-forwarded-for': '1.2.3.4', forwarded: 'for=1.2.3.4',
        'x-govbiz-proxy-secret': 'forged', 'x-govbiz-client-ip': '1.2.3.4',
      },
    })
    const response = middleware(incoming)
    expect(response.headers.get('x-middleware-request-cookie')).toBe('session=test')
    expect(response.headers.get('x-middleware-request-origin')).toBe('https://govbiz-test.vercel.app')
    expect(response.headers.get('x-middleware-request-x-govbiz-client-ip')).toBe('2001:db8::1')
    expect(response.headers.get('x-middleware-request-x-govbiz-proxy-secret')).toBe('a'.repeat(64))
    expect(response.headers.get('x-middleware-request-forwarded')).toBeNull()
    expect(response.headers.get('x-middleware-request-x-forwarded-for')).toBeNull()
    expect(incoming.bodyUsed).toBe(false)
  })

  it.each(['GET', 'PUT', 'DELETE'])('대화 기록 %s 요청의 계정 확인 헤더를 그대로 전달한다', (method) => {
    const email = encodeURIComponent('member+chat@example.com')
    const incoming = new Request('https://govbiz-test.vercel.app/api/v1/me/chat-conversations', {
      method, headers: { 'x-vercel-forwarded-for': '203.0.113.12', 'X-Chat-Account': email, cookie: 'session=member' },
    })
    const response = middleware(incoming)
    expect(response.headers.get('x-middleware-request-x-chat-account')).toBe(email)
    expect(response.headers.get('x-middleware-request-cookie')).toBe('session=member')
  })
  it.each(['', '1.2.3.4, 5.6.7.8', 'localhost', '999.1.1.1'])('잘못된 IP %s를 거부한다', (ip) => {
    expect(middleware(request(ip)).status).toBe(400)
  })
  it('미리보기 환경에서는 운영 API를 호출하지 않는다', () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect(middleware(request()).status).toBe(403)
  })
  it('운영 환경의 다른 배포 별칭도 거부한다', () => {
    expect(middleware(request('203.0.113.1', 'https://other.vercel.app/api/v1/health')).status).toBe(403)
  })
  it.each(['http://test.cloudfront.net', 'https://test.cloudfront.net.evil.com', 'https://test.cloudfront.net/api', ''])('허용하지 않은 upstream %s에 비밀값을 보내지 않는다', (origin) => {
    vi.stubEnv('GOVBIZ_API_ORIGIN', origin)
    expect(middleware(request()).status).toBe(503)
  })
  it('누락된 비밀값으로 프록시를 열지 않는다', () => {
    vi.stubEnv('GOVBIZ_PROXY_SECRET', '')
    expect(middleware(request()).status).toBe(503)
  })
})
