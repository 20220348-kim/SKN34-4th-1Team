// Validate captured real HTTP responses with the web's production parsers.
// Real Vite and an isolated browser consume captured restore responses.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { getOpsSession, listEvaluations, getEvaluation, getBudgetReservations, getRunBudget, getEvaluationReview, getEvaluationSchedules, getRagReviews, getRagMaterial } from '../../../frontend/web/src/data/ops/opsApi.ts'

import { withRestoreProxy } from './ops_restore_proxy.mjs'
import { checkRestoreBrowser } from './ops_restore_browser.mjs'

let stage = 'INPUT'
try {
  const { responses, reports, expected, total_runs: totalRuns } = JSON.parse(await readFile(process.argv[2], 'utf8'))
  stage = 'PROXY'
  const proof = await withRestoreProxy(responses, async (origin) => {
    stage = 'SESSION'
    const session = await getOpsSession()
    assert.ok(session.user)
    assert.equal(session.live_enabled, false)
    assert.equal(session.rag_live_enabled, false)
    stage = 'SCHEDULES'
    assert.equal((await getEvaluationSchedules()).enabled, false)
    const runs = new Map()
    stage = 'LIST'
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
    stage = 'BUDGET'
    assert.equal((await getBudgetReservations(1)).summary.state, 'consistent')
    for (const [id, expectation] of Object.entries(expected)) {
      stage = 'DETAIL'
      const detail = await getEvaluation(id)
      assert.equal(detail.id, id)
      assert.equal(detail.status, 'COMPLETED')
      assert.equal(detail.prefect_flow_run_id, expectation.flow_id)
      assert.equal(detail.execution_spec_sha256, expectation.execution_spec_sha256)
      assert.equal(detail.report_url, `/api/v1/ops/evaluations/${id}/report`)
      assert.equal(detail.model_api_calls, 0)
      assert.deepEqual({ ...detail, postprocessing: null }, { ...runs.get(id), postprocessing: null })
      stage = 'RUN_BUDGET'
      assert.equal((await getRunBudget(id)).state, 'not_applicable')
      stage = 'REVIEW'
      if (detail.evaluation_scope === 'fixed-answer-context-only') await getEvaluationReview(id)
      if (detail.evaluation_scope === 'source-chunks-retrieval-answer') {
        const review = await getRagReviews(id)
        assert.deepEqual(await getRagMaterial(id), review.material)
      }
    }
    stage = 'BROWSER_INPUT'
    const browser = await checkRestoreBrowser(origin, responses, expected, reports, (value) => { stage = 'BROWSER_' + value })
    stage = 'PROXY_CLEANUP'
    return { status: 'PASS', matched_details: Object.keys(expected).length, listed_run_count: totalRuns, browser_rendered: true, browser_ui: browser }
  }, reports)
  process.stdout.write(JSON.stringify(proof))
} catch {
  // Only a fixed phase enters CI evidence; never print captured JSON/HTML or cookies.
  process.stderr.write('BRIDGE_RESTORE_WEB_' + stage + '\n')
  process.exitCode = 1
}
