import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { loadEnv } from 'vite'
import config from './vite.config'

vi.mock('vite', async (original) => ({
  ...await original<typeof import('vite')>(),
  loadEnv: vi.fn(() => ({})),
}))

beforeEach(() => {
  vi.stubEnv('K8S_CORE_PORT', undefined)
  vi.stubEnv('K8S_OPS_PORT', undefined)
  vi.stubEnv('K8S_DEV_LOGIN', undefined)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('Kubernetes portfolio mode', () => {
  it('enables the AI UI only in explicit connected mode without exposing env files', () => {
    vi.stubEnv('VITE_PRIVATE_KEY', 'must-never-appear')
    vi.stubEnv('OPENAI_API_KEY', 'must-never-appear')
    const result = config({ mode: 'connected', command: 'serve' })
    expect(loadEnv).not.toHaveBeenCalled()
    expect(result.envDir).toBe(false)
    expect(result.envPrefix).toEqual([])
    expect(result.define['import.meta.env.VITE_ASSISTANT_AI_ENABLED']).toBe('"true"')
    expect(JSON.stringify(result)).not.toContain('must-never-appear')
    expect(result.server.host).toBe('127.0.0.1')
    expect(result.server.proxy['/api'].target).toBe('http://127.0.0.1:18080')
    expect(result.server.proxy['/api/v1/ops'].target).toBe('http://127.0.0.1:18001')
  })

  it('ignores env files and inherited VITE values, uses only the loopback API', () => {
    vi.stubEnv('VITE_DEV_PROXY_TARGET', 'https://must-not-be-used.invalid')
    vi.stubEnv('VITE_CORE_API_BASE_URL', 'https://must-not-be-used.invalid')
    vi.stubEnv('VITE_ASSISTANT_AI_ENABLED', 'true')
    vi.stubEnv('VITE_DEV_LOGIN_ENABLED', 'true')
    const result = config({ mode: 'portfolio', command: 'serve' })

    expect(loadEnv).not.toHaveBeenCalled()
    expect(result.envDir).toBe(false)
    expect(result.envPrefix).toEqual([])
    expect(result.define).toEqual({
      'import.meta.env.VITE_CORE_API_BASE_URL': '"/"',
      'import.meta.env.VITE_ASSISTANT_AI_ENABLED': '"false"',
      'import.meta.env.VITE_KAKAO_CHANNEL_ID': '""',
      'import.meta.env.VITE_DEV_LOGIN_ENABLED': '"false"',
    })
    expect(result.server.host).toBe('127.0.0.1')
    expect(result.server.port).toBe(5173)
    expect(result.server.strictPort).toBe(true)
    expect(result.server.proxy['/api'].target).toBe('http://127.0.0.1:18080')
  })

  it.each(['portfolio', 'connected'])('uses only explicit loopback ports in %s mode', (mode) => {
    vi.stubEnv('K8S_CORE_PORT', '28080')
    vi.stubEnv('K8S_OPS_PORT', '28001')
    vi.stubEnv('VITE_DEV_PROXY_TARGET', 'https://must-not-be-used.invalid')
    vi.stubEnv('OPS_DEV_PROXY_TARGET', 'https://must-not-be-used.invalid')
    const result = config({ mode, command: 'serve' })
    expect(loadEnv).not.toHaveBeenCalled()
    expect(result.envDir).toBe(false)
    expect(result.envPrefix).toEqual([])
    expect(result.server.proxy['/api'].target).toBe('http://127.0.0.1:28080')
    expect(result.server.proxy['/api/v1/ops']).toEqual({ target: 'http://127.0.0.1:28001', changeOrigin: false })
    expect(result.server.host).toBe('127.0.0.1')
    expect(result.server.strictPort).toBe(true)
    expect(JSON.stringify(result.define)).not.toContain('K8S_')
    expect(JSON.stringify(result)).not.toContain('must-not-be-used')
  })

  it.each(['K8S_CORE_PORT', 'K8S_OPS_PORT'])('rejects invalid %s without reading env files', (name) => {
    for (const value of ['', '0', '1023', '65536', '-1', '28001.5', '2e4', ' 28001 ', '28001/path', 'http://evil.invalid']) {
      vi.stubEnv(name, value)
      expect(() => config({ mode: 'portfolio', command: 'serve' })).toThrow(name)
    }
    expect(loadEnv).not.toHaveBeenCalled()
  })

  it('rejects ports shared between Core and Ops including the other default', () => {
    vi.stubEnv('K8S_OPS_PORT', '18080')
    expect(() => config({ mode: 'portfolio', command: 'serve' })).toThrow('must be different')
    vi.stubEnv('K8S_CORE_PORT', '28001')
    vi.stubEnv('K8S_OPS_PORT', '28001')
    expect(() => config({ mode: 'connected', command: 'serve' })).toThrow('must be different')
  })

  it('allows unprivileged port boundaries without exposing arbitrary hosts', () => {
    vi.stubEnv('K8S_CORE_PORT', '1024')
    vi.stubEnv('K8S_OPS_PORT', '65535')
    const result = config({ mode: 'portfolio', command: 'serve' })
    expect(result.server.proxy['/api'].target).toBe('http://127.0.0.1:1024')
    expect(result.server.proxy['/api/v1/ops'].target).toBe('http://127.0.0.1:65535')
  })

  it.each(['portfolio', 'connected'])('allows explicit development login only for serving %s', (mode) => {
    vi.stubEnv('K8S_DEV_LOGIN', 'true')
    const result = config({ mode, command: 'serve' })
    expect(result.define['import.meta.env.VITE_DEV_LOGIN_ENABLED']).toBe('"true"')
    expect(result.server.host).toBe('127.0.0.1')
    expect(loadEnv).not.toHaveBeenCalled()
    expect(config({ mode, command: 'build' }).define['import.meta.env.VITE_DEV_LOGIN_ENABLED']).toBe('"false"')
    vi.stubEnv('K8S_DEV_LOGIN', 'false')
    expect(config({ mode, command: 'serve' }).define['import.meta.env.VITE_DEV_LOGIN_ENABLED']).toBe('"false"')
  })

  it.each(['', '1', 'TRUE', ' true '])('rejects ambiguous development login setting %j', (value) => {
    vi.stubEnv('K8S_DEV_LOGIN', value)
    expect(() => config({ mode: 'portfolio', command: 'serve' })).toThrow('K8S_DEV_LOGIN')
    expect(loadEnv).not.toHaveBeenCalled()
  })

  it('preserves normal development and Compose configuration', () => {
    vi.stubEnv('K8S_CORE_PORT', 'invalid-but-irrelevant')
    vi.stubEnv('K8S_DEV_LOGIN', 'invalid-but-irrelevant')
    vi.stubEnv('K8S_OPS_PORT', 'invalid-but-irrelevant')
    vi.mocked(loadEnv).mockReturnValueOnce({
      VITE_DEV_PROXY_TARGET: 'http://core-service:8080',
      OPS_DEV_PROXY_TARGET: 'http://ops-service:8000',
      CHOKIDAR_USEPOLLING: 'true',
    })
    const result = config({ mode: 'development', command: 'serve' })
    expect(loadEnv).toHaveBeenCalledWith('development', process.cwd(), '')
    expect(result.envDir).toBeUndefined()
    expect(result.envPrefix).toBeUndefined()
    expect(result.define).toBeUndefined()
    expect(result.server.host).toBe('0.0.0.0')
    expect(result.server.proxy['/api'].target).toBe('http://core-service:8080')
    expect(Object.keys(result.server.proxy)).toEqual(['/api/v1/ops', '/api'])
    expect(result.server.proxy['/api/v1/ops']).toEqual({ target: 'http://ops-service:8000', changeOrigin: false })
    expect(result.server.watch?.usePolling).toBe(true)
  })
})
