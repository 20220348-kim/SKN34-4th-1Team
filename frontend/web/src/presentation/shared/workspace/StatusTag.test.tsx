// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { StatusTag } from './StatusTag'

afterEach(cleanup)

describe('StatusTag', () => {
  it.each([
    ['OPEN', '접수 중', 'text-brand-primary'],
    ['UPCOMING', '접수 예정', 'text-info'],
    ['CLOSED', '접수 마감', 'text-ink-muted'],
    ['UNKNOWN', '상태 확인 필요', 'text-warning'],
  ] as const)('%s는 shared 표시 문구 "%s"와 점을 함께 보여 준다', (status, label, tone) => {
    render(<StatusTag status={status} />)
    const tag = screen.getByText(label)
    expect(tag.className).toContain(tone)
    expect(tag.querySelector('[aria-hidden="true"]')).toBeTruthy()
  })

  it('접수 중이면 D-day를 붙이고 7일 이내(당일은 오늘 마감)는 빨강, 30일 이내는 노랑, 그 뒤는 초록으로 둔다', () => {
    const { rerender } = render(<StatusTag status="OPEN" daysLeft={0} />)
    expect(screen.getByText('오늘 마감').className).toContain('text-danger')
    rerender(<StatusTag status="OPEN" daysLeft={7} />)
    expect(screen.getByText('D-7').className).toContain('text-danger')
    rerender(<StatusTag status="OPEN" daysLeft={30} />)
    expect(screen.getByText('D-30').className).toContain('text-warning')
    rerender(<StatusTag status="OPEN" daysLeft={31} />)
    expect(screen.getByText('D-31').className).toContain('text-brand-primary')
  })

  it('마감일이 없거나 지났거나 접수 중이 아니면 D-day를 붙이지 않는다', () => {
    const { rerender, container } = render(<StatusTag status="OPEN" daysLeft={null} />)
    expect(container.textContent).toBe('접수 중')
    rerender(<StatusTag status="OPEN" daysLeft={-1} />)
    expect(container.textContent).toBe('접수 중')
    rerender(<StatusTag status="UPCOMING" daysLeft={5} />)
    expect(container.textContent).toBe('접수 예정')
  })
})
