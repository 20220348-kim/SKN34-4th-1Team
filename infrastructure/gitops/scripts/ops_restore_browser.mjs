// Render the real application against captured Ops responses, in a new browser context.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium } from '../../../frontend/web/node_modules/playwright-core/index.mjs'
import { checkRagMaterial } from './ops_restore_rag_browser.mjs'

export async function checkRestoreBrowser(origin, responses, expected, reports, onStage = () => {}) {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
  const channel = process.env.RESTORE_BROWSER_CHANNEL
  assert.ok(channel === undefined || ['chrome', 'msedge'].includes(channel), 'Use bundled Chromium or an installed Chrome/Edge channel')
  const session = responses['/api/v1/ops/session']
  const count = responses['/api/v1/ops/evaluations?page=1'].count
  assert.ok(Number.isInteger(count) && count > 0 && count <= 1000)
  assert.ok(typeof session.user?.username === 'string' && session.user.username)
  const pages = Math.ceil(count / 25)
  const seen = new Set()
  const locations = new Map()
  const ids = Object.keys(expected)
  assert.ok(ids.length > 0 && ids.length <= count)
  assert.deepEqual(Object.keys(reports).sort(), ids.map((id) => `/api/v1/ops/evaluations/${id}/report`).sort())
  for (const id of ids) {
    assert.match(id, /^[a-f0-9-]{36}$/)
    const route = `/api/v1/ops/evaluations/${id}`
    assert.equal(responses[route]?.report_url, route + '/report')
    assert.equal(createHash('sha256').update(reports[route + '/report'].body).digest('hex'), expected[id].report_sha256, 'Captured report hash differs')
  }
  const failures = []
  onStage('LAUNCH')
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) })
  const version = browser.version()
  try {
    const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(30000)
    context.on('page', (tab) => tab.on('pageerror', () => failures.push('Application or report JavaScript failed')))
    // Playwright 1.63's built-in block script reads navigator.serviceWorker,
    // which throws in an opaque-origin CSP sandbox. Block registration without
    // reading that getter; keep all real page errors fatal.
    await context.addInitScript(() => {
      if ('ServiceWorkerContainer' in globalThis) Object.defineProperty(ServiceWorkerContainer.prototype, 'register', {
        configurable: false, writable: false,
        value: () => Promise.reject(new Error('Service workers are disabled during restore verification')),
      })
    })
    context.on('serviceworker', () => failures.push('A service worker started during restore verification'))
    // The browser may only read this owned Vite server. Never contact real APIs,
    // external links, paid evaluation endpoints or another local listener.
    await context.route('**/*', async (route) => {
      const request = route.request()
      if (new URL(request.url()).origin !== origin || request.method() !== 'GET') {
        failures.push('Browser attempted an external request or a write')
        await route.abort()
      } else await route.continue()
    })
    await context.addCookies([{ name: 'govbiz_session', value: 'restore-proxy-fixture', url: origin, httpOnly: true, sameSite: 'Lax' }])
    const page = await context.newPage()
    page.setDefaultTimeout(30000)
    await page.goto(origin + '/ops/evaluations', { waitUntil: 'domcontentloaded' })
    await page.getByRole('navigation', { name: '운영 메뉴' }).getByText(session.user.username, { exact: true }).waitFor()
    const history = page.getByRole('region', { name: '평가 실행 이력' })
    onStage('LIST')
    for (let number = 1; number <= pages; number++) {
      const rows = responses[`/api/v1/ops/evaluations?page=${number}`].results
      for (const row of rows) {
        await history.locator(`a[href="/ops/evaluations/${row.id}"]`).waitFor()
        assert.ok(!seen.has(row.id), 'Browser listing repeated an evaluation')
        seen.add(row.id)
        locations.set(row.id, number)
      }
      assert.equal(await history.locator('tbody tr').count(), rows.length)
      if (number < pages) await history.getByRole('button', { name: '다음', exact: true }).click()
    }
    assert.equal(seen.size, count)
    onStage('BUDGET')
    await page.locator('#evaluation-budget').getByText('조회 시각:', { exact: false }).waitFor()
    assert.equal(await page.getByRole('alert').count(), 0, 'Management view contains an error')
    assert.equal(await history.getByRole('button', { name: '다음', exact: true }).isDisabled(), true)
    assert.equal(await page.title(), 'GovBiz · LLMOps 운영')
    assert.equal((await context.cookies(origin)).find((item) => item.name === 'govbiz_session')?.httpOnly, true)
    for (const id of ids) {
      onStage('DETAIL')
      assert.ok(locations.has(id), 'Expected detail is missing from the browser listing')
      await page.goto(origin + '/ops/evaluations', { waitUntil: 'domcontentloaded' })
      for (let number = 1; number < locations.get(id); number++) {
        const row = responses[`/api/v1/ops/evaluations?page=${number}`].results[0]
        await history.locator(`a[href="/ops/evaluations/${row.id}"]`).waitFor()
        await history.getByRole('button', { name: '다음', exact: true }).click()
      }
      await history.locator(`a[href="/ops/evaluations/${id}"]`).click()
      await page.getByRole('heading', { name: '평가 실행 상세', exact: true }).waitFor()
      await page.locator('dd').getByText(id, { exact: true }).waitFor()
      await page.locator('dd').getByText(expected[id].execution_spec_sha256, { exact: true }).waitFor()
      await page.getByRole('region', { name: '실행 예산 장부' }).getByText('새 모델 호출을 예약하는 실행이 아닙니다.', { exact: false }).waitFor()
      const route = `/api/v1/ops/evaluations/${id}`
      if (responses[route].evaluation_scope === 'fixed-answer-context-only') {
        await page.getByRole('region', { name: '응답 검토와 기준 지정' }).getByRole('region', { name: '검토 진행 안내' }).waitFor()
      }
      if (responses[route].evaluation_scope === 'source-chunks-retrieval-answer') {
        onStage('RAG_MATERIAL')
        await checkRagMaterial(page, responses[route])
      }
      assert.equal(await page.getByRole('alert').count(), 0, 'Detail view contains an error')
      const link = page.getByRole('link', { name: 'Evidently 보고서', exact: true })
      onStage('REPORT')
      assert.equal(await link.getAttribute('href'), route + '/report')
      assert.equal(await link.getAttribute('target'), '_blank')
      assert.deepEqual((await link.getAttribute('rel')).split(' ').sort(), ['noopener', 'noreferrer'])
      // Register both events before clicking; the new tab may respond immediately.
      const [report, reply] = await Promise.all([
        context.waitForEvent('page'),
        context.waitForEvent('response', { predicate: (reply) => reply.url() === origin + route + '/report' }),
        link.click(),
      ])
      try {
        assert.equal(reply.status(), 200)
        for (const [name, value] of Object.entries(reports[route + '/report'].headers)) assert.equal(await reply.headerValue(name), value)
        assert.equal(createHash('sha256').update(await reply.body()).digest('hex'), expected[id].report_sha256, 'Browser received different report bytes')
        await report.waitForLoadState('load')
        assert.equal(report.url(), origin + route + '/report')
        await report.waitForFunction(() => Boolean(document.body?.innerText.trim()), null, { timeout: 30000 })
        const isolation = await report.evaluate(() => {
          const blocked = (read) => { try { read(); return false } catch (error) { return error.name === 'SecurityError' } }
          return { opener: window.opener === null, cookie: blocked(() => document.cookie), storage: blocked(() => localStorage.length) }
        })
        assert.deepEqual(isolation, { opener: true, cookie: true, storage: true }, 'Report sandbox did not isolate the document')
        assert.deepEqual(failures, [])
      } finally {
        await report.close()
      }
    }
    // Reuse only this isolated context with a fixture member cookie. This checks
    // the UI response to HTTP 403, not real Core login or role verification.
    onStage('MEMBER')
    await context.clearCookies()
    await context.addCookies([{ name: 'govbiz_session', value: 'member-fixture', url: origin, httpOnly: true, sameSite: 'Lax' }])
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('alert').getByText('관리자 계정만 운영 화면을 이용할 수 있습니다.', { exact: false }).waitFor()
    await page.getByRole('button', { name: '연결 다시 확인' }).waitFor()
    assert.equal(await page.getByRole('region', { name: '평가 실행 이력' }).count(), 0)
    assert.equal(await page.getByRole('link', { name: 'Evidently 보고서', exact: true }).count(), 0)
    for (const id of ids) {
      const denied = await page.evaluate(async (route) => {
        const reply = await fetch(route, { credentials: 'same-origin' })
        return { status: reply.status, cache: reply.headers.get('cache-control'), body: await reply.text() }
      }, `/api/v1/ops/evaluations/${id}/report`)
      assert.deepEqual(denied, { status: 403, cache: 'private, no-store', body: '{}' })
    }
    assert.deepEqual(failures, [])
  } finally {
    await browser.close()
  }
  assert.equal(browser.isConnected(), false)
  return {
    status: 'PASS', response_source: 'captured_restore_http', browser_version: version,
    listed_run_count: count, pages_verified: pages, budget_view_verified: true,
    details_verified: ids.length, report_documents_verified: ids.length,
    report_sandbox_verified: true, report_denials_verified: ids.length,
    denied_view_verified: true, browser_rendered: true, browser_closed: true,
  }
}
