// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CoreApiHealth } from '../../../data/api/coreApiHealth'
import { useCoreApiHealth } from './useCoreApiHealth'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('useCoreApiHealth', () => {
  it('ends an unresponsive check after 10 seconds and ignores its late response before retry', async () => {
    vi.useFakeTimers()
    const pending = deferred<CoreApiHealth>()
    const fetchCoreApiHealth = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ service: 'govbiz-core-service', status: 'up' })
    const { result } = renderHook(() => useCoreApiHealth(fetchCoreApiHealth))
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999) })
    expect(result.current.isLoading).toBe(true)
    expect(fetchCoreApiHealth.mock.calls[0][0].aborted).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(result.current).toMatchObject({ isLoading: false, isError: true, data: undefined })
    expect(fetchCoreApiHealth.mock.calls[0][0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    await act(async () => { pending.resolve({ service: 'stale-core-service', status: 'up' }); await pending.promise })
    expect(result.current).toMatchObject({ isLoading: false, isError: true, data: undefined })
    await act(async () => { await result.current.refetch() })
    expect(result.current).toMatchObject({ isLoading: false, isError: false, data: { service: 'govbiz-core-service', status: 'up' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['refetch', 'unmount'] as const)('cleans up an unresponsive check timer on %s', async (operation) => {
    vi.useFakeTimers()
    const pending = deferred<CoreApiHealth>()
    const fetchCoreApiHealth = vi.fn().mockReturnValue(pending.promise)
    const { result, unmount } = renderHook(() => useCoreApiHealth(fetchCoreApiHealth))
    expect(vi.getTimerCount()).toBe(1)
    if (operation === 'refetch') {
      act(() => { void result.current.refetch() })
      expect(fetchCoreApiHealth.mock.calls[0][0].aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(1)
    }
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => { pending.resolve({ service: 'govbiz-core-service', status: 'up' }); await pending.promise })
  })

  it('aborts the first StrictMode request and only applies the latest response', async () => {
    const first = deferred<CoreApiHealth>()
    const second = deferred<CoreApiHealth>()
    const signals: AbortSignal[] = []
    const fetchCoreApiHealth = vi.fn((signal?: AbortSignal) => {
      signals.push(signal!)
      return signals.length === 1 ? first.promise : second.promise
    })
    const { result } = renderHook(() => useCoreApiHealth(fetchCoreApiHealth), {
      reactStrictMode: true,
    })

    await waitFor(() => expect(fetchCoreApiHealth).toHaveBeenCalledTimes(2))
    expect(signals[0].aborted).toBe(true)

    const latestHealth = { service: 'govbiz-core-service', status: 'up' }
    await act(async () => {
      second.resolve(latestHealth)
      await second.promise
    })
    await waitFor(() => expect(result.current.data).toEqual(latestHealth))

    await act(async () => {
      first.resolve({ service: 'stale-core-service', status: 'down' })
      await first.promise
    })
    expect(result.current.data).toEqual(latestHealth)
    expect(result.current.isError).toBe(false)
  })

  it('aborts the previous request on refetch and aborts the latest request on unmount', async () => {
    const first = deferred<CoreApiHealth>()
    const second = deferred<CoreApiHealth>()
    const signals: AbortSignal[] = []
    const fetchCoreApiHealth = vi.fn((signal?: AbortSignal) => {
      signals.push(signal!)
      return signals.length === 1 ? first.promise : second.promise
    })
    const { result, unmount } = renderHook(() => useCoreApiHealth(fetchCoreApiHealth))
    await waitFor(() => expect(fetchCoreApiHealth).toHaveBeenCalledOnce())

    let refetchPromise!: Promise<void>
    act(() => {
      refetchPromise = result.current.refetch()
    })
    await waitFor(() => expect(fetchCoreApiHealth).toHaveBeenCalledTimes(2))
    expect(signals[0].aborted).toBe(true)

    unmount()
    expect(signals[1].aborted).toBe(true)

    first.resolve({ service: 'stale-core-service', status: 'down' })
    second.resolve({ service: 'govbiz-core-service', status: 'up' })
    await Promise.all([first.promise, second.promise, refetchPromise])
  })

  it('shows a safe error state and recovers when retry succeeds', async () => {
    const fetchCoreApiHealth = vi.fn()
      .mockRejectedValueOnce(new Error('internal network detail'))
      .mockResolvedValueOnce({ service: 'govbiz-core-service', status: 'up' })
    const { result } = renderHook(() => useCoreApiHealth(fetchCoreApiHealth))
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()

    await act(async () => {
      await result.current.refetch()
    })
    expect(result.current).toMatchObject({
      data: { service: 'govbiz-core-service', status: 'up' },
      isError: false,
      isLoading: false,
    })
  })
})

function deferred<Result>() {
  let resolve!: (result: Result) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Result>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, reject, resolve }
}
