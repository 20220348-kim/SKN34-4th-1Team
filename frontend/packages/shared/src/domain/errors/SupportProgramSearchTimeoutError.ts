/** 서버에서 지원사업 검색 처리 시간을 초과했으며 HTTP 원문은 보관하지 않습니다. */
export class SupportProgramSearchTimeoutError extends Error {
  constructor() {
    super('The support program search exceeded its processing time limit.')
    this.name = 'SupportProgramSearchTimeoutError'
  }
}
