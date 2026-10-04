// Real React/Vite/Chromium with disposable HTTP auth fixtures, not Kubernetes proof.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer as createViteServer } from '../../../frontend/web/node_modules/vite/dist/node/index.js'
import { checkBrowserLogin } from './ops_browser_login.mjs'
import { runLiveRestore } from './ops_restore_live_browser.mjs'

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

async function fixture(defect, verify, count = 1) {
  let origin, vite, loggedIn = false, logouts = 0
  const token = randomUUID(), requests = [], violations = [], revokedReads = []
  const rows = Array.from({ length: count }, (_, index) => {
    const rowId = '10000000-0000-4000-8000-' + String(index + 1).padStart(12, '0')
    return { ...run, id: rowId, report_url: `/api/v1/ops/evaluations/${rowId}/report` }
  })
  const required = Object.fromEntries([rows[0], rows.at(-1)].map((row) => [row.id, expected[id]]))
  const originalEnv = Object.fromEntries(['K8S_CORE_PORT', 'K8S_OPS_PORT', 'K8S_DEV_LOGIN'].map((key) => [key, process.env[key]]))
  const cache = await mkdtemp(resolve(tmpdir(), 'govbiz-browser-login-'))
  const send = (reply, status, data) => { reply.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }).end(JSON.stringify(data)) }
  const hasCookie = (request) => request.headers.cookie?.includes('govbiz_session=' + token)
  const authorized = (request) => loggedIn && hasCookie(request)
  const core = createServer(async (request, reply) => {
    requests.push([request.method, request.url])
    if (!loggedIn && hasCookie(request)) revokedReads.push(request.url)
    if (request.method === 'POST' && request.headers.origin !== origin) violations.push('Core Origin differs')
    if (request.url === '/api/v1/auth/login' && request.method === 'POST') {
      let raw = ''
      for await (const chunk of request) raw += chunk
      if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify({ email, password, rememberMe: false })) { send(reply, 401, {}); return }
      loggedIn = true
      if (defect !== 'missing_cookie') reply.setHeader('Set-Cookie', `govbiz_session=${token}; HttpOnly; SameSite=Lax; Path=/`)
      send(reply, 200, { expiresAt: '2027-01-01T00:00:00Z', account: { email, role: 'ADMIN', tier: 'MEMBER', emailVerified: true, onboarded: true, company: null } })
    } else if (request.url === '/api/v1/auth/logout' && request.method === 'POST') {
      logouts++
      loggedIn = false
      reply.writeHead(204, { 'Set-Cookie': 'govbiz_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax' }).end()
    } else if (request.url === '/api/v1/admin/session') {
      send(reply, authorized(request) || defect === 'revoked_core' && hasCookie(request) ? 200 : 401, { accountId: 1, email, role: 'ADMIN' })
    } else {
      violations.push('Unexpected Core route')
      send(reply, 404, {})
    }
  })
  const ops = createServer((request, reply) => {
    requests.push([request.method, request.url])
    if (!loggedIn && hasCookie(request)) revokedReads.push(request.url)
    if (request.method !== 'GET' || request.headers.host !== new URL(origin).host) violations.push('Ops method or Host differs')
    const url = new URL(request.url, origin)
    const row = rows.find((item) => request.url === `/api/v1/ops/evaluations/${item.id}`)
    const report = rows.some((item) => request.url === item.report_url)
    const budget = rows.some((item) => request.url === `/api/v1/ops/evaluations/${item.id}/budget`)
    const invalidSessionAccepted = hasCookie(request) && (
      defect === 'revoked_list' && url.pathname === '/api/v1/ops/evaluations' ||
      defect === 'revoked_detail' && row || defect === 'revoked_budget' && budget || defect === 'revoked_report' && report
    )
    if (request.url === '/api/v1/ops/session') {
      send(reply, 200, { user: authorized(request) ? { id: defect === 'wrong_principal' ? 'core:99' : 'core:1', username: email } : null,
        csrf_token: 'test-csrf', live_enabled: false, rag_live_enabled: false, datasets: authorized(request) ? [dataset] : [] })
    } else if (!authorized(request) && !invalidSessionAccepted && !(defect === 'logout_bypass' && report)) send(reply, 401, {})
    else if (url.pathname === '/api/v1/ops/evaluations') {
      const page = Number(url.searchParams.get('page'))
      const values = rows.slice((page - 1) * 25, page * 25)
      if (page === 2 && defect === 'duplicate_row') values[0] = rows[0]
      if (page === 2 && defect === 'missing_row') values.pop()
      send(reply, 200, {
        count: page === 2 && defect === 'changed_count' ? count + 1 : count,
        next: page * 25 < count ? (defect === 'external_next' ? 'https://external.invalid' : origin) + `/api/v1/ops/evaluations?page=${page + 1}` : null,
        previous: page > 1 ? origin + `/api/v1/ops/evaluations?page=${page - 1}` : null, results: values,
      })
    }
    else if (row) send(reply, 200, row)
    else if (budget) send(reply, 200, { as_of: at, state: 'not_applicable', reservation: null, calls: [] })
    else if (request.url === '/api/v1/ops/schedules?page=1') send(reply, 200, { enabled: false, timezone: 'Asia/Seoul', page: 1, total: 0, results: [] })
    else if (request.url === '/api/v1/ops/budget/reservations?page=1') send(reply, 200, { as_of: at, count: 0, next: null, previous: null, results: [],
      summary: { state: 'unconfigured', limits: null, allocated: null, remaining: null, breakdown: null, reservation_count: 0, legacy_live_run_count: 0, change_count: 0, recent_changes: [] } })
    else if (report) reply.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'" }).end(body)
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
    await verify({ origin, email, password, expected: required })
    assert.deepEqual(violations, [])
    if (defect !== 'missing_cookie') assert.equal(logouts, 1, 'Issued session was not cleaned up')
    assert.ok(requests.every(([method, path]) => method === 'GET' || ['/api/v1/auth/login', '/api/v1/auth/logout'].includes(path)))
    if (!defect) {
      assert.deepEqual(new Set(revokedReads), new Set([
        '/api/v1/admin/session',
        ...Array.from({ length: Math.ceil(count / 25) }, (_, index) => `/api/v1/ops/evaluations?page=${index + 1}`),
        ...Object.keys(required).flatMap((key) => ['', '/budget', '/report'].map((suffix) => `/api/v1/ops/evaluations/${key}${suffix}`)),
      ]), 'Revocation checks must actually send the issued cookie')
    }
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
    const stages = []
    const proof = await checkBrowserLogin(input, (stage) => stages.push(stage))
    assert.deepEqual(stages, ['LAUNCH', 'LOGIN_FORM', 'PASSWORD_LOGIN', 'SESSION', 'IDENTITY', 'RELOAD', 'LIST', 'DETAIL', 'REPORT', 'LOGOUT', 'ANONYMOUS', 'REVOKED_SESSION'])
    assert.equal(proof.status, 'PASS')
    assert.equal(proof.response_source, 'core_ops_http')
    assert.equal(proof.details_verified, 1)
    assert.equal(proof.reports_verified, 1)
    assert.equal(proof.browser_closed, true)
    assert.equal(proof.unauthorized_after_logout, true)
    assert.equal(proof.revoked_session_rejected, true)
    assert.equal(proof.pagination_complete, true)
    assert.equal(proof.listed_run_count, 1)
    assert.equal(proof.pages_verified, 1)
    assert.ok(!JSON.stringify(proof).includes(password) && !JSON.stringify(proof).includes(email))
  })
})

