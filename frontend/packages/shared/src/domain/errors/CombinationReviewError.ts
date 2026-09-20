export class CombinationReviewError extends Error {
  readonly status: number
  readonly code: string
  readonly runId: number | null
  readonly retryAfter: string | null
  constructor(status: number, code: string, runId: number | null = null, retryAfter: string | null = null) {
    super(code)
    this.name = 'CombinationReviewError'
    this.status = status; this.code = code; this.runId = runId; this.retryAfter = retryAfter
  }
}
