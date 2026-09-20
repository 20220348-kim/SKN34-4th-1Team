import { useCallback, useEffect, useState } from 'react'
import { appContainer } from '../../../../app/appContainer'
import type { ReviewPage, ReviewSummary } from '../../../../domain/entities/CombinationReview'
import { useReviewScope } from './useReviewScope'

export function useReviewListViewModel(account: string) {
  const useCase = appContainer.resolve('combinationReviewUseCase')
  const journal = appContainer.resolve('reviewRequestJournal')
  const { perform, ...scope } = useReviewScope()
  const [page, setPage] = useState<ReviewPage<ReviewSummary> | null>(null)
  const load = useCallback((before?: number) => perform('list', (signal) => useCase.list(before, signal), (value) => setPage((old) => ({ ...value, items: before ? [...(old?.items ?? []), ...value.items] : value.items }))), [perform, useCase])
  useEffect(() => { void load() }, [load])
  const deleteReview = (id: number) => perform('delete', (signal) => useCase.delete(id, signal), () => {
    try { journal.remove(account, id) } catch { /* 서버 삭제 성공을 브라우저 저장소 오류로 되돌릴 수 없다. */ }
    setPage((old) => old && ({ ...old, items: old.items.filter((item) => item.id !== id) }))
  })
  return { ...scope, page, load, deleteReview }
}
