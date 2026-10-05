import { notificationSettingsSchema } from '@govbiz/shared/data/models/NotificationSettingsDto'
import type { NotificationSettingsRepository } from '@govbiz/shared/domain/repositories/NotificationSettingsRepository'
import { NotificationSettingsUseCase } from '@govbiz/shared/domain/usecases/NotificationSettingsUseCase'
import { ApiError, apiRequest, errorMessage } from './client'

const path = '/api/v1/me/notification-settings'

/** 모바일 Bearer 세션으로 본인 알림 설정을 읽고 저장합니다. 응답은 shared 계약으로 검증합니다. */
function repository(accessToken: string): NotificationSettingsRepository {
  return {
    settings: async (signal) => notificationSettingsSchema.parse(await apiRequest(path, { accessToken, signal })),
    saveDeadlineReminder: async (setting, signal) => notificationSettingsSchema.parse(
      await apiRequest(path, { method: 'PUT', body: { deadlineReminder: setting }, accessToken, signal })),
  }
}

export const notificationSettingsUseCase = (accessToken: string) => new NotificationSettingsUseCase(repository(accessToken))

/** 서버 원문 대신 안정적인 오류 코드로 안내 문구를 고릅니다. */
export function notificationSettingsErrorMessage(cause: unknown): string {
  if (cause instanceof RangeError) return cause.message
  if (cause instanceof ApiError) {
    if (cause.code === 'EMAIL_CONFIRMATION_REQUIRED') return '아래에서 리포트 수신 주소를 먼저 확인해 주세요.'
    if (cause.code === 'EMAIL_DELIVERY_UNAVAILABLE') return '지금은 이메일 발송을 사용할 수 없어요.'
    if (cause.code === 'PUSH_DELIVERY_UNAVAILABLE') return '지금은 앱 알림 발송을 사용할 수 없어요.'
  }
  return errorMessage(cause)
}