test('browser traverses two pages and opens expected details from both pages', { timeout: 120000 }, async () => {
  await fixture(null, async (input) => {
    const proof = await checkBrowserLogin(input)
    assert.equal(proof.listed_run_count, 26)
    assert.equal(proof.pages_verified, 2)
    assert.equal(proof.pagination_complete, true)
    assert.equal(proof.details_verified, 2)
    assert.equal(proof.reports_verified, 2)
    assert.equal(proof.revoked_session_rejected, true)
  }, 26)
})

for (const [defect, message] of [
  ['duplicate_row', /repeated a row/], ['missing_row', /page is incomplete/],
  ['changed_count', /count changed/], ['external_next', /pagination link differs/],
]) {
  test(`browser rejects ${defect} during pagination and cleans up`, { timeout: 120000 }, async () => {
    await fixture(defect, async (input) => { await assert.rejects(checkBrowserLogin(input), message) }, 26)
  })
}

for (const defect of ['revoked_core', 'revoked_list', 'revoked_detail', 'revoked_budget', 'revoked_report']) {
  test(`browser rejects ${defect} even when anonymous reads return 401`, { timeout: 120000 }, async () => {
    await fixture(defect, async (input) => { await assert.rejects(checkBrowserLogin(input), /Revoked session remained usable/) })
  })
}

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

