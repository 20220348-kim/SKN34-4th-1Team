import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default defineConfig((env) => mergeConfig(viteConfig(env), {
  test: {
    setupFiles: ['./src/test/setupChatHistory.ts', './src/test/setupPreparationJobs.ts', './src/test/setupSupportProgramAttachments.ts', './src/test/setupPlanUsage.ts'],
    // Vitest는 CSS를 기본으로 비웁니다. 생성 토큰 파일이 최신인지, 도우미 위치 규칙이 있는지 확인하는 테스트가
    // `?raw`로 원문을 읽도록 이 두 파일만 엽니다.
    css: { include: [/design-tokens\.css/, /src[\\/]index\.css/] },
  },
}))
