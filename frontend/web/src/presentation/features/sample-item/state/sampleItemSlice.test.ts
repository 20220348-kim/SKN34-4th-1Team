import { describe, expect, it } from 'vitest'

import { createAppStore } from '../../../../app/store'
import {
  nameChanged,
  noteChanged,
  preparationFailed,
  preparationStarted,
  preparationSucceeded,
  sampleItemReset,
  selectIsSampleItemReady,
  selectSampleItemButtonLabel,
  selectSampleItemErrors,
} from './sampleItemSlice'

describe('sampleItemSlice', () => {
  it('validates fields and derives whether the request is ready', () => {
    const store = createAppStore()

    expect(Object.keys(store.getState())).toEqual(['auth', 'chat', 'receivedProposals', 'sampleItem'])
    expect(selectIsSampleItemReady(store.getState())).toBe(false)
    store.dispatch(nameChanged('Redux 예제'))
    expect(selectIsSampleItemReady(store.getState())).toBe(true)

    store.dispatch(noteChanged('a'.repeat(501)))
    expect(selectIsSampleItemReady(store.getState())).toBe(false)
    expect(selectSampleItemErrors(store.getState()).note).toBe(
      '메모는 500자 이하여야 합니다.',
    )
  })

  it('accepts only the active request result and keeps actions serializable', () => {
    const store = createAppStore()
    store.dispatch(nameChanged('Redux 예제'))
    const started = preparationStarted()
    const ignoredStart = preparationStarted()
    store.dispatch(started)
    store.dispatch(ignoredStart)

    expect(store.getState().sampleItem.activeRequestId).toBe(started.payload.requestId)
    expect(selectIsSampleItemReady(store.getState())).toBe(false)

    store.dispatch(preparationSucceeded({
      preparation: successfulPreparation('무시할 결과'),
      requestId: 'stale-request',
    }))
    expect(store.getState().sampleItem.preparation).toBeNull()

    store.dispatch(preparationSucceeded({
      preparation: successfulPreparation('Redux 예제'),
      requestId: started.payload.requestId,
    }))
    expect(store.getState().sampleItem.preparation?.item.name).toBe('Redux 예제')
    expect(selectSampleItemButtonLabel(store.getState())).toBe('다시 확인')
  })

  it('derives retry state and supports an explicit reset', () => {
    const store = createAppStore()
    store.dispatch(nameChanged('재시도'))
    const first = preparationStarted()
    store.dispatch(first)
    store.dispatch(preparationFailed({ requestId: first.payload.requestId }))
    expect(selectSampleItemButtonLabel(store.getState())).toBe('다시 요청')

    const retry = preparationStarted()
    store.dispatch(retry)
    expect(selectSampleItemButtonLabel(store.getState())).toBe('다시 요청 중…')

    store.dispatch(sampleItemReset())
    expect(store.getState().sampleItem.values.name).toBe('')
    expect(store.getState().sampleItem.status).toBe('idle')
  })
})

function successfulPreparation(name: string) {
  return {
    item: { category: null, name, note: null },
    phase: 'READY_FOR_PROCESSING' as const,
    processing: { status: 'NOT_STARTED' as const },
  }
}
