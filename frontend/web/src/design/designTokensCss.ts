import { colors } from '@govbiz/shared/design/tokens'

/** camelCase 토큰 이름을 Tailwind 변수 이름(kebab-case)으로 바꿉니다. brandPrimary → brand-primary */
function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

/**
 * shared 디자인 토큰으로 `src/design-tokens.css`의 내용을 만듭니다. 색마다 `--color-*` 변수 하나라
 * `bg-brand-primary`, `text-ink-muted`처럼 같은 이름의 Tailwind 색 클래스가 생깁니다.
 * 파일은 `pnpm --filter govbiz-web tokens`로 다시 쓰고, `designTokensCss.test.ts`가 파일이 최신인지 확인합니다.
 */
export function designTokensCss(): string {
  const lines = Object.entries(colors).map(([name, value]) => `  --color-${kebabCase(name)}: ${value};`)
  return [
    '/*',
    ' * 생성 파일입니다. 직접 고치지 말고 frontend/packages/shared/src/design/tokens.ts를 고친 뒤',
    ' * `pnpm --filter govbiz-web tokens`로 다시 만드세요.',
    ' */',
    '@theme {',
    ...lines,
    '}',
    '',
  ].join('\n')
}
