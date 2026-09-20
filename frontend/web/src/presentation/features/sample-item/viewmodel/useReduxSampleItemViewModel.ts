import { useCallback, useEffect, useRef } from 'react'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch, useAppSelector } from '../../../../app/hooks'
import type { AppDispatch, RootState } from '../../../../app/store'
import type { PrepareSampleItemUseCase } from '../../../../domain/usecases/PrepareSampleItemUseCase'
import {
  categoryChanged,
  nameChanged,
  noteChanged,
  preparationCancelled,
  preparationFailed,
  preparationStarted,
  preparationSucceeded,
  sampleItemReset,
  selectIsSampleItemPreparing,
  selectIsSampleItemReady,
  selectSampleItemActionMessage,
  selectSampleItemButtonLabel,
  selectSampleItemError,
  selectSampleItemErrors,
  selectSampleItemPreparation,
  selectSampleItemState,
  selectSampleItemValues,
} from '../state/sampleItemSlice'
import { sampleItemFormSchema, toSampleItem } from '../validation/sampleItemFormSchema'

type SampleItemUseCase = Pick<PrepareSampleItemUseCase, 'execute'>

const reduxSampleItemPreparationTimeoutMilliseconds = 10_000

export function useReduxSampleItemViewModel(
  prepareSampleItemUseCase: SampleItemUseCase = appContainer.resolve('prepareSampleItemUseCase'),
) {
  const dispatchToStore = useAppDispatch()
  const activeRequest = useRef<{
    controller: AbortController
    requestId: string
    timeoutId: ReturnType<typeof setTimeout>
  } | null>(null)
  const actionMessage = useAppSelector(selectSampleItemActionMessage)
  const errors = useAppSelector(selectSampleItemErrors)
  const isPreparing = useAppSelector(selectIsSampleItemPreparing)
  const isReady = useAppSelector(selectIsSampleItemReady)
  const preparation = useAppSelector(selectSampleItemPreparation)
  const preparationError = useAppSelector(selectSampleItemError)
  const submitButtonLabel = useAppSelector(selectSampleItemButtonLabel)
  const values = useAppSelector(selectSampleItemValues)

  const cancelActiveRequest = useCallback(() => {
    const request = activeRequest.current
    activeRequest.current = null
    if (!request) return

    clearTimeout(request.timeoutId)
    request.controller.abort()
    dispatchToStore(preparationCancelled({ requestId: request.requestId }))
  }, [dispatchToStore])

  useEffect(() => () => {
    cancelActiveRequest()
  }, [cancelActiveRequest])

  function updateCategory(value: string) {
    if (value !== '' && value !== 'BASIC' && value !== 'EXTENDED') return
    cancelActiveRequest()
    dispatchToStore(categoryChanged(value))
  }

  function updateName(value: string) {
    cancelActiveRequest()
    dispatchToStore(nameChanged(value))
  }

  function updateNote(value: string) {
    cancelActiveRequest()
    dispatchToStore(noteChanged(value))
  }

  function prepare() {
    async function runPreparation(
      dispatchAction: AppDispatch,
      readCurrentState: () => RootState,
    ): Promise<void> {
      const currentState = selectSampleItemState(readCurrentState())
      if (currentState.status === 'pending') return

      const validation = sampleItemFormSchema.safeParse(currentState.values)
      if (!validation.success) return

      const startedAction = preparationStarted()
      const controller = new AbortController()
      const requestId = startedAction.payload.requestId

      dispatchAction(startedAction)
      const timeoutId = setTimeout(() => {
        if (activeRequest.current?.requestId !== requestId) return
        activeRequest.current = null
        dispatchAction(preparationFailed({
          requestId,
          message: 'Core API Redux 예제 요청 시간이 초과되었습니다. 다시 요청해 주세요.',
        }))
        controller.abort()
      }, reduxSampleItemPreparationTimeoutMilliseconds)
      activeRequest.current = { controller, requestId, timeoutId }

      try {
        const result = await prepareSampleItemUseCase.execute(
          toSampleItem(validation.data),
          controller.signal,
        )
        if (controller.signal.aborted) return

        dispatchAction(preparationSucceeded({ preparation: result, requestId }))
      } catch {
        if (controller.signal.aborted) return
        dispatchAction(preparationFailed({ requestId }))
      } finally {
        clearTimeout(timeoutId)
        if (activeRequest.current?.requestId === requestId) {
          activeRequest.current = null
        }
      }
    }

    return dispatchToStore(runPreparation)
  }

  function reset() {
    cancelActiveRequest()
    dispatchToStore(sampleItemReset())
  }

  return {
    actionMessage,
    errors,
    isPreparing,
    isReady,
    preparation,
    preparationError,
    prepare,
    reset,
    submitButtonLabel,
    updateCategory,
    updateName,
    updateNote,
    values,
  }
}
