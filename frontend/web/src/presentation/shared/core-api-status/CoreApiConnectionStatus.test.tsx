// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CoreApiConnectionStatus } from './CoreApiConnectionStatus'

const useHealth = vi.hoisted(() => vi.fn())
vi.mock('./useCoreApiHealth', () => ({ useCoreApiHealth: useHealth }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('CoreApiConnectionStatus', () => {
  it.each(['down', 'unknown'])('offers a manual recheck for a successful HTTP response with %s status', (status) => {
    const refetch = vi.fn().mockResolvedValue(undefined)
    useHealth.mockReturnValue({ data: { service: 'govbiz-core-service', status }, isError: false, isLoading: false, refetch })
    render(<CoreApiConnectionStatus />)
    expect(screen.getByRole('status').textContent).toContain('Core API 상태 확인 필요')
    fireEvent.click(screen.getByRole('button', { name: '다시 확인' }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it('announces loading and the eventual healthy state without a redundant retry control', () => {
    useHealth.mockReturnValue({ data: undefined, isError: false, isLoading: true, refetch: vi.fn() })
    const view = render(<CoreApiConnectionStatus />)
    expect(screen.getByRole('status').textContent).toContain('Core API 연결 확인 중')
    expect(screen.getByRole('status').getAttribute('aria-atomic')).toBe('true')
    expect(screen.queryByRole('button')).toBeNull()
    useHealth.mockReturnValue({ data: { service: 'govbiz-core-service', status: 'up' }, isError: false, isLoading: false, refetch: vi.fn() })
    view.rerender(<CoreApiConnectionStatus />)
    expect(screen.getByRole('status').textContent).toContain('Core API 연결됨')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('announces a failed check and retains manual retry', () => {
    const refetch = vi.fn().mockResolvedValue(undefined)
    useHealth.mockReturnValue({ data: undefined, isError: true, isLoading: false, refetch })
    render(<CoreApiConnectionStatus />)
    expect(screen.getByRole('status').textContent).toContain('Core API에 연결할 수 없습니다')
    fireEvent.click(screen.getByRole('button', { name: '다시 확인' }))
    expect(refetch).toHaveBeenCalledOnce()
  })
})
