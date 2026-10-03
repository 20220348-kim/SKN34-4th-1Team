// Real React/Vite/Chromium with disposable HTTP auth fixtures, not Kubernetes proof.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer as createViteServer } from '../../../frontend/web/node_modules/vite/dist/node/index.js'
import { checkBrowserLogin } from './ops_browser_login.mjs'

const email = 'admin@example.invalid', password = 'disposable-test-password'
const id = '10000000-0000-4000-8000-000000000001'
const body = '<html><body>합성 보고서</body></html>'
const expected = { [id]: { execution_spec_sha256: 'a'.repeat(64), report_sha256: createHash('sha256').update(body).digest('hex') } }
const dataset = { id: 'browser-login-fixture', label: '검증 자료', case_ids: ['E01'], captures: [{ id: 'saved', label: '저장' }],
  baseline: null, fixture: 'fixture.json', live_config: null, execution_profiles: { replay: 'b'.repeat(64), live: null } }
const at = '2026-10-03T00:00:00Z'
const run = {
  id, dataset_id: dataset.id, dataset_label: dataset.label, requested_by: email, requested_by_id: 'core:1',
  can_retry: false, candidate_capture_id: 'saved', reference_capture_id: 'saved', candidate_label: '저장', reference_label: '저장',
  comparison: null, execution_mode: 'replay', live_config: null, status: 'COMPLETED', status_label: '완료',
  created_at: at, started_at: null, finished_at: at, synced_at: at, error_code: '', error_message: '', summary: {},
  model_api_calls: 0, evaluation_run_id: null, trace_links: [], prefect_flow_run_id: null, prefect_url: null, langfuse_url: null,
  report_url: `/api/v1/ops/evaluations/${id}/report`, execution_spec_sha256: expected[id].execution_spec_sha256,
}

