import { useCallback, useEffect, useRef, useState } from 'react'

import { appContainer } from '../../../app/appContainer'
import type { FetchCoreApiHealth } from '../../../app/di/types'
import type { CoreApiHealth } from '../../../data/api/coreApiHealth'

type CoreApiHealthState = {
  data: CoreApiHealth | undefined
  isError: boolean
  isLoading: boolean
}

const initialState: CoreApiHealthState = {
  data: undefined,
  isError: false,
  isLoading: true,
}

const coreApiHealthTimeoutMilliseconds = 10_000

/** Core API Health 요청과 화면 수명에 따른 취소를 직접 관리합니다. */
export function useCoreApiHealth(
  fetchCoreApiHealth: FetchCoreApiHealth = appContainer.resolve(
    'fetchCoreApiHealth',
  ),
) {
  const activeController = useRef<AbortController | null>(null)
  const activeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRequestId = useRef(0)
  const isMounted = useRef(false)
  const [state, setState] = useState<CoreApiHealthState>(initialState)

  const refetch = useCallback(async () => {
    if (activeTimeout.current !== null) clearTimeout(activeTimeout.current)
    activeController.current?.abort()

    const controller = new AbortController()
    const requestId = activeRequestId.current + 1
    activeController.current = controller
    activeRequestId.current = requestId
    setState({ data: undefined, isError: false, isLoading: true })
    const timeoutId = setTimeout(() => {
      if (!isMounted.current || activeRequestId.current !== requestId) return
      activeController.current = null
      activeTimeout.current = null
      controller.abort()
      setState({ data: undefined, isError: true, isLoading: false })
    }, coreApiHealthTimeoutMilliseconds)
    activeTimeout.current = timeoutId

    try {
      const data = await fetchCoreApiHealth(controller.signal)
      if (!isMounted.current || activeRequestId.current !== requestId || controller.signal.aborted) return
      setState({ data, isError: false, isLoading: false })
    } catch {
      if (
        !isMounted.current
        || activeRequestId.current !== requestId
        || controller.signal.aborted
      ) return
      setState({ data: undefined, isError: true, isLoading: false })
    } finally {
      clearTimeout(timeoutId)
      if (activeRequestId.current === requestId) {
        activeController.current = null
        activeTimeout.current = null
      }
    }
  }, [fetchCoreApiHealth])

  useEffect(() => {
    isMounted.current = true
    void refetch()

    return () => {
      isMounted.current = false
      activeRequestId.current += 1
      if (activeTimeout.current !== null) clearTimeout(activeTimeout.current)
      activeTimeout.current = null
      activeController.current?.abort()
    }
  }, [refetch])

  return { ...state, refetch }
}
