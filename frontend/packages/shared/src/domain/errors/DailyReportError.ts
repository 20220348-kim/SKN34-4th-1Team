export class DailyReportError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code)
    this.name = 'DailyReportError'
    this.status = status
    this.code = code
  }
}
