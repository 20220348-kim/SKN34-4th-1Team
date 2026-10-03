import type { CombinationReview, ReviewDraft, ReviewListItem, ReviewPage, ReviewRun, RunRequest, RunSummary } from '../entities/CombinationReview'

export interface CombinationReviewRepository {
  list(beforeId?: number, signal?: AbortSignal): Promise<ReviewPage<ReviewListItem>>
  get(id: number, signal?: AbortSignal): Promise<CombinationReview>
  create(draft: ReviewDraft, signal?: AbortSignal): Promise<CombinationReview>
  delete(id: number, signal?: AbortSignal): Promise<void>
  replace(id: number, revision: number, draft: ReviewDraft, signal?: AbortSignal): Promise<void>
  runs(id: number, beforeId?: number, signal?: AbortSignal): Promise<ReviewPage<RunSummary>>
  run(id: number, runId: number, signal?: AbortSignal): Promise<ReviewRun>
  start(id: number, request: RunRequest, signal?: AbortSignal): Promise<ReviewRun>
  source(id: number, runId: number, documentIndex: number, signal?: AbortSignal): Promise<Blob>
}