// A child process forwards each RPC to the live disposable HTTP fixtures above.
// It replaces Docker only; Vite, browser, cookies and HTTP responses remain real.
const relayProgram = String.raw`
const readline = require('node:readline')
const reader = readline.createInterface({input: process.stdin})
let settings, publicOrigin
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
;(async () => {
  for await (const line of reader) {
    const value = JSON.parse(line)
    if (!settings) {
      settings = JSON.parse(value)
      send({phase: 'progress', step: 'CORE_LOGIN'})
      send({phase: 'browser_ready', email: settings.email})
    } else if (value.phase === 'browser_done') {
      send({phase: 'complete', result: {status: 'PASS', test_origin: publicOrigin}})
      process.exitCode = settings.failExit ? 1 : 0
      break
    } else {
      if (value.origin) publicOrigin = value.origin
      const reply = await fetch(settings.origin + value.path, {
        method: value.method, redirect: 'manual',
        headers: {'Content-Type': 'application/json', ...(value.cookie ? {Cookie: value.cookie} : {}), ...(value.origin ? {Origin: settings.origin} : {})},
        ...(value.payload === null ? {} : {body: JSON.stringify(value.payload)}),
      })
      const headers = Object.fromEntries(['content-type', 'cache-control', 'content-security-policy'].filter(key => reply.headers.has(key)).map(key => [key, reply.headers.get(key)]))
      if (reply.headers.getSetCookie().length) headers['set-cookie'] = reply.headers.getSetCookie()
      send({phase: 'browser_response', status: reply.status, headers, body: Buffer.from(await reply.arrayBuffer()).toString('base64')})
    }
  }
  reader.close()
  process.stdin.destroy()
})().catch(() => { process.exitCode = 1; reader.close(); process.stdin.destroy() })
`

for (const failExit of [false, true]) {
  test(`restored browser relay verifies real HTTP and rejects helper exit failure: ${failExit}`, { timeout: 120000 }, async () => {
    await fixture(null, async (input) => {
      const caches = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('govbiz-restored-live-')).sort()
      const before = await caches()
      const envBefore = ['K8S_CORE_PORT', 'K8S_OPS_PORT', 'K8S_DEV_LOGIN'].map((key) => process.env[key])
      const child = spawn(process.execPath, ['-e', relayProgram], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      const options = { ...input, program: JSON.stringify({ origin: input.origin, email, failExit }) }
      if (failExit) await assert.rejects(runLiveRestore(options, child, 0), { restoreStage: 'EXIT' })
      else {
        const phases = []
        const result = await runLiveRestore(options, child, 0, (value) => phases.push(value))
        assert.ok(phases.includes('HELPER_CORE_LOGIN'))
        assert.ok(phases.includes('BROWSER_PASSWORD_LOGIN'))
        assert.ok(phases.includes('BROWSER_REVOKED_SESSION'))
        const proof = result.browser_login
        await assert.rejects(fetch(result.test_origin, { signal: AbortSignal.timeout(1000) }))
        assert.equal(proof.response_source, 'restored_core_ops_http')
        assert.equal(proof.transport, 'docker_attached_stdio')
        assert.equal(proof.revoked_session_rejected, true)
        assert.equal(proof.proxy_stopped, true)
        assert.equal(proof.helper_exited, true)
        assert.ok(!JSON.stringify(proof).includes(password) && !JSON.stringify(proof).includes(email))
      }
      assert.ok(child.exitCode !== null || child.signalCode !== null)
      assert.deepEqual(await caches(), before)
      assert.deepEqual(['K8S_CORE_PORT', 'K8S_OPS_PORT', 'K8S_DEV_LOGIN'].map((key) => process.env[key]), envBefore)
    })
  })
}

test('restored browser rejects malformed helper output and closes its process', { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, ['-e', "process.stdin.once('data',()=>{process.stdout.write('not-json\\n');process.stdin.destroy()})"], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  await assert.rejects(runLiveRestore({ program: 'fixture', password, expected }, child, 0), { restoreStage: 'HELPER' })
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})

