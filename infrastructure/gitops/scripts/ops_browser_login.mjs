// Browser login against the caller's owned Core/Ops Vite server. No response replay.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../../../frontend/web/node_modules/playwright-core/index.mjs'

export async function checkBrowserLogin({ origin, email, password, expected }) {
  assert.ok(typeof origin === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):[0-9]{4,5}$/.test(origin), 'Use an owned loopback Vite server')
  assert.ok(Number(new URL(origin).port) >= 1024 && Number(new URL(origin).port) <= 65535)
  assert.ok(typeof email === 'string' && email.length <= 254 && email.includes('@'), 'Missing test login identity')
  assert.ok(typeof password === 'string' && password.length > 0 && password.length <= 4096, 'Missing test login password')
  const ids = Object.keys(expected)
  assert.ok(ids.length > 0 && ids.length <= 10)
  for (const id of ids) {
    assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
    for (const key of ['execution_spec_sha256', 'report_sha256']) assert.match(expected[id][key], /^[a-f0-9]{64}$/)
  }
  const channel = process.env.RESTORE_BROWSER_CHANNEL
  assert.ok(channel === undefined || ['chrome', 'msedge'].includes(channel))
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) })
  const version = browser.version()
  let context
  const failures = []
  const writes = []
  try {
    context = await browser.newContext({ locale: 'ko-KR', serviceWorkers: 'block' })
    context.setDefaultTimeout(30000)
    context.on('page', (page) => page.on('pageerror', () => failures.push('Application JavaScript failed')))
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url())
      const login = request.method() === 'POST' && url.pathname === '/api/v1/auth/login'
      const logout = request.method() === 'POST' && url.pathname === '/api/v1/auth/logout'
      let valid = url.origin === origin && (request.method() === 'GET' || (!url.search && (login || logout)))
      if (login) {
        try {
          const body = request.postDataJSON()
          valid &&= body.email === email && body.password === password && body.rememberMe === false
        } catch { valid = false }
      }
      if (!valid) {
        failures.push('Browser attempted an external request or an unauthorized write')
        await route.abort()
      } else {
        if (request.method() !== 'GET') writes.push(url.pathname)
        await route.continue()
      }
    })
    assert.equal((await context.cookies()).length, 0)
    const page = await context.newPage()
    await page.goto(origin + '/ops/evaluations', { waitUntil: 'domcontentloaded' })
    const form = page.getByRole('form', { name: '로그인', exact: true })
    await form.waitFor()
    assert.equal(new URL(page.url()).searchParams.get('next'), '/ops/evaluations')
    await form.getByLabel('이메일', { exact: true }).fill(email)
    await form.getByLabel('비밀번호', { exact: true }).fill(password)
    const [login] = await Promise.all([
      page.waitForResponse((reply) => reply.url() === origin + '/api/v1/auth/login' && reply.request().method() === 'POST'),
      form.getByRole('button', { name: '이메일로 로그인', exact: true }).click(),
    ])
    assert.equal(login.status(), 200, 'Core password login failed')
    const account = (await login.json()).account
    assert.ok(account?.email === email && account.role === 'ADMIN', 'Core login identity differs')
    const cookie = (await context.cookies(origin)).find((item) => item.name === 'govbiz_session')
    assert.ok(cookie?.httpOnly && cookie.path === '/' && cookie.sameSite === 'Lax', 'Core session cookie is missing or unsafe')
    assert.ok((await login.headerValue('set-cookie'))?.includes('govbiz_session='), 'Login did not issue a session cookie')
    await page.getByRole('navigation', { name: '운영 메뉴' }).getByText(email, { exact: true }).waitFor()
    const read = (path) => page.evaluate(async (target) => {
      const reply = await fetch(target, { credentials: 'same-origin', cache: 'no-store' })
      return { status: reply.status, body: await reply.json() }
    }, path)
    const core = await read('/api/v1/admin/session')
    const ops = await read('/api/v1/ops/session')
    assert.ok(core.status === 200 && core.body.email === email && core.body.role === 'ADMIN' && Number.isInteger(core.body.accountId), 'Core admin session differs')
    assert.ok(ops.status === 200 && ops.body.user?.id === 'core:' + core.body.accountId && ops.body.user.username === email, 'Ops did not authenticate the Core principal')
    assert.ok(ops.body.live_enabled === false && ops.body.rag_live_enabled === false, 'Browser verification requires disabled paid evaluation')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('navigation', { name: '운영 메뉴' }).getByText(email, { exact: true }).waitFor()
    const history = page.getByRole('region', { name: '평가 실행 이력' })
    const listed = await read('/api/v1/ops/evaluations?page=1')
    assert.equal(listed.status, 200)
    // The disposable smoke creates only a small first page; never silently omit a requested run.
    for (const id of ids) assert.ok(listed.body.results.some((row) => row.id === id && row.status === 'COMPLETED' && row.execution_spec_sha256 === expected[id].execution_spec_sha256), 'Expected Kubernetes evaluation is absent')
    for (const id of ids) {
      await page.goto(origin + '/ops/evaluations', { waitUntil: 'domcontentloaded' })
      await history.locator(`a[href="/ops/evaluations/${id}"]`).click()
      await page.getByRole('heading', { name: '평가 실행 상세', exact: true }).waitFor()
      await page.locator('dd').getByText(id, { exact: true }).waitFor()
      await page.locator('dd').getByText(expected[id].execution_spec_sha256, { exact: true }).waitFor()
      await page.getByRole('region', { name: '실행 예산 장부' }).getByText('새 모델 호출을 예약하는 실행이 아닙니다.', { exact: false }).waitFor()
      const reportPath = `/api/v1/ops/evaluations/${id}/report`
      assert.equal(await page.getByRole('link', { name: 'Evidently 보고서', exact: true }).getAttribute('href'), reportPath)
      const report = await page.evaluate(async (path) => {
        const reply = await fetch(path, { credentials: 'same-origin', cache: 'no-store' })
        const bytes = await reply.arrayBuffer()
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('')
        return { status: reply.status, hash, csp: reply.headers.get('content-security-policy'), cache: reply.headers.get('cache-control') }
      }, reportPath)
      assert.ok(report.status === 200 && report.hash === expected[id].report_sha256, 'Actual Ops report bytes differ')
      assert.ok(report.csp?.includes('sandbox allow-scripts;') && report.cache?.includes('no-store'), 'Actual report security headers differ')
      assert.equal(await page.getByRole('alert').count(), 0, 'Management detail contains an error')
    }
    const [logout] = await Promise.all([
      page.waitForResponse((reply) => reply.url() === origin + '/api/v1/auth/logout' && reply.request().method() === 'POST'),
      page.getByRole('navigation', { name: '운영 메뉴' }).getByRole('button', { name: '로그아웃', exact: true }).click(),
    ])
    assert.equal(logout.status(), 204, 'Core logout failed')
    await form.waitFor()
    assert.ok(!(await context.cookies(origin)).some((item) => item.name === 'govbiz_session'), 'Core session cookie survived logout')
    for (const path of ['/api/v1/admin/session', '/api/v1/ops/evaluations?page=1', ...ids.map((id) => `/api/v1/ops/evaluations/${id}/report`)]) {
      assert.equal(await page.evaluate(async (target) => (await fetch(target, { credentials: 'same-origin', cache: 'no-store' })).status, path), 401, 'Protected read remained available after logout')
    }
    await page.goto(origin + '/ops/evaluations', { waitUntil: 'domcontentloaded' })
    await form.waitFor()
    assert.equal(await history.count(), 0)
    assert.deepEqual(writes, ['/api/v1/auth/login', '/api/v1/auth/logout'])
    assert.deepEqual(failures, [])
  } finally {
    try {
      // Also revoke the issued session after a failed UI check. No cookie injection.
      if (context && (await context.cookies(origin)).some((item) => item.name === 'govbiz_session')) {
        const reply = await context.request.post(origin + '/api/v1/auth/logout', { headers: { Origin: origin }, timeout: 10000 })
        assert.equal(reply.status(), 204, 'Failed to clean up the test login session')
      }
    } finally { await browser.close() }
  }
  assert.equal(browser.isConnected(), false)
  return {
    status: 'PASS', response_source: 'core_ops_http', browser_version: version,
    password_login_verified: true, httponly_cookie_received: true, core_ops_identity_verified: true,
    reload_verified: true, details_verified: ids.length, reports_verified: ids.length,
    logout_verified: true, unauthorized_after_logout: true, browser_closed: true,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const chunks = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += chunk.length
      assert.ok(size <= 65536, 'Browser login input exceeds limit')
      chunks.push(chunk)
    }
    process.stdout.write(JSON.stringify(await checkBrowserLogin(JSON.parse(Buffer.concat(chunks).toString('utf8')))))
  } catch {
    // Playwright diagnostics can contain form values; never publish them from CI.
    process.stderr.write('KUBERNETES_BROWSER_LOGIN_FAILED\n')
    process.exitCode = 1
  }
}
