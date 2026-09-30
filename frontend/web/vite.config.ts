import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Docker Compose에서는 브라우저가 /api를 Vite 개발 서버로 보내고,
// Vite가 Compose 내부 DNS 이름(core-service)으로 프록시한다.
// 네이티브 개발의 기본 대상은 기존 localhost:8080을 유지한다.
function kubernetesPort(name: 'K8S_CORE_PORT' | 'K8S_OPS_PORT', fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^[0-9]{4,5}$/.test(raw) || Number(raw) < 1024 || Number(raw) > 65535) {
    throw new Error(name + ' must be an integer between 1024 and 65535')
  }
  return Number(raw)
}

export default defineConfig(({ mode, command }) => {
  // Kubernetes 모드는 개발/운영 .env와 상속된 VITE_*를 사용하지 않는다.
  // API는 loopback port-forward만 사용하며 portfolio는 유료 도우미도 끈다.
  const portfolio = mode === 'portfolio'
  // 명시적인 외부 연동 모드도 .env의 서버 비밀값과 임의 VITE 변수를 읽지 않는다.
  const connected = mode === 'connected'
  const kubernetes = portfolio || connected
  const devLogin = kubernetes ? process.env.K8S_DEV_LOGIN ?? 'false' : 'false'
  if (!['true', 'false'].includes(devLogin)) {
    throw new Error('K8S_DEV_LOGIN must be true or false')
  }
  const corePort = kubernetes ? kubernetesPort('K8S_CORE_PORT', 18080) : 18080
  const opsPort = kubernetes ? kubernetesPort('K8S_OPS_PORT', 18001) : 18001
  if (kubernetes && corePort === opsPort) {
    throw new Error('K8S_CORE_PORT and K8S_OPS_PORT must be different')
  }
  const env = kubernetes ? {} : loadEnv(mode, process.cwd(), '')
  const usePolling = env.CHOKIDAR_USEPOLLING === 'true'
  // Docker Desktop(Windows/macOS)의 바인드 마운트는 파일 알림이 오지 않아 폴링이 필요하다.
  // 폴링은 파일마다 stat을 도는 비용이라 간격이 짧으면 Node 이벤트 루프가 막혀 /api 프록시까지 초 단위로 느려진다.
  // 기본 1초, 필요하면 CHOKIDAR_INTERVAL(ms)로 조절한다. 산출물·캐시 폴더는 감시에서 뺀다.
  const pollingInterval = Number.parseInt(env.CHOKIDAR_INTERVAL ?? '', 10) || 1_000

  return {
    plugins: [react(), tailwindcss()],
    envDir: kubernetes ? false : undefined,
    envPrefix: kubernetes ? [] : undefined,
    define: kubernetes ? {
      'import.meta.env.VITE_CORE_API_BASE_URL': JSON.stringify('/'),
      'import.meta.env.VITE_ASSISTANT_AI_ENABLED': JSON.stringify(connected ? 'true' : 'false'),
      'import.meta.env.VITE_KAKAO_CHANNEL_ID': JSON.stringify(''),
      'import.meta.env.VITE_DEV_LOGIN_ENABLED': JSON.stringify(command === 'serve' && devLogin === 'true' ? 'true' : 'false'),
    } : undefined,
    server: {
      host: kubernetes ? '127.0.0.1' : '0.0.0.0',
      port: 5173,
      strictPort: true,
      watch: usePolling
        ? { usePolling: true, interval: pollingInterval, ignored: ['**/node_modules/**', '**/.pnpm-store/**', '**/dist/**', '**/coverage/**', '**/.git/**'] }
        : undefined,
      proxy: {
        '/api/v1/ops': {
          target: kubernetes ? 'http://127.0.0.1:' + opsPort : env.OPS_DEV_PROXY_TARGET || 'http://127.0.0.1:18001',
          // 브라우저의 Host와 Origin을 함께 보존하여 Django가 CSRF를 검증한다.
          changeOrigin: false,
        },
        '/api': {
          target: kubernetes ? 'http://127.0.0.1:' + corePort : env.VITE_DEV_PROXY_TARGET || 'http://localhost:8080',
          changeOrigin: true,
        },
      },
    },
  }
})
