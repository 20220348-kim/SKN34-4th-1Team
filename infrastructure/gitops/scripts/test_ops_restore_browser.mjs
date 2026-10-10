import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { withRestoreProxy } from './ops_restore_proxy.mjs'
import { checkRestoreBrowser } from './ops_restore_browser.mjs'
import { ragFixture } from './ops_restore_rag_fixture.mjs'

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
  '/api/v1/ops/schedules?page=1': { enabled: false, timezone: 'Asia/Seoul', page: 1, total: 0, results: [] },
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
const reports = {}, expected = {}
for (const index of [0, 24, 25]) {
  const row = runs[index]
  const path = `/api/v1/ops/evaluations/${row.id}`
  row.report_url = path + '/report'
  row.execution_spec_sha256 = String(index).padStart(64, 'a')
  row.evaluation_scope = index === 25 ? 'source-chunks-retrieval-answer' : 'fixed-answer-context-only'
  if (index === 25) {
    const rag = ragFixture()
    row.execution_spec = rag.spec
    responses[path + '/rag-reviews'] = rag.state
  }
  responses[path] = { ...row }
  responses[path + '/budget'] = { as_of: at, state: 'not_applicable', reservation: null, calls: [] }
  if (index !== 25) responses[path + '/review'] = {
    is_baseline: false, material_error: '', baseline_version: 0, review_version: 0,
    can_approve: false, approval_current: false, baseline_requires_review: false,
    rubric: { version: 'fixture', criteria: [] }, case_reviews: [], baseline_history: [], reviews: [], material: null,
  }
  const body = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>복원 검증 보고서</title></head><body><script>document.body.appendChild(Object.assign(document.createElement('h1'), {textContent: '복원 보고서 ${index}'}))</script></body></html>`
  reports[path + '/report'] = { body, headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store, max-age=0, no-cache, must-revalidate',
    'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'",
  } }
  expected[row.id] = { report_sha256: createHash('sha256').update(body).digest('hex'), execution_spec_sha256: row.execution_spec_sha256 }
}

test('real browser opens budget, schedules, lists and report explanations before sandboxed originals, then denies a member', { timeout: 120000 }, async (context) => {
  const stages = []
  const result = await withRestoreProxy(responses, async (origin) => ({ browser_ui: await checkRestoreBrowser(origin, responses, expected, reports, (stage) => stages.push(stage)) }), reports)
  assert.deepEqual(stages, ['LAUNCH', 'LIST', 'BUDGET', 'SCHEDULES', 'DETAIL', 'REPORT', 'DETAIL', 'REPORT', 'DETAIL', 'RAG_MATERIAL', 'REPORT', 'MEMBER'])
  assert.equal(result.browser_ui.listed_run_count, 26)
  assert.equal(result.browser_ui.pages_verified, 2)
  assert.equal(result.browser_ui.budget_view_verified, true)
  assert.equal(result.browser_ui.denied_view_verified, true)
  assert.equal(result.browser_ui.browser_rendered, true)
  assert.equal(result.browser_ui.browser_closed, true)
  assert.equal(result.browser_ui.details_verified, 3)
  assert.equal(result.browser_ui.report_documents_verified, 3)
  assert.equal(result.browser_ui.report_sandbox_verified, true)
  assert.equal(result.browser_ui.report_denials_verified, 3)
  assert.equal(result.proxy_http.report_documents_verified, 3)
  assert.equal(result.proxy_http.servers_stopped, true)
  assert.match(result.browser_ui.browser_version, /^[0-9]+(?:\.[0-9]+){3}$/)
  context.diagnostic('Browser version: ' + result.browser_ui.browser_version)
})

test('tampered report bytes or missing reports cannot launch the browser', async () => {
  const bad = structuredClone(reports)
  Object.values(bad)[0].body += 'tampered'
  await assert.rejects(checkRestoreBrowser('http://127.0.0.1:1', responses, expected, bad), /hash differs/)
  await assert.rejects(checkRestoreBrowser('http://127.0.0.1:1', responses, expected, {}))
})

test('unsafe or cacheable report headers cannot start the replay proxy', async () => {
  for (const [header, value] of [
    ['content-security-policy', "sandbox allow-scripts allow-same-origin; default-src 'none'"],
    ['cache-control', 'public, max-age=3600'], ['content-type', 'application/json'], ['set-cookie', 'unexpected=1'],
  ]) {
    const bad = structuredClone(reports)
    Object.values(bad)[0].headers[header] = value
    await assert.rejects(withRestoreProxy(responses, async () => assert.fail('Unsafe replay started'), bad))
  }
})

test('report script errors fail verification and still remove owned listeners and cache', { timeout: 120000 }, async () => {
  const broken = structuredClone(reports), hashes = structuredClone(expected)
  const id = Object.keys(hashes)[0], path = `/api/v1/ops/evaluations/${id}/report`
  broken[path].body = broken[path].body.replace('</script>', ";throw new Error('synthetic report failure')</script>")
  hashes[id].report_sha256 = createHash('sha256').update(broken[path].body).digest('hex')
  const nativeFetch = globalThis.fetch
  const caches = async () => (await readdir(tmpdir())).filter((name) => name.startsWith(`govbiz-restore-proxy-${process.pid}-`)).sort()
  const before = await caches()
  let origin
  await assert.rejects(withRestoreProxy(responses, async (owned) => {
    origin = owned
    return checkRestoreBrowser(origin, responses, hashes, broken)
  }, broken), /Application or report JavaScript failed/)
  assert.equal(globalThis.fetch, nativeFetch)
  assert.deepEqual(await caches(), before)
  await assert.rejects(nativeFetch(origin, { signal: AbortSignal.timeout(1000) }))
})

test('browser inspection rejects a non-owned origin before launching', async () => {
  await assert.rejects(checkRestoreBrowser('https://external.invalid', responses))
  await assert.rejects(checkRestoreBrowser('http://localhost:5173', responses))
})

test('locked Evidently standalone report renders under the real report sandbox', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'govbiz-evidently-browser-'))
  try {
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const python = resolve(root, 'backend/ai-service/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const reportPath = resolve(directory, 'report.html')
    const generated = spawnSync(python, ['-c', [
      'import sys', 'import pandas as pd', 'from evidently import Report', 'from evidently.metrics import RowCount',
      'Report([RowCount()], include_tests=False).run(current_data=pd.DataFrame({"value":[1,2]})).save_html(sys.argv[1])',
    ].join('\n'), reportPath], { env: { ...process.env, DO_NOT_TRACK: '1' }, encoding: 'utf8', timeout: 60000, windowsHide: true })
    assert.equal(generated.status, 0, 'Locked evaluation Python must generate an offline report')
    const id = Object.keys(expected)[0], path = `/api/v1/ops/evaluations/${id}`
    const body = await readFile(reportPath, 'utf8')
    const report = { [path + '/report']: { ...reports[path + '/report'], body } }
    const hashes = { [id]: { ...expected[id], report_sha256: createHash('sha256').update(body).digest('hex') } }
    const snapshot = Object.fromEntries(Object.entries(responses).filter(([key]) => !key.startsWith('/api/v1/ops/evaluations/') || key.startsWith(path)))
    await withRestoreProxy(snapshot, (origin) => checkRestoreBrowser(origin, snapshot, hashes, report), report)
  } finally {
    assert.ok(directory.startsWith(resolve(tmpdir()) + sep + 'govbiz-evidently-browser-'))
    await rm(directory, { recursive: true, force: true })
  }
})

test('restore contract CLI records only a fixed failure phase', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'govbiz-restore-diagnostic-'))
  try {
    const input = resolve(directory, 'responses.json')
    await writeFile(input, 'private-fixture-not-json')
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-transform-types', fileURLToPath(new URL('./check_ops_restore_ui.mjs', import.meta.url)), input], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'BRIDGE_RESTORE_WEB_INPUT\n')
  } finally {
    assert.ok(directory.startsWith(resolve(tmpdir()) + sep + 'govbiz-restore-diagnostic-'))
    await rm(directory, { recursive: true, force: true })
  }
})
