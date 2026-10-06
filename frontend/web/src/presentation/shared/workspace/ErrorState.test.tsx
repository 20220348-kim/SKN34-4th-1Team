// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorState } from './ErrorState'

afterEach(cleanup)

describe('ErrorState', () => {
  it('실패 문장을 바로 읽어 주고 [다시 시도]로 다시 요청한다', () => {
    const onRetry = vi.fn()
    render(<ErrorState message="관심 공고를 불러오지 못했어요. 잠시 후 다시 시도해 주세요." onRetry={onRetry} />)

    expect(screen.getByRole('alert').textContent).toContain('관심 공고를 불러오지 못했어요.')
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('다시 시도하는 동안에는 버튼을 잠가 요청이 겹치지 않게 한다', () => {
    const onRetry = vi.fn()
    render(<ErrorState message="불러오지 못했어요." onRetry={onRetry} retrying />)

    const button = screen.getByRole('button', { name: '다시 시도' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(button)
    expect(onRetry).not.toHaveBeenCalled()
  })
})
