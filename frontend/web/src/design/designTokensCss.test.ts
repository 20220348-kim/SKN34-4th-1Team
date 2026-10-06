import { colors } from '@govbiz/shared/design/tokens'
import { describe, expect, it } from 'vitest'

import checkedIn from '../design-tokens.css?raw'
import { designTokensCss } from './designTokensCss'

describe('design-tokens.css', () => {
  it('shared 토큰으로 다시 만든 내용과 같다(다르면 `pnpm --filter govbiz-web tokens`로 다시 만든다)', () => {
    // Windows 체크아웃은 줄바꿈이 CRLF일 수 있어 LF로 맞춰 비교합니다.
    expect(checkedIn.replace(/\r\n/g, '\n'), 'design-tokens.css가 shared 토큰과 다릅니다. `pnpm --filter govbiz-web tokens`로 다시 만드세요.')
      .toBe(designTokensCss())
  })

  it('기존 의미 이름 그대로 Tailwind 색 변수를 만든다', () => {
    const css = designTokensCss()
    expect(css).toContain(`--color-brand-primary: ${colors.brandPrimary};`)
    expect(css).toContain(`--color-surface-muted: ${colors.surfaceMuted};`)
    expect(css).toContain(`--color-ink-muted: ${colors.inkMuted};`)
    expect(css).toContain(`--color-info-line: ${colors.infoLine};`)
    expect(css.match(/--color-/g)).toHaveLength(Object.keys(colors).length)
  })
})
