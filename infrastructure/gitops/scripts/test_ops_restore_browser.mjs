import assert from 'node:assert/strict'
import test from 'node:test'
import { withRestoreProxy } from './ops_restore_proxy.mjs'
import { checkRestoreBrowser } from './ops_restore_browser.mjs'

const at = '2026-10-03T00:00:00Z'
const dataset = {
  id: 'browser-fixture', label: '격리 브라우저 검증', case_ids: ['E01'],
  captures: [{ id: 'saved', label: '저장 응답' }], baseline: null, fixture: 'fixture.json',
  live_config: null, execution_profiles: { replay: 'a'.repeat(64), live: null },
}
const runs = Array.from({ length: 26 }, (_, index) => ({
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  dataset_id: dataset.id, dataset_label: dataset.label, requested_by: 'fixture@example.invalid', requested_by_id: 'core:1',
  can_retry: false, candidate_capture_id: 'saved', reference_capture_id: 'saved',
  candidate_label: '저장 응답', reference_label: '저장 응답', comparison: null,
  execution_mode: 'replay', live_config: null, status: 'COMPLETED', status_label: '완료',
  created_at: at, started_at: null, finished_at: at, synced_at: at,
  error_code: '', error_message: '', summary: {}, model_api_calls: 0, evaluation_run_id: null,
  trace_links: [], prefect_flow_run_id: null, prefect_url: null, langfuse_url: null, report_url: null,
}))
const responses = {
  '/api/v1/ops/session': {
    user: { id: 'core:1', username: 'fixture@example.invalid' }, csrf_token: 'redacted',
    live_enabled: false, rag_live_enabled: false, datasets: [dataset],
  },
  '/api/v1/ops/evaluations?page=1': { count: 26, next: 'http://127.0.0.1:8000/api/v1/ops/evaluations?page=2', previous: null, results: runs.slice(0, 25) },
  '/api/v1/ops/evaluations?page=2': { count: 26, next: null, previous: 'http://127.0.0.1:8000/api/v1/ops/evaluations?page=1', results: runs.slice(25) },
  '/api/v1/ops/budget/reservations?page=1': {
    as_of: at, count: 0, next: null, previous: null, results: [],
    summary: { state: 'unconfigured', limits: null, allocated: null, remaining: null, breakdown: null,
      reservation_count: 0, legacy_live_run_count: 0, change_count: 0, recent_changes: [] },
  },
}

test('real browser renders both list pages and budget, then hides rows for a member', { timeout: 120000 }, async (context) => {
  const result = await withRestoreProxy(responses, async (origin) => ({ browser_ui: await checkRestoreBrowser(origin, responses) }))
  assert.equal(result.browser_ui.listed_run_count, 26)
  assert.equal(result.browser_ui.pages_verified, 2)
  assert.equal(result.browser_ui.budget_view_verified, true)
  assert.equal(result.browser_ui.denied_view_verified, true)
  assert.equal(result.browser_ui.browser_rendered, true)
  assert.equal(result.browser_ui.browser_closed, true)
  assert.equal(result.proxy_http.servers_stopped, true)
  assert.match(result.browser_ui.browser_version, /^[0-9]+(?:\.[0-9]+){3}$/)
  context.diagnostic('Browser version: ' + result.browser_ui.browser_version)
})

test('browser inspection rejects a non-owned origin before launching', async () => {
  await assert.rejects(checkRestoreBrowser('https://external.invalid', responses))
  await assert.rejects(checkRestoreBrowser('http://localhost:5173', responses))
})
