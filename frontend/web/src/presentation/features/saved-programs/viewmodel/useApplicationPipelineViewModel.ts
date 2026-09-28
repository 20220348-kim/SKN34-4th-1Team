import { useCallback, useEffect, useRef, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import type { ApplicationPreparationSummary, ApplicationProgressStage } from '../../../../domain/entities/ApplicationPreparation'
import type { ApplicationPreparationUseCase } from '../../../../domain/usecases/ApplicationPreparationUseCase'

export const applicationPipelineStages = [
  { key: 'PREPARING', label: '준비 중', description: '신청 서류를 작성하고 있습니다.' },
  { key: 'APPLIED', label: '지원 완료', description: '접수를 마친 사업입니다.' },
  { key: 'DOCUMENT_REVIEW', label: '서류 심사', description: '서류 심사 결과를 기다립니다.' },
  { key: 'PRESENTATION_REVIEW', label: '발표 심사', description: '발표 심사를 준비하거나 기다립니다.' },
  { key: 'SELECTED', label: '선정', description: '선정되어 수행을 준비하는 사업입니다.' },
  { key: 'REJECTED', label: '탈락', description: '선정되지 않아 종료된 사업입니다.' },
] as const

export type ApplicationPipelineListUseCase = Pick<ApplicationPreparationUseCase, 'list' | 'updateProgress'>

type PipelineState = {
  phase: 'idle' | 'loading' | 'ready' | 'failed'
  items: ApplicationPreparationSummary[]
  nextBeforeId: number | null
  loadingMore: boolean
}

const initialState: PipelineState = { phase: 'idle', items: [], nextBeforeId: null, loadingMore: false }

/** 실제 신청 준비 목록을 읽고 계정에 저장된 진행 단계 변경을 반영합니다. */
export function useApplicationPipelineViewModel(
  enabled: boolean,
  useCase: ApplicationPipelineListUseCase = appContainer.resolve('applicationPreparationUseCase'),
) {
  const [state, setState] = useState<PipelineState>(initialState)
  const [requestVersion, setRequestVersion] = useState(0)
  const [changingId, setChangingId] = useState<number | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const loadedOnce = useRef(false)

  // `enabled`가 켜져 있는 동안 한 번 읽습니다. 정리(cleanup)에서 요청을 끊으므로 개발 모드의 이중 마운트처럼
  // 효과가 다시 돌면 새 요청을 보냅니다("한 번 보냈음" 플래그로 막으면 끊긴 첫 요청만 남아 목록이 비어 보입니다).
  useEffect(() => {
    if (!enabled) return
    if (loadedOnce.current) return
    const controller = new AbortController()
    setState(current => ({ ...current, phase: 'loading' }))
    void useCase.list(undefined, controller.signal).then(page => {
      if (controller.signal.aborted) return
      loadedOnce.current = true
      setState({ phase: 'ready', items: page.items, nextBeforeId: page.nextBeforeId, loadingMore: false })
    }).catch(() => {
      if (!controller.signal.aborted) setState(current => ({ ...current, phase: 'failed', loadingMore: false }))
    })
    return () => controller.abort()
  }, [enabled, requestVersion, useCase])

  const retry = useCallback(() => {
    loadedOnce.current = false
    setRequestVersion(value => value + 1)
  }, [])

  const loadMore = useCallback(() => {
    if (state.nextBeforeId === null || state.loadingMore) return
    const beforeId = state.nextBeforeId
    setState(current => ({ ...current, loadingMore: true }))
    void useCase.list(beforeId).then(page => {
      setState(current => ({
        phase: 'ready',
        items: [...current.items, ...page.items.filter(item => !current.items.some(currentItem => currentItem.id === item.id))],
        nextBeforeId: page.nextBeforeId,
        loadingMore: false,
      }))
    }).catch(() => setState(current => ({ ...current, phase: 'failed', loadingMore: false })))
  }, [state.loadingMore, state.nextBeforeId, useCase])

  const changeProgress = useCallback(async (item: ApplicationPreparationSummary, progressStage: ApplicationProgressStage) => {
    if (changingId !== null || item.progressStage === progressStage) return false
    setChangingId(item.id)
    setUpdateError(null)
    try {
      const updated = await useCase.updateProgress(item.id, {
        expectedProgressRevision: item.progressRevision,
        progressStage,
      })
      setState(current => ({
        ...current,
        items: current.items.map(currentItem => currentItem.id === item.id ? {
          ...currentItem,
          progressStage: updated.progressStage,
          progressRevision: updated.progressRevision,
          progressStageUpdatedAt: updated.progressStageUpdatedAt,
          updatedAt: updated.updatedAt,
        } : currentItem),
      }))
      return true
    } catch {
      setUpdateError('단계를 저장하지 못했습니다. 최신 상태를 다시 불러온 뒤 시도해 주세요.')
      return false
    } finally {
      setChangingId(null)
    }
  }, [changingId, useCase])

  return { ...state, changingId, updateError, retry, loadMore, changeProgress }
}