for (const helperStage of ['MANAGEMENT', 'private-untrusted-value']) {
  test(`restored browser accepts only fixed helper diagnostics: ${helperStage}`, { timeout: 20000 }, async () => {
    const code = `process.stdin.once('data',()=>{process.stdout.write(JSON.stringify({phase:'progress',step:${JSON.stringify(helperStage)}})+'\\n');process.stdin.destroy()})`
    const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    await assert.rejects(runLiveRestore({ program: 'fixture', password, expected }, child, 0), {
      restoreStage: helperStage === 'MANAGEMENT' ? 'HELPER_MANAGEMENT' : 'HELPER',
    })
  })
}

test('malformed helper frames cannot be hidden by a queued ready frame', { timeout: 20000 }, async () => {
  // Deliver both frames before write's callback, so read() sees the queued data.
  const child = new EventEmitter()
  child.exitCode = child.signalCode = null
  child.stdout = new PassThrough()
  child.stdin = new Writable({ write(_chunk, _encoding, done) {
    child.stdout.write('not-json\n' + JSON.stringify({ phase: 'browser_ready', email }) + '\n')
    done()
  } })
  child.kill = () => {
    child.signalCode = 'SIGTERM'
    child.stdout.end()
    child.emit('close', null, 'SIGTERM')
  }
  await assert.rejects(runLiveRestore({ program: 'fixture', password, expected }, child, 0), { restoreStage: 'HELPER' })
  assert.equal(child.signalCode, 'SIGTERM')
})

test('restored browser uses the Python request validator over attached stdio', { timeout: 120000 }, async () => {
  await fixture(null, async (input) => {
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = reservation.address().port
    await new Promise((done) => reservation.close(done))
    const source = await readFile(new URL('./ops_http_restore_probe.py', import.meta.url), 'utf8')
    const routes = ['/api/v1/ops/session', '/api/v1/ops/evaluations?page=1', '/api/v1/ops/budget/reservations?page=1', '/api/v1/ops/schedules?page=1',
      ...Object.keys(input.expected).flatMap((key) => ['', '/budget', '/report'].map((suffix) => `/api/v1/ops/evaluations/${key}${suffix}`))]
    const program = source + '\n' + [
      `BROWSER_ORIGIN = ${JSON.stringify('http://127.0.0.1:' + port)}`,
      '_http_response = response',
      'def response(path, **options):',
      `    options['port'] = ${new URL(input.origin).port}`,
      `    options['headers']['Host'] = ${JSON.stringify(new URL(input.origin).host)}`,
      `    if 'Origin' in options['headers']: options['headers']['Origin'] = ${JSON.stringify(input.origin)}`,
      '    return _http_response(path, **options)',
      `browser_requests({'email': ${JSON.stringify(email)}}, set(${JSON.stringify(routes)}))`,
      "print(json.dumps({'phase':'complete','result':{'status':'PASS'}}), flush=True)",
    ].join('\n')
    const python = fileURLToPath(new URL(process.platform === 'win32' ? '../../../backend/ops-service/.venv/Scripts/python.exe' : '../../../backend/ops-service/.venv/bin/python', import.meta.url))
    const child = spawn(python, ['-B', '-u', '-c', 'import sys,json; exec(json.loads(sys.stdin.readline()))'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const result = await runLiveRestore({ ...input, program }, child, port)
    assert.equal(result.browser_login.revoked_session_rejected, true)
    assert.equal(result.browser_login.helper_exited, true)
  })
})

test('restored browser CLI redacts malformed input', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ops_restore_live_browser.mjs', import.meta.url))], {
    input: JSON.stringify({ identity: 'invalid', password }), encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'BRIDGE_RESTORE_LIVE_INPUT\n')
})

