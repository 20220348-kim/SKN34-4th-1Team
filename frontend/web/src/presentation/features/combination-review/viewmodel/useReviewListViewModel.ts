import { useCallback, useEffect, useState } from 'react'
import { appContainer } from '../../../../app/appContainer'
import type { ReviewListItem, ReviewPage } from '../../../../domain/entities/CombinationReview'
import { useReviewScope } from './useReviewScope'

const activeStatuses = ['QUEUED', 'RUNNING']

export function useReviewListViewModel(account: string) {
  const useCase = appContainer.resolve('combinationReviewUseCase')
  const journal = appContainer.resolve('reviewRequestJournal')
  const { perform, ...scope } = useReviewScope()
  const [page, setPage] = useState<ReviewPage<ReviewListItem> | null>(null)
  const [pollingPaused, setPollingPaused] = useState(false)
  const load = useCallback((before?: number) => perform('list', (signal) => useCase.list(before, signal), (value) => {
    setPage((old) => ({ ...value, items: before ? [...(old?.items ?? []), ...value.items] : value.items }))
    setPollingPaused(false)
  }), [perform, useCase])
  useEffect(() => { void load() }, [load])
  // 대기 · 분석 중인 검토만 그 검토의 최근 실행을 다시 읽어 상태를 갱신합니다. 끝나면(또는 조회가 실패하면) 멈춥니다.
  const activeKey = (page?.items ?? []).filter((item) => item.latestRun && activeStatuses.includes(item.latestRun.status)).map((item) => item.id).join(',')
  useEffect(() => {
    if (!activeKey || pollingPaused) return
    const ids = activeKey.split(',').map(Number)
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const accepted = await perform('poll', (signal) => Promise.all(ids.map((id) => useCase.runs(id, undefined, signal))), (pages) => {
        if (stopped) return
        const latest = new Map(ids.map((id, index) => [id, pages[index]!.items[0] ?? null]))
        setPage((old) => old && ({ ...old, items: old.items.map((item) => latest.has(item.id) ? { ...item, latestRun: latest.get(item.id)! } : item) }))
      })
      if (stopped) return
      if (accepted) timer = setTimeout(() => void poll(), 4000)
      else setPollingPaused(true)
    }
    timer = setTimeout(() => void poll(), 4000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [activeKey, pollingPaused, perform, useCase])
  const deleteReview = (id: number) => perform('delete', (signal) => useCase.delete(id, signal), () => {
    try { journal.remove(account, id) } catch { /* 서버 삭제 성공을 브라우저 저장소 오류로 되돌릴 수 없다. */ }
    setPage((old) => old && ({ ...old, items: old.items.filter((item) => item.id !== id) }))
  })
  return { ...scope, page, load, deleteReview, pollingPaused }
}
