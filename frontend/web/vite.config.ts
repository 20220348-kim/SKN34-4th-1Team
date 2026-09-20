import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Docker Compose에서는 브라우저가 /api를 Vite 개발 서버로 보내고,
// Vite가 Compose 내부 DNS 이름(core-service)으로 프록시한다.
// 네이티브 개발의 기본 대상은 기존 localhost:8080을 유지한다.
export default defineConfig(({ mode }) => {
  // Mac Kubernetes 검증은 개발/운영 .env와 상속된 VITE_*를 사용하지 않는다.
  // API는 loopback port-forward만 사용하며 유료 도우미·외부 문의 링크도 끈다.
  const portfolio = mode === 'portfolio'
  const env = portfolio ? {} : loadEnv(mode, process.cwd(), '')
  const usePolling = env.CHOKIDAR_USEPOLLING === 'true'
  // Docker Desktop(Windows/macOS)의 바인드 마운트는 파일 알림이 오지 않아 폴링이 필요하다.
  // 폴링은 파일마다 stat을 도는 비용이라 간격이 짧으면 Node 이벤트 루프가 막혀 /api 프록시까지 초 단위로 느려진다.
  // 기본 1초, 필요하면 CHOKIDAR_INTERVAL(ms)로 조절한다. 산출물·캐시 폴더는 감시에서 뺀다.
  const pollingInterval = Number.parseInt(env.CHOKIDAR_INTERVAL ?? '', 10) || 1_000

  return {
    plugins: [react(), tailwindcss()],
    envDir: portfolio ? false : undefined,
    envPrefix: portfolio ? [] : undefined,
    define: portfolio ? {
      'import.meta.env.VITE_CORE_API_BASE_URL': JSON.stringify('/'),
      'import.meta.env.VITE_ASSISTANT_AI_ENABLED': JSON.stringify('false'),
      'import.meta.env.VITE_KAKAO_CHANNEL_ID': JSON.stringify(''),
    } : undefined,
    server: {
      host: portfolio ? '127.0.0.1' : '0.0.0.0',
      port: 5173,
      strictPort: true,
      watch: usePolling
        ? { usePolling: true, interval: pollingInterval, ignored: ['**/node_modules/**', '**/.pnpm-store/**', '**/dist/**', '**/coverage/**', '**/.git/**'] }
        : undefined,
      proxy: {
        '/api': {
          target: portfolio ? 'http://127.0.0.1:18080' : env.VITE_DEV_PROXY_TARGET || 'http://localhost:8080',
          changeOrigin: true,
        },
      },
    },
  }
})
