import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadEnv } from 'vite'
import config from './vite.config'

vi.mock('vite', async (original) => ({
  ...await original<typeof import('vite')>(),
  loadEnv: vi.fn(() => ({})),
}))

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('Kubernetes portfolio mode', () => {
  it('ignores env files and inherited VITE values, uses only the loopback API', () => {
    vi.stubEnv('VITE_DEV_PROXY_TARGET', 'https://must-not-be-used.invalid')
    vi.stubEnv('VITE_CORE_API_BASE_URL', 'https://must-not-be-used.invalid')
    vi.stubEnv('VITE_ASSISTANT_AI_ENABLED', 'true')
    const result = config({ mode: 'portfolio', command: 'serve' })

    expect(loadEnv).not.toHaveBeenCalled()
    expect(result.envDir).toBe(false)
    expect(result.envPrefix).toEqual([])
    expect(result.define).toEqual({
      'import.meta.env.VITE_CORE_API_BASE_URL': '"/"',
      'import.meta.env.VITE_ASSISTANT_AI_ENABLED': '"false"',
      'import.meta.env.VITE_KAKAO_CHANNEL_ID': '""',
    })
    expect(result.server.host).toBe('127.0.0.1')
    expect(result.server.port).toBe(5173)
    expect(result.server.strictPort).toBe(true)
    expect(result.server.proxy['/api'].target).toBe('http://127.0.0.1:18080')
  })

  it('preserves normal development and Compose configuration', () => {
    vi.mocked(loadEnv).mockReturnValueOnce({
      VITE_DEV_PROXY_TARGET: 'http://core-service:8080',
      CHOKIDAR_USEPOLLING: 'true',
    })
    const result = config({ mode: 'development', command: 'serve' })
    expect(loadEnv).toHaveBeenCalledWith('development', process.cwd(), '')
    expect(result.envDir).toBeUndefined()
    expect(result.envPrefix).toBeUndefined()
    expect(result.define).toBeUndefined()
    expect(result.server.host).toBe('0.0.0.0')
    expect(result.server.proxy['/api'].target).toBe('http://core-service:8080')
    expect(result.server.watch?.usePolling).toBe(true)
  })
})
