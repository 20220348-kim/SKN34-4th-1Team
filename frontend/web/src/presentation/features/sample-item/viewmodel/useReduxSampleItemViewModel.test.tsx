// @vitest-environment jsdom

import type { SubmitEvent } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAppStore, type AppStore } from '../../../../app/store'
import type { SampleItem } from '../../../../domain/entities/SampleItem'
import type { SampleItemPreparation } from '../../../../domain/entities/SampleItemPreparation'
import type { PrepareSampleItemUseCase } from '../../../../domain/usecases/PrepareSampleItemUseCase'
import { useReduxSampleItemViewModel } from './useReduxSampleItemViewModel'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('useReduxSampleItemViewModel', () => {
  it('times out after 10 seconds, allows retry, and ignores the earlier late response', async () => {
    const initial = deferred<SampleItemPreparation>()
    const retry = deferred<SampleItemPreparation>()
    const execute = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(retry.promise)
    const store = createAppStore()
    renderHarness(store, { execute })
    fireEvent.change(screen.getByTestId('name-input'), { target: { value: '같은 입력' } })
    vi.useFakeTimers()
    fireEvent.submit(screen.getByTestId('sample-form'))
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999) })
    expect(submitButton().disabled).toBe(true)
    expect(execute.mock.calls[0][1].aborted).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(execute.mock.calls[0][1].aborted).toBe(true)
    expect(screen.getByTestId('preparation-error').textContent).toContain('시간이 초과')
    expect(submitButton().disabled).toBe(false)
    expect(submitButton().textContent).toBe('다시 요청')
    expect(vi.getTimerCount()).toBe(0)

    fireEvent.submit(screen.getByTestId('sample-form'))
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][0]).toEqual(execute.mock.calls[0][0])
    await act(async () => { initial.resolve(successfulPreparation('이전 결과')); await initial.promise })
    expect(screen.queryByTestId('preparation')).toBeNull()
    expect(submitButton().disabled).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => { retry.resolve(successfulPreparation('같은 입력')); await retry.promise })
    expect(screen.getByTestId('preparation').textContent).toBe('같은 입력')
    expect(screen.queryByTestId('preparation-error')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['edit', 'reset', 'unmount'] as const)('clears the request timeout on %s', async (operation) => {
    const pending = deferred<SampleItemPreparation>()
    const execute = vi.fn().mockReturnValue(pending.promise)
    const store = createAppStore()
    const { unmount } = renderHarness(store, { execute })
    fireEvent.change(screen.getByTestId('name-input'), { target: { value: '예제' } })
    vi.useFakeTimers()
    fireEvent.submit(screen.getByTestId('sample-form'))
    expect(vi.getTimerCount()).toBe(1)
    if (operation === 'edit') fireEvent.change(screen.getByTestId('name-input'), { target: { value: '수정' } })
    else if (operation === 'reset') fireEvent.click(screen.getByRole('button', { name: 'Redux 상태 초기화' }))
    else unmount()
    expect(execute.mock.calls[0][1].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => { pending.resolve(successfulPreparation('예제')); await pending.promise })
    expect(store.getState().sampleItem.status).toBe('idle')
    expect(store.getState().sampleItem.preparation).toBeNull()
  })

  it('normalizes input, blocks duplicate submits, and preserves success in the same Store', async () => {
    const pending = deferred<SampleItemPreparation>()
    const execute = vi.fn((_item: SampleItem, _signal?: AbortSignal) => pending.promise)
    const store = createAppStore()
    const view = renderHarness(store, { execute })

    fireEvent.change(screen.getByTestId('name-input'), { target: { value: '  Redux 예제  ' } })
    fireEvent.change(screen.getByTestId('category-input'), { target: { value: 'BASIC' } })
    fireEvent.change(screen.getByTestId('note-input'), { target: { value: '  설명  ' } })
    await waitFor(() => expect(submitButton().disabled).toBe(false))

    fireEvent.submit(screen.getByTestId('sample-form'))
    fireEvent.submit(screen.getByTestId('sample-form'))
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())
    expect(execute.mock.calls[0][0]).toEqual({
      category: 'BASIC',
      name: 'Redux 예제',
      note: '설명',
    })
    expect(execute.mock.calls[0][1]).toBeInstanceOf(AbortSignal)

    await act(async () => {
      pending.resolve(successfulPreparation('Redux 예제'))
      await pending.promise
    })
    expect(screen.getByTestId('preparation').textContent).toBe('Redux 예제')
    expect(submitButton().textContent).toBe('다시 확인')

    view.unmount()
    renderHarness(store, { execute })
    expect((screen.getByTestId('name-input') as HTMLInputElement).value).toBe('  Redux 예제  ')
    expect(screen.getByTestId('preparation').textContent).toBe('Redux 예제')
  })

  it('aborts a pending request when the input changes and ignores its late result', async () => {
    const pending = deferred<SampleItemPreparation>()
    let signal: AbortSignal | undefined
    const execute = vi.fn((_item: SampleItem, requestSignal?: AbortSignal) => {
      signal = requestSignal
      return pending.promise
    })
    const store = createAppStore()
    renderHarness(store, { execute })

    fireEvent.change(screen.getByTestId('name-input'), { target: { value: '이전 입력' } })
    fireEvent.submit(screen.getByTestId('sample-form'))
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())

    fireEvent.change(screen.getByTestId('name-input'), { target: { value: '새 입력' } })
    expect(signal?.aborted).toBe(true)
    expect(store.getState().sampleItem.status).toBe('idle')

    await act(async () => {
      pending.resolve(successfulPreparation('이전 입력'))
      await pending.promise
    })
    expect(screen.queryByTestId('preparation')).toBeNull()
  })

  it('resets every Redux field, aborts pending work, and ignores its late result', async () => {
    const pending = deferred<SampleItemPreparation>()
    let signal: AbortSignal | undefined
    const execute = vi.fn((_item: SampleItem, requestSignal?: AbortSignal) => {
      signal = requestSignal
      return pending.promise
    })
    const store = createAppStore()
    renderHarness(store, { execute })

    fireEvent.change(screen.getByTestId('name-input'), { target: { value: '초기화할 입력' } })
    fireEvent.change(screen.getByTestId('note-input'), { target: { value: '초기화할 메모' } })
    fireEvent.submit(screen.getByTestId('sample-form'))
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole('button', { name: 'Redux 상태 초기화' }))

    expect(signal?.aborted).toBe(true)
    expect(store.getState().sampleItem).toMatchObject({
      activeRequestId: null,
      error: null,
      preparation: null,
      status: 'idle',
      values: { category: '', name: '', note: '' },
    })

    await act(async () => {
      pending.resolve(successfulPreparation('초기화할 입력'))
      await pending.promise
    })
    expect(store.getState().sampleItem.preparation).toBeNull()
  })

  it('retries the same input with a new signal and cancels pending work on unmount', async () => {
    const retryPending = deferred<SampleItemPreparation>()
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error('private detail'))
      .mockImplementationOnce((_item: SampleItem, _signal?: AbortSignal) => retryPending.promise)
    const store = createAppStore()
    const view = renderHarness(store, { execute })

    fireEvent.change(screen.getByTestId('name-input'), { target: { value: '같은 입력' } })
    fireEvent.submit(screen.getByTestId('sample-form'))
    await waitFor(() => expect(screen.getByTestId('preparation-error').textContent).toContain('다시 요청'))
    expect(screen.getByTestId('preparation-error').textContent).not.toContain('private detail')

    fireEvent.submit(screen.getByTestId('sample-form'))
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    expect(execute.mock.calls[1][0]).toEqual(execute.mock.calls[0][0])
    expect(execute.mock.calls[1][1]).not.toBe(execute.mock.calls[0][1])
    const retrySignal = execute.mock.calls[1][1] as AbortSignal

    view.unmount()
    expect(retrySignal.aborted).toBe(true)
    expect(store.getState().sampleItem.status).toBe('idle')
    expect(store.getState().sampleItem.values.name).toBe('같은 입력')

    retryPending.resolve(successfulPreparation('같은 입력'))
    await retryPending.promise
    expect(store.getState().sampleItem.preparation).toBeNull()
  })
})

