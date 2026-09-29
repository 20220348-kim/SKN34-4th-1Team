import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import type { ApplicationPreparationListStatus, ApplicationPreparationPage } from '../../../../domain/entities/ApplicationPreparation'
import type { WorkspaceToastNotice } from '../../../shared/workspace/WorkspaceToast'

type FailedRequest = { kind: 'list'; beforeId?: number } | { kind: 'delete'; id: number }
type ListBusyState = 'initial' | 'more' | null

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('신청 준비 목록을 불러오지 못했습니다.')
}

function listStatusFrom(value: string | null): ApplicationPreparationListStatus | undefined {
  return value === 'in_progress' || value === 'done' ? value : undefined
}

export function useApplicationPreparationListViewModel() {
  const useCase = appContainer.resolve('applicationPreparationUseCase')
  const [searchParams, setSearchParams] = useSearchParams()
  // 진행 중·완료 칩은 주소의 ?status= 와 같이 움직여 새로고침·뒤로 가기에도 남는다.
  const status = listStatusFrom(searchParams.get('status'))
  const [toast, setToast] = useState<WorkspaceToastNotice | null>(null)
  const [page, setPage] = useState<ApplicationPreparationPage | null>(null)
  const [busy, setBusy] = useState<ListBusyState>(null)
  const [error, setError] = useState<Error | null>(null)
  const [failedRequest, setFailedRequest] = useState<FailedRequest | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const activeController = useRef<AbortController | null>(null)
  const deleteController = useRef<AbortController | null>(null)
  const deleteGuard = useRef<number | null>(null)
  const requestSequence = useRef(0)

  const load = useCallback((beforeId?: number) => {
    activeController.current?.abort()
    const controller = new AbortController()
    const sequence = ++requestSequence.current
    const append = beforeId !== undefined
    activeController.current = controller
    setBusy(append ? 'more' : 'initial')
    setError(null)
    setFailedRequest(null)
    if (!append) setPage(null)

    void useCase.list({ ...(beforeId === undefined ? {} : { beforeId }), ...(status === undefined ? {} : { status }) }, controller.signal).then((result) => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      setPage((previous) => append && previous
        ? {
            ...result,
            items: [...previous.items, ...result.items.filter(
              (item) => !previous.items.some(({ id }) => id === item.id),
            )],
          }
        : result)
    }).catch((caught: unknown) => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      setError(asError(caught))
      setFailedRequest({ kind: 'list', beforeId })
    }).finally(() => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      activeController.current = null
      setBusy(null)
    })

    return controller
  }, [useCase, status])

  useEffect(() => {
    const controller = load()
    return () => {
      controller.abort()
      deleteController.current?.abort()
      deleteGuard.current = null
      if (activeController.current === controller) activeController.current = null
      requestSequence.current += 1
    }
  }, [load])

  const deletePreparation = useCallback(async (id: number): Promise<boolean> => {
    if (deleteGuard.current !== null) return false
    deleteGuard.current = id
    deleteController.current?.abort()
    const controller = new AbortController()
    deleteController.current = controller
    setDeletingId(id)
    setError(null)
    setFailedRequest(null)
    try {
      await useCase.delete(id, controller.signal)
      if (controller.signal.aborted || deleteController.current !== controller) return false
      setPage((current) => current ? { ...current, items: current.items.filter((item) => item.id !== id) } : current)
      setToast({ id: Date.now(), text: '삭제했어요.' })
      return true
    } catch (caught) {
      if (!controller.signal.aborted && deleteController.current === controller) {
        setError(asError(caught))
        setFailedRequest({ kind: 'delete', id })
      }
      return false
    } finally {
      if (deleteController.current === controller) {
        deleteController.current = null
        deleteGuard.current = null
        setDeletingId(null)
      }
    }
  }, [useCase])

  const retry = useCallback(() => {
    if (failedRequest?.kind === 'list') load(failedRequest.beforeId)
    if (failedRequest?.kind === 'delete') void deletePreparation(failedRequest.id)
  }, [failedRequest, load, deletePreparation])

  const setStatus = useCallback((next: ApplicationPreparationListStatus | undefined) => {
    setSearchParams(next === undefined ? {} : { status: next }, { replace: true })
  }, [setSearchParams])

  return {
    page,
    status,
    setStatus,
    toast,
    dismissToast: () => setToast(null),
    error,
    retry,
    deletePreparation,
    deletingId,
    loadMore: () => page?.nextBeforeId ? load(page.nextBeforeId) : undefined,
    isInitialLoading: busy === 'initial',
    isLoadingMore: busy === 'more',
  }
}
