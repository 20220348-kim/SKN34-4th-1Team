// Actual Vite routing with isolated HTTP replay servers, not running Core/Ops.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from '../../../frontend/web/node_modules/vite/dist/node/index.js'
import { getOpsSession, OpsApiError } from '../../../frontend/web/src/data/ops/opsApi.ts'

const root = fileURLToPath(new URL('../../../frontend/web/', import.meta.url))
const cookie = 'govbiz_session=restore-proxy-fixture'
const envKeys = ['K8S_CORE_PORT', 'K8S_OPS_PORT', 'K8S_DEV_LOGIN']

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function close(server) {
  if (!server.listening) return
  const stopped = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  server.closeAllConnections()
  await stopped
}

export async function withRestoreProxy(responses, verify) {
  const originalFetch = globalThis.fetch
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  const read = new Set()
  const violations = []
  const coreReads = []
  let origin, vite, cache, result
  const core = createServer((request, response) => {
    coreReads.push(request.url)
    const valid = request.method === 'GET' && request.url === '/api/v1/health'
      && request.headers.host === `127.0.0.1:${core.address().port}`
      && request.headers.origin === origin && request.headers.cookie === cookie
    if (!valid) violations.push('Core routing or forwarded headers differ')
    response.writeHead(valid ? 200 : 400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ service: 'restore-proxy-core-fixture' }))
  })
  const ops = createServer((request, response) => {
    if (request.method !== 'GET' || request.headers.host !== new URL(origin).host || request.headers.origin !== origin) {
      violations.push('Ops method, Host or Origin differs')
      response.writeHead(400).end()
      return
    }
    const code = request.headers.cookie === cookie ? 200 : request.headers.cookie === 'govbiz_session=member-fixture' ? 403 : 401
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Cache-Control', 'private, no-store')
    if (code !== 200) {
      response.writeHead(code).end('{}')
    } else if (!Object.hasOwn(responses, request.url)) {
      violations.push('Uncaptured Ops route requested')
      response.writeHead(404).end('{}')
    } else {
      read.add(request.url)
      response.end(JSON.stringify(responses[request.url]))
    }
  })
  try {
    const corePort = await listen(core)
    const opsPort = await listen(ops)
    process.env.K8S_CORE_PORT = String(corePort)
    process.env.K8S_OPS_PORT = String(opsPort)
    process.env.K8S_DEV_LOGIN = 'false'
    cache = await mkdtemp(resolve(tmpdir(), 'govbiz-restore-proxy-'))
    vite = await createViteServer({
      root, configFile: resolve(root, 'vite.config.ts'), configLoader: 'native',
      mode: 'portfolio', logLevel: 'silent', cacheDir: cache,
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null, preTransformRequests: false },
    })
    assert.equal(vite.config.server.proxy['/api'].target, `http://127.0.0.1:${corePort}`)
    assert.equal(vite.config.server.proxy['/api/v1/ops'].target, `http://127.0.0.1:${opsPort}`)
    assert.equal(vite.config.envDir, false)
    await vite.listen()
    origin = `http://127.0.0.1:${vite.httpServer.address().port}`
    const request = (path, session = cookie) => originalFetch(origin + path, {
      headers: { Origin: origin, ...(session ? { Cookie: session } : {}) },
      redirect: 'error', signal: AbortSignal.timeout(5000),
    })
    const document = await request('/ops/evaluations')
    assert.equal(document.status, 200)
    assert.match(document.headers.get('content-type'), /text\/html/)
    const html = await document.text()
    assert.ok(html.includes('<div id="root"></div>') && html.includes('/src/main.tsx'))
    const health = await request('/api/v1/health')
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { service: 'restore-proxy-core-fixture' })
    for (const [session, status] of [[null, 401], ['govbiz_session=invalid-fixture', 401], ['govbiz_session=member-fixture', 403]]) {
      const denied = await request('/api/v1/ops/session', session)
      assert.equal(denied.status, status)
      assert.equal(denied.headers.get('cache-control'), 'private, no-store')
      assert.deepEqual(await denied.json(), {})
    }
    globalThis.fetch = async (path, options = {}) => {
      assert.ok(!options.method || options.method === 'GET', 'Restore web contract must only read')
      assert.ok(Object.hasOwn(responses, path), 'Missing captured management response')
      assert.equal(options.credentials, 'same-origin')
      const response = await request(path)
      if (response.ok) assert.equal(response.headers.get('cache-control'), 'private, no-store')
      return response
    }
    result = await verify()
    assert.equal(read.size, Object.keys(responses).length, 'Some captured responses were never proxied')
    await close(ops)
    await assert.rejects(() => getOpsSession(), (error) => error instanceof OpsApiError && error.status === 502)
    const stillCore = await request('/api/v1/health')
    assert.equal(stillCore.status, 200)
    await stillCore.arrayBuffer()
    assert.deepEqual(coreReads, ['/api/v1/health', '/api/v1/health'])
    assert.deepEqual(violations, [])
  } finally {
    globalThis.fetch = originalFetch
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    const stopped = await Promise.allSettled([vite?.close(), close(ops), close(core)])
    if (cache) {
      assert.ok(cache.startsWith(resolve(tmpdir()) + sep + 'govbiz-restore-proxy-'))
      await rm(cache, { recursive: true, force: true })
    }
    assert.ok(stopped.every((outcome) => outcome.status === 'fulfilled'), 'Restore proxy cleanup failed')
  }
  return { ...result, proxy_http: {
    status: 'PASS', mode: 'portfolio', response_source: 'captured_restore_http',
    routes_verified: true, credentials_forwarded: true, unauthorized_status_preserved: true,
    outage_rejected: true, document_served: true, servers_stopped: true, browser_rendered: false,
  } }
}
