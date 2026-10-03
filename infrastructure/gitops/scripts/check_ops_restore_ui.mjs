// Validate captured real HTTP responses with the web's production parsers.
// This checks the consumer contract, not browser rendering or network proxying.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { getOpsSession, listEvaluations, getEvaluation, getBudgetReservations, getRunBudget } from '../../../frontend/web/src/data/ops/opsApi.ts'

const { responses, expected, total_runs: totalRuns } = JSON.parse(await readFile(process.argv[2], 'utf8'))
const read = new Set()
globalThis.fetch = async (path, options = {}) => {
  assert.ok(!options.method || options.method === 'GET', 'Restore web contract must only read')
  assert.ok(Object.hasOwn(responses, path), 'Missing captured management response')
  read.add(path)
  return new Response(JSON.stringify(responses[path]), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
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
assert.equal(read.size, Object.keys(responses).length, 'Some captured responses were never parsed')
process.stdout.write(JSON.stringify({ status: 'PASS', matched_details: Object.keys(expected).length, listed_run_count: totalRuns, browser_rendered: false }))
