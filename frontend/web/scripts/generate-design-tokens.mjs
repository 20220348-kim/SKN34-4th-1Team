// shared 디자인 토큰으로 Tailwind `@theme` 색 변수 파일(src/design-tokens.css)을 다시 만듭니다.
// 실행: pnpm --filter govbiz-web tokens  (Node 24가 .ts를 그대로 읽습니다)
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { designTokensCss } from '../src/design/designTokensCss.ts'

const target = fileURLToPath(new URL('../src/design-tokens.css', import.meta.url))
writeFileSync(target, designTokensCss())
console.log(`design tokens written: ${target}`)
