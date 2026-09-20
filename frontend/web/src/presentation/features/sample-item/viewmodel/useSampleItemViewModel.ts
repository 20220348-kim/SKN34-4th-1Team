import { zodResolver } from '@hookform/resolvers/zod'
import { type BaseSyntheticEvent, useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'

import { appContainer } from '../../../../app/appContainer'
import type { SampleItemPreparation } from '../../../../domain/entities/SampleItemPreparation'
import type { PrepareSampleItemUseCase } from '../../../../domain/usecases/PrepareSampleItemUseCase'
import {
  sampleItemFormSchema,
  toSampleItem,
  type SampleItemFormValues,
} from '../validation/sampleItemFormSchema'

type SampleItemUseCase = Pick<PrepareSampleItemUseCase, 'execute'>

const sampleItemPreparationTimeoutMilliseconds = 10_000

export function useSampleItemViewModel(
  prepareSampleItemUseCase: SampleItemUseCase = appContainer.resolve('prepareSampleItemUseCase'),
) {
  const form = useForm<SampleItemFormValues>({
    resolver: zodResolver(sampleItemFormSchema),
    mode: 'onChange',
    defaultValues: {
      name: '',
      category: '',
      note: '',
    },
  })
  const activeController = useRef<AbortController | null>(null)
  const activeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRequestId = useRef<number | null>(null)
  const isMounted = useRef(true)
  const requestSequence = useRef(0)
  const [isPreparing, setIsPreparing] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)
  const [preparation, setPreparation] = useState<SampleItemPreparation | null>(null)
  const [preparationError, setPreparationError] = useState<string | null>(null)

  useEffect(() => {
    isMounted.current = true

    return () => {
      isMounted.current = false
      if (activeTimeout.current !== null) clearTimeout(activeTimeout.current)
      activeTimeout.current = null
      activeController.current?.abort()
      activeController.current = null
      activeRequestId.current = null
      requestSequence.current += 1
    }
  }, [])

  function resetPreparation() {
    if (activeTimeout.current !== null) clearTimeout(activeTimeout.current)
    activeTimeout.current = null
    activeController.current?.abort()
    activeController.current = null
    activeRequestId.current = null
    requestSequence.current += 1
    setIsPreparing(false)
    setIsRetrying(false)
    setPreparation(null)
    setPreparationError(null)
  }

  function registerField<FieldName extends keyof SampleItemFormValues>(name: FieldName) {
    return form.register(name, {
      onChange: resetPreparation,
    })
  }

  function prepare(event?: BaseSyntheticEvent) {
    // 비동기 폼 검증 중 수정·이탈한 입력으로 뒤늦게 요청을 시작하지 않습니다.
    const submittedRevision = requestSequence.current
    return form.handleSubmit(async (values) => {
      if (!isMounted.current || requestSequence.current !== submittedRevision || activeRequestId.current !== null) return

      const item = toSampleItem(values)
      const requestId = requestSequence.current + 1
      const controller = new AbortController()
      requestSequence.current = requestId
      activeController.current = controller
      activeRequestId.current = requestId
      setIsRetrying(preparationError !== null)
      setIsPreparing(true)
      setPreparation(null)
      setPreparationError(null)
      const timeoutId = setTimeout(() => {
        if (!isMounted.current || activeRequestId.current !== requestId) return
        activeController.current = null
        activeTimeout.current = null
        activeRequestId.current = null
        controller.abort()
        setIsPreparing(false)
        setIsRetrying(false)
        setPreparationError('Core API 예제 요청 시간이 초과되었습니다. 다시 요청해 주세요.')
      }, sampleItemPreparationTimeoutMilliseconds)
      activeTimeout.current = timeoutId

      try {
        const result = await prepareSampleItemUseCase.execute(item, controller.signal)
        if (!isMounted.current || activeRequestId.current !== requestId) return
        setPreparation(result)
      } catch {
        if (!isMounted.current || activeRequestId.current !== requestId) return
        setPreparationError(
          'Core API에 예제 요청을 전달하지 못했습니다. Core API 상태를 확인한 뒤 다시 요청해 주세요.',
        )
      } finally {
        clearTimeout(timeoutId)
        if (isMounted.current && activeRequestId.current === requestId) {
          activeTimeout.current = null
          activeController.current = null
          activeRequestId.current = null
          setIsPreparing(false)
          setIsRetrying(false)
        }
      }
    })(event)
  }

  return {
    actionMessage: createActionMessage(
      isPreparing,
      preparationError !== null,
      preparation !== null,
      form.formState.isValid,
    ),
    errors: form.formState.errors,
    isReady: form.formState.isValid && !isPreparing,
    isPreparing,
    preparation,
    preparationError,
    registerField,
    prepare,
    submitButtonLabel: createSubmitButtonLabel(
      isPreparing,
      isRetrying,
      preparationError !== null,
      preparation !== null,
    ),
  }
}

function createActionMessage(
  isPreparing: boolean,
  hasError: boolean,
  hasPreparation: boolean,
  isValid: boolean,
) {
  if (isPreparing) return 'Core API에 요청을 보내고 있습니다.'
  if (hasError) return '요청이 실패했습니다. 아래 버튼으로 다시 요청할 수 있습니다.'
  if (hasPreparation) return 'Core API 요청이 성공했습니다.'
  if (isValid) return '준비 요청을 보낼 수 있습니다.'
  return '이름을 입력하면 준비됩니다.'
}

function createSubmitButtonLabel(
  isPreparing: boolean,
  isRetrying: boolean,
  hasError: boolean,
  hasPreparation: boolean,
) {
  if (isPreparing) return isRetrying ? '다시 요청 중…' : '요청 중…'
  if (hasError) return '다시 요청'
  return hasPreparation ? '다시 확인' : '준비 상태 확인'
}
