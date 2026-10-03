// Render the real application against captured Ops responses, in a new browser context.
import assert from 'node:assert/strict'
import { chromium } from '../../../frontend/web/node_modules/playwright-core/index.mjs'

export async function checkRestoreBrowser(origin, responses) {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
  const channel = process.env.RESTORE_BROWSER_CHANNEL
  assert.ok(channel === undefined || ['chrome', 'msedge'].includes(channel), 'Use bundled Chromium or an installed Chrome/Edge channel')
  const session = responses['/api/v1/ops/session']
  const count = responses['/api/v1/ops/evaluations?page=1'].count
  assert.ok(Number.isInteger(count) && count > 0 && count <= 1000)
  assert.ok(typeof session.user?.username === 'string' && session.user.username)
  const pages = Math.ceil(count / 25)
  const seen = new Set()
  const failures = []
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) })
  const version = browser.version()
  try {
    const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' })
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
    page.on('pageerror', () => failures.push('Application JavaScript failed'))
    await page.goto(origin + '/ops/evaluations', { waitUntil: 'domcontentloaded' })
    await page.getByRole('navigation', { name: '운영 메뉴' }).getByText(session.user.username, { exact: true }).waitFor()
    const history = page.getByRole('region', { name: '평가 실행 이력' })
    for (let number = 1; number <= pages; number++) {
      const rows = responses[`/api/v1/ops/evaluations?page=${number}`].results
      for (const row of rows) {
        await history.locator(`a[href="/ops/evaluations/${row.id}"]`).waitFor()
        assert.ok(!seen.has(row.id), 'Browser listing repeated an evaluation')
        seen.add(row.id)
      }
      assert.equal(await history.locator('tbody tr').count(), rows.length)
      if (number < pages) await history.getByRole('button', { name: '다음', exact: true }).click()
    }
    assert.equal(seen.size, count)
    await page.locator('#evaluation-budget').getByText('조회 시각:', { exact: false }).waitFor()
    assert.equal(await page.getByRole('alert').count(), 0, 'Management view contains an error')
    assert.equal(await history.getByRole('button', { name: '다음', exact: true }).isDisabled(), true)
    assert.equal(await page.title(), 'GovBiz · LLMOps 운영')
    assert.equal((await context.cookies(origin)).find((item) => item.name === 'govbiz_session')?.httpOnly, true)
    // Reuse only this isolated context with a fixture member cookie. This checks
    // the UI response to HTTP 403, not real Core login or role verification.
    await context.clearCookies()
    await context.addCookies([{ name: 'govbiz_session', value: 'member-fixture', url: origin, httpOnly: true, sameSite: 'Lax' }])
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('alert').getByText('관리자 계정만 운영 화면을 이용할 수 있습니다.', { exact: false }).waitFor()
    await page.getByRole('button', { name: '연결 다시 확인' }).waitFor()
    assert.equal(await page.getByRole('region', { name: '평가 실행 이력' }).count(), 0)
    assert.deepEqual(failures, [])
  } finally {
    await browser.close()
  }
  assert.equal(browser.isConnected(), false)
  return {
    status: 'PASS', response_source: 'captured_restore_http', browser_version: version,
    listed_run_count: count, pages_verified: pages, budget_view_verified: true,
    denied_view_verified: true, browser_rendered: true, browser_closed: true,
  }
}
