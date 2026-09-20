/** 해석·검색·근거 질문을 지금 실행할 수 없는 업무 상태이며 HTTP 계약은 포함하지 않습니다. */
export class SupportProgramRequestError extends Error {
  readonly reason: 'rate-limited' | 'busy'
  readonly retryAfterSeconds: number | null

  constructor(reason: 'rate-limited' | 'busy', retryAfterSeconds: number | null) {
    super('The support program request cannot be started yet.')
    this.name = 'SupportProgramRequestError'
    this.reason = reason
    this.retryAfterSeconds = retryAfterSeconds
  }
}