test('isolated Docker attach carries real Python HTTP and browser sessions', {
  timeout: 120000, skip: !process.env.RESTORE_DOCKER_IMAGE,
}, async () => {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((done) => reservation.close(done))
  const source = await readFile(new URL('./ops_http_restore_probe.py', import.meta.url), 'utf8')
  const path = `/api/v1/ops/evaluations/${id}`
  const settings = { origin: 'http://127.0.0.1:' + port, email, password, report: body, routes: {
    '/api/v1/ops/session': { user: { id: 'core:1', username: email }, csrf_token: 'fixture-csrf', live_enabled: false, rag_live_enabled: false, datasets: [dataset] },
    '/api/v1/ops/evaluations?page=1': { count: 1, next: null, previous: null, results: [run] },
    '/api/v1/ops/schedules?page=1': { enabled: false, timezone: 'Asia/Seoul', page: 1, total: 0, results: [] },
    '/api/v1/ops/budget/reservations?page=1': { as_of: at, count: 0, next: null, previous: null, results: [],
      summary: { state: 'unconfigured', limits: null, allocated: null, remaining: null, breakdown: null, reservation_count: 0, legacy_live_run_count: 0, change_count: 0, recent_changes: [] } },
    [path]: run, [path + '/budget']: { as_of: at, state: 'not_applicable', reservation: null, calls: [] },
  } }
  const program = source + '\nsettings=json.loads(' + JSON.stringify(JSON.stringify(settings)) + ')\n' + String.raw`
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
BROWSER_ORIGIN = settings['origin']
token = secrets.token_hex(32)
active = False
report_path = next(key for key in settings['routes'] if key.endswith('/budget'))[:-7] + '/report'
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def send(self, code, value, headers=None):
        raw = value.encode() if isinstance(value, str) else json.dumps(value).encode()
        self.send_response(code)
        for key, item in {'Content-Type':'application/json', 'Cache-Control':'private, no-store', **(headers or {})}.items(): self.send_header(key, item)
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def do_GET(self):
        authorized = active and ('govbiz_session=' + token) in self.headers.get('Cookie', '')
        if self.path == '/api/v1/ops/session' and not authorized:
            self.send(200, {**settings['routes'][self.path], 'user':None, 'datasets':[]}); return
        if not authorized: self.send(401, {}); return
        if self.path == '/api/v1/admin/session':
            self.send(200, {'accountId':1, 'email':settings['email'], 'role':'ADMIN'})
        elif self.path == report_path:
            self.send(200, settings['report'], {'Content-Type':'text/html', 'Content-Security-Policy':"sandbox allow-scripts; default-src 'none'"})
        else: self.send(200 if self.path in settings['routes'] else 404, settings['routes'].get(self.path, {}))
    def do_POST(self):
        global active
        if self.headers.get('Origin') != BROWSER_ORIGIN: self.send(403, {}); return
        if self.path == '/api/v1/auth/login':
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if payload != {'email':settings['email'], 'password':settings['password'], 'rememberMe':False}: self.send(401, {}); return
            active = True
            self.send(200, {'expiresAt':'2027-01-01T00:00:00Z', 'account':{'email':settings['email'], 'role':'ADMIN', 'tier':'MEMBER', 'emailVerified':True, 'onboarded':True, 'company':None}}, {'Set-Cookie':'govbiz_session=' + token + '; HttpOnly; SameSite=Lax; Path=/'})
        elif self.path == '/api/v1/auth/logout':
            active = False
            self.send(204, '', {'Set-Cookie':'govbiz_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/'})
        else: self.send(404, {})
servers = [ThreadingHTTPServer(('127.0.0.1', port), Handler) for port in (8080, 8000)]
threads = [Thread(target=server.serve_forever) for server in servers]
for thread in threads: thread.start()
try:
    browser_requests({'email':settings['email']}, set(settings['routes']) | {report_path})
finally:
    for server in servers: server.shutdown(); server.server_close()
    for thread in threads: thread.join()
print(json.dumps({'phase':'complete','result':{'status':'PASS'}}), flush=True)
`
  const created = spawnSync('docker', ['create', '--interactive', '--network', 'none', '--read-only', '--user', '10001:10001',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '128m', '--pids-limit', '32',
    '--entrypoint', 'python', process.env.RESTORE_DOCKER_IMAGE, '-B', '-u', '-c', 'import sys,json; exec(json.loads(sys.stdin.readline()))'],
  { encoding: 'utf8', timeout: 30000, windowsHide: true })
  assert.equal(created.status, 0, 'Disposable Docker helper creation failed')
  const identity = created.stdout.trim()
  assert.match(identity, /^[a-f0-9]{64}$/)
  try {
    const child = spawn('docker', ['start', '--attach', '--interactive', identity], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const result = await runLiveRestore({ program, password, expected }, child, port)
    assert.equal(result.browser_login.revoked_session_rejected, true)
    assert.equal(result.browser_login.helper_exited, true)
  } finally {
    const removed = spawnSync('docker', ['rm', '--force', '--volumes', identity], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.equal(removed.status, 0, 'Disposable Docker helper cleanup failed')
  }
})
