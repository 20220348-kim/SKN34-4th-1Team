/** 조건 해석의 시간 초과와 일시 장애를 구분하며 HTTP 계약이나 원문은 보관하지 않습니다. */
export class SupportProgramInterpretationError extends Error {
  readonly reason: 'timeout' | 'unavailable'

  constructor(reason: 'timeout' | 'unavailable') {
    super('The support program conversation could not be interpreted.')
    this.name = 'SupportProgramInterpretationError'
    this.reason = reason
  }
}
