// Real restored Core/Ops HTTP over the isolated helper's attached stdio; no response replay.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from '../../../frontend/web/node_modules/vite/dist/node/index.js'
import { checkBrowserLogin } from './ops_browser_login.mjs'

const root = fileURLToPath(new URL('../../../frontend/web/', import.meta.url))
const bounded = async (promise, milliseconds) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Restored browser transport timed out')), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

export async function runLiveRestore({ program, password, expected }, child, port = 5173) {
  let buffer = '', failure, receiver, origin, vite, cache, proof, result
  const frames = [], servers = [], failures = []
  const originalEnv = Object.fromEntries(['K8S_CORE_PORT', 'K8S_OPS_PORT', 'K8S_DEV_LOGIN'].map((key) => [key, process.env[key]]))
  const fail = () => {
    failure = new Error('Restored browser helper transport failed')
    receiver?.reject(failure)
    receiver = undefined
  }
  const exited = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })))
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.stdout.on('error', fail)
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 40 * 1024 * 1024) { fail(); return }
    let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try {
        const value = JSON.parse(line)
        if (receiver) { receiver.resolve(value); receiver = undefined }
        else if (frames.length < 2) frames.push(value)
        else fail()
      } catch { fail() }
    }
  }).on('end', fail)
  const read = (timeout = 20000) => bounded(new Promise((resolveFrame, reject) => {
    if (frames.length) resolveFrame(frames.shift())
    else if (failure) reject(failure)
    else receiver = { resolve: resolveFrame, reject }
  }), timeout)
  const write = (value) => new Promise((done, reject) => child.stdin.write(JSON.stringify(value) + '\n', (error) => error ? reject(new Error('Restored browser helper input failed')) : done()))
  let sequence = Promise.resolve()
  const exchange = (value, timeout) => {
    const next = sequence.then(async () => { await write(value); return read(timeout) })
    sequence = next
    void sequence.catch(() => {})
    return next
  }
  try {
    await write(program)
    const ready = await read(150000)
    assert.equal(ready.phase, 'browser_ready')
    assert.ok(typeof ready.email === 'string' && ready.email.includes('@'))
    for (const target of [8080, 8000]) {
      const server = createServer(async (request, reply) => {
        try {
          const path = request.url, method = request.method
          const writeRoute = method === 'POST' && ['/api/v1/auth/login', '/api/v1/auth/logout'].includes(path)
          assert.ok(target === 8080 ? method === 'GET' && path === '/api/v1/admin/session' || writeRoute
            : method === 'GET' && /^\/api\/v1\/ops\/[a-z0-9/?=_-]+$/.test(path))
          assert.ok(request.headers.origin === undefined || request.headers.origin === origin)
          if (writeRoute) assert.equal(request.headers.origin, origin)
          const chunks = []
          let length = 0
          for await (const chunk of request) { length += chunk.length; assert.ok(length <= 16384); chunks.push(chunk) }
          const raw = Buffer.concat(chunks).toString('utf8')
          const value = await exchange({ port: target, path, method, cookie: request.headers.cookie ?? '', origin: request.headers.origin ?? null, payload: raw ? JSON.parse(raw) : null })
          assert.equal(value.phase, 'browser_response')
          assert.ok(Number.isInteger(value.status) && value.status >= 200 && value.status <= 599)
          assert.ok(typeof value.body === 'string' && value.body.length <= 12 * 1024 * 1024)
          assert.ok(value.headers && Object.keys(value.headers).every((key) => ['content-type', 'cache-control', 'content-security-policy', 'set-cookie'].includes(key)))
          const bytes = Buffer.from(value.body, 'base64')
          assert.equal(bytes.toString('base64'), value.body, 'Invalid restored HTTP body encoding')
          reply.writeHead(value.status, value.headers).end(bytes)
        } catch {
          failures.push('Restored HTTP relay failed')
          if (!reply.headersSent) reply.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          reply.end('{}')
        }
      })
      servers.push(server)
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
    }
    process.env.K8S_CORE_PORT = String(servers[0].address().port)
    process.env.K8S_OPS_PORT = String(servers[1].address().port)
    process.env.K8S_DEV_LOGIN = 'false'
    cache = await mkdtemp(resolve(tmpdir(), 'govbiz-restored-live-'))
    vite = await createViteServer({ root, configFile: resolve(root, 'vite.config.ts'), configLoader: 'native', mode: 'portfolio',
      logLevel: 'silent', cacheDir: cache, server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null, preTransformRequests: false } })
    await vite.listen()
    const optimizer = vite.environments.client.depsOptimizer
    await optimizer?.scanProcessing
    await Promise.all(Object.values(optimizer?.metadata.discovered ?? {}).map((item) => item.processing))
    origin = 'http://127.0.0.1:' + vite.httpServer.address().port
    proof = await checkBrowserLogin({ origin, email: ready.email, password, expected })
    assert.deepEqual(failures, [])
    const completed = await exchange({ phase: 'browser_done' }, 90000)
    assert.equal(completed.phase, 'complete')
    result = completed.result
    child.stdin.end()
    assert.deepEqual(await bounded(exited, 20000), { code: 0, signal: null }, 'Restored HTTP helper did not exit cleanly')
  } finally {
    try {
      const stopped = await Promise.allSettled([vite?.close(), ...servers.map(async (server) => {
        if (!server.listening) return
        const closed = new Promise((done, reject) => server.close((error) => error ? reject(error) : done()))
        server.closeAllConnections()
        await closed
      })])
      if (cache) {
        assert.ok(cache.startsWith(resolve(tmpdir()) + sep + 'govbiz-restored-live-'))
        await rm(cache, { recursive: true, force: true })
      }
      assert.ok(stopped.every((item) => item.status === 'fulfilled'), 'Restored browser proxy cleanup failed')
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.destroy()
        child.kill()
        await bounded(exited, 10000)
      }
    }
  }
  return { ...result, browser_login: { ...proof, response_source: 'restored_core_ops_http', transport: 'docker_attached_stdio', proxy_stopped: true, helper_exited: true } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = ''
    for await (const chunk of process.stdin) { input += chunk; assert.ok(Buffer.byteLength(input) <= 1024 * 1024) }
    const value = JSON.parse(input)
    assert.match(value.identity, /^[a-f0-9]{64}$/)
    assert.ok(typeof value.program === 'string' && value.program.length < 512 * 1024)
    const child = spawn('docker', ['start', '--attach', '--interactive', value.identity], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    process.stdout.write(JSON.stringify(await runLiveRestore(value, child)))
  } catch {
    process.stderr.write('BRIDGE_RESTORE_LIVE_BROWSER_FAILED\n')
    process.exitCode = 1
  }
}