async function fixture(defect, verify) {
  let origin, vite, loggedIn = false, logouts = 0
  const token = randomUUID(), requests = [], violations = []
  const originalEnv = Object.fromEntries(['K8S_CORE_PORT', 'K8S_OPS_PORT', 'K8S_DEV_LOGIN'].map((key) => [key, process.env[key]]))
  const cache = await mkdtemp(resolve(tmpdir(), 'govbiz-browser-login-'))
  const send = (reply, status, data) => { reply.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }).end(JSON.stringify(data)) }
  const authorized = (request) => loggedIn && request.headers.cookie?.includes('govbiz_session=' + token)
  const core = createServer(async (request, reply) => {
    requests.push([request.method, request.url])
    if (request.method === 'POST' && request.headers.origin !== origin) violations.push('Core Origin differs')
    if (request.url === '/api/v1/auth/login' && request.method === 'POST') {
      let raw = ''
      for await (const chunk of request) raw += chunk
      if (raw !== JSON.stringify({ email, password, rememberMe: false })) { send(reply, 401, {}); return }
      loggedIn = true
      if (defect !== 'missing_cookie') reply.setHeader('Set-Cookie', `govbiz_session=${token}; HttpOnly; SameSite=Lax; Path=/`)
      send(reply, 200, { expiresAt: '2027-01-01T00:00:00Z', account: { email, role: 'ADMIN', tier: 'MEMBER', emailVerified: true, onboarded: true, company: null } })
    } else if (request.url === '/api/v1/auth/logout' && request.method === 'POST') {
      logouts++
      loggedIn = false
      reply.writeHead(204, { 'Set-Cookie': 'govbiz_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax' }).end()
    } else if (request.url === '/api/v1/admin/session') {
      send(reply, authorized(request) ? 200 : 401, { accountId: 1, email, role: 'ADMIN' })
    } else {
      violations.push('Unexpected Core route')
      send(reply, 404, {})
    }
  })
  const ops = createServer((request, reply) => {
    requests.push([request.method, request.url])
    if (request.method !== 'GET' || request.headers.host !== new URL(origin).host) violations.push('Ops method or Host differs')
    if (request.url === '/api/v1/ops/session') {
      send(reply, 200, { user: authorized(request) ? { id: defect === 'wrong_principal' ? 'core:99' : 'core:1', username: email } : null,
        csrf_token: 'test-csrf', live_enabled: false, rag_live_enabled: false, datasets: authorized(request) ? [dataset] : [] })
    } else if (!authorized(request) && !(defect === 'logout_bypass' && request.url === run.report_url)) send(reply, 401, {})
    else if (request.url === '/api/v1/ops/evaluations?page=1') send(reply, 200, { count: 1, next: null, previous: null, results: [run] })
    else if (request.url === `/api/v1/ops/evaluations/${id}`) send(reply, 200, run)
    else if (request.url === `/api/v1/ops/evaluations/${id}/budget`) send(reply, 200, { as_of: at, state: 'not_applicable', reservation: null, calls: [] })
    else if (request.url === '/api/v1/ops/budget/reservations?page=1') send(reply, 200, { as_of: at, count: 0, next: null, previous: null, results: [],
      summary: { state: 'unconfigured', limits: null, allocated: null, remaining: null, breakdown: null, reservation_count: 0, legacy_live_run_count: 0, change_count: 0, recent_changes: [] } })
    else if (request.url === run.report_url) reply.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'" }).end(body)
    else { violations.push('Unexpected Ops route'); send(reply, 404, {}) }
  })
  try {
    for (const server of [core, ops]) { server.listen(0, '127.0.0.1'); await once(server, 'listening') }
    process.env.K8S_CORE_PORT = String(core.address().port)
    process.env.K8S_OPS_PORT = String(ops.address().port)
    process.env.K8S_DEV_LOGIN = 'false'
    const root = fileURLToPath(new URL('../../../frontend/web/', import.meta.url))
    vite = await createViteServer({ root, configFile: resolve(root, 'vite.config.ts'), configLoader: 'native', mode: 'portfolio',
      logLevel: 'silent', cacheDir: cache, server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null, preTransformRequests: false } })
    await vite.listen()
    const optimizer = vite.environments.client.depsOptimizer
    await optimizer?.scanProcessing
    await Promise.all(Object.values(optimizer?.metadata.discovered ?? {}).map((item) => item.processing))
    origin = 'http://127.0.0.1:' + vite.httpServer.address().port
    await verify({ origin, email, password, expected })
    assert.deepEqual(violations, [])
    if (defect !== 'missing_cookie') assert.equal(logouts, 1, 'Issued session was not cleaned up')
    assert.ok(requests.every(([method, path]) => method === 'GET' || ['/api/v1/auth/login', '/api/v1/auth/logout'].includes(path)))
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await vite?.close()
    for (const server of [core, ops]) {
      const stopped = new Promise((done) => server.close(done))
      server.closeAllConnections()
      await stopped
    }
    await rm(cache, { recursive: true, force: true })
  }
}

test('browser uses the real login form, server-issued cookie, Ops detail, refresh and logout with HTTP fixtures', { timeout: 120000 }, async () => {
  await fixture(null, async (input) => {
    const proof = await checkBrowserLogin(input)
    assert.equal(proof.status, 'PASS')
    assert.equal(proof.response_source, 'core_ops_http')
    assert.equal(proof.details_verified, 1)
    assert.equal(proof.reports_verified, 1)
    assert.equal(proof.browser_closed, true)
    assert.equal(proof.unauthorized_after_logout, true)
    assert.ok(!JSON.stringify(proof).includes(password) && !JSON.stringify(proof).includes(email))
  })
})

for (const [defect, message] of [['missing_cookie', /cookie is missing/], ['wrong_principal', /Core principal/], ['logout_bypass', /remained available/]]) {
  test(`browser rejects ${defect} and cleans up`, { timeout: 120000 }, async () => {
    await fixture(defect, async (input) => { await assert.rejects(checkBrowserLogin(input), message) })
  })
}

test('external origins and missing credentials are rejected before opening a browser', async () => {
  for (const input of [{ origin: 'https://external.invalid' }, { origin: 'http://127.0.0.1:5173', password: '' }]) {
    await assert.rejects(checkBrowserLogin({ origin: 'http://127.0.0.1:5173', email, password, expected, ...input }))
  }
})

test('CLI failures redact login input and emit only the fixed error code', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ops_browser_login.mjs', import.meta.url))], {
    input: JSON.stringify({ origin: 'https://external.invalid', email, password, expected }), encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'KUBERNETES_BROWSER_LOGIN_FAILED\n')
})