function TestHarness({ useCase }: { useCase: Pick<PrepareSampleItemUseCase, 'execute'> }) {
  const viewModel = useReduxSampleItemViewModel(useCase)

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    void viewModel.prepare()
  }

  return (
    <form data-testid="sample-form" onSubmit={submit}>
      <input
        data-testid="name-input"
        value={viewModel.values.name}
        onChange={(event) => viewModel.updateName(event.target.value)}
      />
      <select
        data-testid="category-input"
        value={viewModel.values.category}
        onChange={(event) => viewModel.updateCategory(event.target.value)}
      >
        <option value="">선택하지 않음</option>
        <option value="BASIC">Basic</option>
        <option value="EXTENDED">Extended</option>
      </select>
      <textarea
        data-testid="note-input"
        value={viewModel.values.note}
        onChange={(event) => viewModel.updateNote(event.target.value)}
      />
      <button type="submit" disabled={!viewModel.isReady}>{viewModel.submitButtonLabel}</button>
      <button type="button" onClick={viewModel.reset}>Redux 상태 초기화</button>
      {viewModel.preparation ? (
        <output data-testid="preparation">{viewModel.preparation.item.name}</output>
      ) : null}
      {viewModel.preparationError ? (
        <p data-testid="preparation-error">{viewModel.preparationError}</p>
      ) : null}
    </form>
  )
}

function renderHarness(
  store: AppStore,
  useCase: Pick<PrepareSampleItemUseCase, 'execute'>,
) {
  return render(
    <Provider store={store}>
      <TestHarness useCase={useCase} />
    </Provider>,
  )
}

function submitButton() {
  return screen.getByRole('button', {
    name: /준비 상태 확인|요청 중|다시 확인|다시 요청/,
  }) as HTMLButtonElement
}

function successfulPreparation(name: string): SampleItemPreparation {
  return {
    item: { category: null, name, note: null },
    phase: 'READY_FOR_PROCESSING',
    processing: { status: 'NOT_STARTED' },
  }
}

function deferred<Result>() {
  let resolve!: (result: Result) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Result>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, reject, resolve }
}
