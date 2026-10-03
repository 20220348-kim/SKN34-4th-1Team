import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { getOpsSession, listEvaluations } from '../../../frontend/web/src/data/ops/opsApi.ts'
import { withRestoreProxy } from './ops_restore_proxy.mjs'

const session = { user: { id: 'core:1', username: 'fixture@example.invalid' }, csrf_token: 'redacted', live_enabled: false, datasets: [] }
const responses = () => ({ '/api/v1/ops/session': structuredClone(session) })
const caches = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('govbiz-restore-proxy-')).sort()

test('actual Vite proxies queries, cookies, Origin and denials, then closes every listener', async () => {
  const nativeFetch = globalThis.fetch
  const before = await caches()
  const original = process.env.K8S_CORE_PORT
  process.env.K8S_CORE_PORT = 'invalid-existing-value'
  const urls = new Set()
  globalThis.fetch = (url, options) => {
    urls.add(new URL(url).origin)
    return nativeFetch(url, options)
  }
  const savedFetch = globalThis.fetch
  try {
    const data = { ...responses(), '/api/v1/ops/evaluations?page=2': { count: 0, next: null, previous: null, results: [] } }
    const proof = await withRestoreProxy(data, async () => {
      urls.add('http://127.0.0.1:' + process.env.K8S_CORE_PORT)
      urls.add('http://127.0.0.1:' + process.env.K8S_OPS_PORT)
      assert.deepEqual((await getOpsSession()).user, session.user)
      assert.equal((await listEvaluations(2)).count, 0)
      return { parsed: true }
    })
    assert.equal(proof.parsed, true)
    assert.equal(proof.proxy_http.response_source, 'captured_restore_http')
    assert.equal(proof.proxy_http.outage_rejected, true)
    assert.equal(proof.proxy_http.servers_stopped, true)
    assert.equal(proof.proxy_http.browser_rendered, false)
    assert.equal(urls.size, 3)
    for (const url of urls) await assert.rejects(nativeFetch(url, { signal: AbortSignal.timeout(1000) }))
    assert.equal(globalThis.fetch, savedFetch)
    assert.equal(process.env.K8S_CORE_PORT, 'invalid-existing-value')
    assert.deepEqual(await caches(), before)
  } finally {
    globalThis.fetch = nativeFetch
    if (original === undefined) delete process.env.K8S_CORE_PORT
    else process.env.K8S_CORE_PORT = original
  }
})

test('parser failure still restores fetch, environment, cache and listeners', async () => {
  const original = globalThis.fetch
  const ports = [process.env.K8S_CORE_PORT, process.env.K8S_OPS_PORT]
  const before = await caches()
  const urls = []
  await assert.rejects(withRestoreProxy({ '/api/v1/ops/session': { user: 'invalid' } }, async () => {
    urls.push('http://127.0.0.1:' + process.env.K8S_CORE_PORT, 'http://127.0.0.1:' + process.env.K8S_OPS_PORT)
    await getOpsSession()
  }))
  assert.equal(globalThis.fetch, original)
  assert.deepEqual([process.env.K8S_CORE_PORT, process.env.K8S_OPS_PORT], ports)
  assert.deepEqual(await caches(), before)
  for (const url of urls) await assert.rejects(original(url, { signal: AbortSignal.timeout(1000) }))
})

test('unconsumed snapshots cannot produce success', async () => {
  await assert.rejects(withRestoreProxy(responses(), async () => ({})), /never proxied/)
})

test('unrecorded routes and mutations never reach a backend', async () => {
  await withRestoreProxy(responses(), async () => {
    await assert.rejects(globalThis.fetch('https://external.invalid/'), /Missing captured/)
    await assert.rejects(globalThis.fetch('/api/v1/ops/session', { method: 'POST' }), /only read/)
    await assert.rejects(globalThis.fetch('/api/v1/ops/session', { credentials: 'omit' }), /same-origin/)
    await getOpsSession()
    return {}
  })
})
