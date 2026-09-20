import { isIP } from 'node:net'
import { rewrite } from '@vercel/functions'

export const config = { matcher: '/api/:path*', runtime: 'nodejs' }

const noCache = {
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'x-vercel-enable-rewrite-caching': '0',
}

// Vercel 서버에서만 실행한다. 브라우저 번들에 이 파일이나 비밀값을 import하지 않는다.
export default function middleware(request: Request) {
  const backend = process.env.GOVBIZ_API_ORIGIN ?? ''
  const frontend = process.env.GOVBIZ_FRONTEND_ORIGIN ?? ''
  const secret = process.env.GOVBIZ_PROXY_SECRET ?? ''
  if (!/^https:\/\/[a-z0-9-]+\.cloudfront\.net$/.test(backend)
    || !/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(frontend)
    || !/^[a-f0-9]{64}$/.test(secret)) {
    return new Response('API 배포 설정이 준비되지 않았습니다.', { status: 503, headers: noCache })
  }

  const incoming = new URL(request.url)
  // Preview/임의 배포 별칭에서 운영 DB와 세션을 공유하지 않는다.
  if (process.env.VERCEL_ENV !== 'production' || incoming.origin !== frontend) {
    return new Response('운영 주소에서 이용해 주세요.', { status: 403, headers: noCache })
  }
  if (incoming.pathname !== '/api' && !incoming.pathname.startsWith('/api/')) {
    return new Response(null, { status: 404, headers: noCache })
  }

  // Vercel이 설정하는 단일 IP만 사용한다. 사용자가 보낸 X-Forwarded-For는 신뢰하지 않는다.
  const clientIp = request.headers.get('x-vercel-forwarded-for') ?? ''
  if (!isIP(clientIp)) {
    return new Response('접속 주소를 확인할 수 없습니다.', { status: 400, headers: noCache })
  }
  const headers = new Headers()
  for (const name of ['accept', 'accept-language', 'content-type', 'cookie', 'origin', 'authorization', 'x-chat-account']) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set('x-govbiz-proxy-secret', secret)
  headers.set('x-govbiz-client-ip', clientIp)
  const destination = new URL(backend)
  destination.pathname = incoming.pathname
  destination.search = incoming.search
  // 요청 body를 읽거나 fetch로 재전송하지 않는다. 메서드/body/Set-Cookie는 외부 rewrite가 중계한다.
  return rewrite(destination, { request: { headers }, headers: noCache })
}
