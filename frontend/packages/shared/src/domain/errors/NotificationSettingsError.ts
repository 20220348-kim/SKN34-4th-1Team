/** 알림 설정 API 실패입니다. 서버 원문 대신 HTTP 상태와 안정적인 오류 코드만 담습니다. */
export class NotificationSettingsError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code)
    this.name = 'NotificationSettingsError'
    this.status = status
    this.code = code
  }
}
