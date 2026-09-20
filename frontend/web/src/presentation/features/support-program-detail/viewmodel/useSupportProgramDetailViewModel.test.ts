// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import type { SupportProgramIdentity } from '../../../../domain/repositories/SupportProgramRepository'
import type { GetSupportProgramDetailUseCase } from '../../../../domain/usecases/GetSupportProgramDetailUseCase'
import {
  supportProgramDetailTimeoutMilliseconds,
  useSupportProgramDetailViewModel,
} from './useSupportProgramDetailViewModel'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useSupportProgramDetailViewModel', () => {
  it('leaves loading after ten seconds and ignores a timed-out detail response', async () => {
    vi.useFakeTimers()
    const pending = deferredProgram()
    let requestSignal: AbortSignal | undefined
    const execute = vi.fn((_identity: SupportProgramIdentity, signal?: AbortSignal) => {
      requestSignal = signal
      return pending.promise
    })
    const detailUseCase = createDetailUseCase(execute)
    const { result } = renderHook(() => useSupportProgramDetailViewModel(getIdentity(), detailUseCase))

    await act(async () => vi.advanceTimersByTimeAsync(supportProgramDetailTimeoutMilliseconds - 1))
    expect(result.current.status).toBe('loading')
    expect(requestSignal?.aborted).toBe(false)

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(requestSignal?.aborted).toBe(true)
    expect(result.current).toMatchObject({ status: 'failed', program: null })

    await act(async () => pending.resolve(supportPrograms[0]))
    expect(result.current).toMatchObject({ status: 'failed', program: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears its request timer after success and on unmount', async () => {
    vi.useFakeTimers()
    const completedUseCase = createDetailUseCase(vi.fn().mockResolvedValue(supportPrograms[0]))
    const completed = renderHook(() => useSupportProgramDetailViewModel(getIdentity(), completedUseCase))
    await act(async () => { await Promise.resolve() })
    expect(completed.result.current.status).toBe('ready')
    expect(vi.getTimerCount()).toBe(0)
    completed.unmount()

    const pending = deferredProgram()
    const pendingUseCase = createDetailUseCase(vi.fn().mockReturnValue(pending.promise))
    const waiting = renderHook(() => useSupportProgramDetailViewModel(getIdentity(), pendingUseCase))
    expect(vi.getTimerCount()).toBe(1)
    waiting.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('loads the current program with its complete source identity', async () => {
    const execute = vi.fn().mockResolvedValue(supportPrograms[0])
    const identity = getIdentity()
    const detailUseCase = createDetailUseCase(execute)
    const { result } = renderHook(() => useSupportProgramDetailViewModel(
      identity,
      detailUseCase,
    ))

    expect(result.current).toMatchObject({ status: 'loading', program: null })
    await waitFor(() => expect(result.current).toMatchObject({
      status: 'ready',
      program: supportPrograms[0],
    }))
    expect(execute).toHaveBeenCalledWith(identity, expect.any(AbortSignal))
  })

  it('maps a missing detail result to a distinct not-found state', async () => {
    const execute = vi.fn().mockResolvedValue(null)
    const detailUseCase = createDetailUseCase(execute)
    const { result } = renderHook(() => useSupportProgramDetailViewModel(
      getIdentity(),
      detailUseCase,
    ))

    await waitFor(() => expect(result.current).toMatchObject({ status: 'not-found', program: null }))
  })

  it('allows a manual retry after timeout and discards the original late response', async () => {
    vi.useFakeTimers()
    const pending = deferredProgram()
    const execute = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(supportPrograms[0])
    const detailUseCase = createDetailUseCase(execute)
    const { result } = renderHook(() => useSupportProgramDetailViewModel(getIdentity(), detailUseCase))
    await act(async () => vi.advanceTimersByTimeAsync(supportProgramDetailTimeoutMilliseconds))
    expect(result.current.status).toBe('failed')
    expect(execute).toHaveBeenCalledOnce()
    await act(async () => result.current.retry())
    expect(result.current).toMatchObject({ status: 'ready', program: supportPrograms[0] })
    expect(execute).toHaveBeenCalledTimes(2)
    await act(async () => pending.resolve(supportPrograms[1]))
    expect(result.current).toMatchObject({ status: 'ready', program: supportPrograms[0] })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts the old identity request and discards its late response after an identity change', async () => {
    const pending = deferredProgram()
    const signals: AbortSignal[] = []
    const execute = vi.fn((_identity: SupportProgramIdentity, signal?: AbortSignal) => {
      signals.push(signal!)
      return signals.length === 1 ? pending.promise : Promise.resolve(supportPrograms[1])
    })
    const detailUseCase = createDetailUseCase(execute)
    const { result, rerender } = renderHook(
      (identity: SupportProgramIdentity) => useSupportProgramDetailViewModel(identity, detailUseCase),
      { initialProps: getIdentity() },
    )
    const next = { sourceCode: supportPrograms[1].sourceCode, sourceProgramId: supportPrograms[1].id }
    rerender(next)
    expect(signals[0].aborted).toBe(true)
    await waitFor(() => expect(result.current.program).toEqual(supportPrograms[1]))
    await act(async () => pending.resolve(supportPrograms[0]))
    expect(result.current.program).toEqual(supportPrograms[1])
  })

  it('aborts the in-flight detail request when the page unmounts', async () => {
    const pending = deferredProgram()
    let requestSignal: AbortSignal | undefined
    const execute = vi.fn((_identity: SupportProgramIdentity, signal?: AbortSignal) => {
      requestSignal = signal
      return pending.promise
    })
    const detailUseCase = createDetailUseCase(execute)
    const { unmount } = renderHook(() => useSupportProgramDetailViewModel(
      getIdentity(),
      detailUseCase,
    ))

    await waitFor(() => expect(execute).toHaveBeenCalledOnce())
    unmount()

    expect(requestSignal?.aborted).toBe(true)
    await act(async () => pending.resolve(supportPrograms[0]))
  })
})

function getIdentity(): SupportProgramIdentity {
  return {
    sourceCode: supportPrograms[0].sourceCode,
    sourceProgramId: supportPrograms[0].id,
  }
}

function createDetailUseCase(
  execute: GetSupportProgramDetailUseCase['execute'],
): Pick<GetSupportProgramDetailUseCase, 'execute'> {
  return { execute }
}

function deferredProgram() {
  type Program = Awaited<ReturnType<GetSupportProgramDetailUseCase['execute']>>
  let resolve!: (program: Program) => void
  const promise = new Promise<Program>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
