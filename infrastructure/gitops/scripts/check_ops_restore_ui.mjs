// Validate captured real HTTP responses with the web's production parsers.
// Real Vite proxies isolated replay servers; this does not render a browser.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { getOpsSession, listEvaluations, getEvaluation, getBudgetReservations, getRunBudget } from '../../../frontend/web/src/data/ops/opsApi.ts'

import { withRestoreProxy } from './ops_restore_proxy.mjs'

const { responses, expected, total_runs: totalRuns } = JSON.parse(await readFile(process.argv[2], 'utf8'))
const proof = await withRestoreProxy(responses, async () => {
  const session = await getOpsSession()
  assert.ok(session.user)
  assert.equal(session.live_enabled, false)
  assert.equal(session.rag_live_enabled, false)
  const runs = new Map()
  for (let page = 1; page <= Math.ceil(totalRuns / 25); page++) {
    const value = await listEvaluations(page)
    assert.equal(value.count, totalRuns)
    for (const run of value.results) {
      assert.ok(!runs.has(run.id), 'Repeated evaluation in parsed listing')
      assert.ok(session.datasets.some((dataset) => dataset.id === run.dataset_id), 'Listing contains an unregistered dataset')
      runs.set(run.id, run)
    }
  }
  assert.equal(runs.size, totalRuns)
  assert.equal((await getBudgetReservations(1)).summary.state, 'consistent')
  for (const [id, expectation] of Object.entries(expected)) {
    const detail = await getEvaluation(id)
    assert.equal(detail.id, id)
    assert.equal(detail.status, 'COMPLETED')
    assert.equal(detail.prefect_flow_run_id, expectation.flow_id)
    assert.equal(detail.execution_spec_sha256, expectation.execution_spec_sha256)
    assert.equal(detail.report_url, `/api/v1/ops/evaluations/${id}/report`)
    assert.equal(detail.model_api_calls, 0)
    assert.deepEqual({ ...detail, postprocessing: null }, { ...runs.get(id), postprocessing: null })
    assert.equal((await getRunBudget(id)).state, 'not_applicable')
  }
  return { status: 'PASS', matched_details: Object.keys(expected).length, listed_run_count: totalRuns, browser_rendered: false }
})
process.stdout.write(JSON.stringify(proof))
