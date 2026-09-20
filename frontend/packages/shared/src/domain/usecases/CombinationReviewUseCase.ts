import { validateReviewDraft, type ReviewDraft, type RunRequest } from '../entities/CombinationReview'
import type { CombinationReviewRepository } from '../repositories/CombinationReviewRepository'

/** 저장·입력 수정과 분석 실행은 별도 API 계약이며 화면은 두 호출을 한 사용자 동작으로 이어갈 수 있다. 조회는 분석을 시작하지 않는다. */
export class CombinationReviewUseCase {
  private readonly repository: CombinationReviewRepository
  constructor(repository: CombinationReviewRepository) { this.repository = repository }
  list(beforeId?: number, signal?: AbortSignal) { return this.repository.list(beforeId, signal) }
  get(id: number, signal?: AbortSignal) { return this.repository.get(id, signal) }
  create(draft: ReviewDraft, signal?: AbortSignal) { return this.repository.create(validateReviewDraft(draft), signal) }
  delete(id: number, signal?: AbortSignal) { return this.repository.delete(id, signal) }
  replace(id: number, revision: number, draft: ReviewDraft, signal?: AbortSignal) { return this.repository.replace(id, revision, validateReviewDraft(draft), signal) }
  runs(id: number, beforeId?: number, signal?: AbortSignal) { return this.repository.runs(id, beforeId, signal) }
  run(id: number, runId: number, signal?: AbortSignal) { return this.repository.run(id, runId, signal) }
  start(id: number, request: RunRequest, signal?: AbortSignal) {
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(request.requestKey) || request.additionalFacts.length > 8000) throw new Error('실행 입력을 확인해 주세요.')
    return this.repository.start(id, { ...request }, signal)
  }
  source(id: number, runId: number, documentIndex: number, signal?: AbortSignal) { return this.repository.source(id, runId, documentIndex, signal) }
}
