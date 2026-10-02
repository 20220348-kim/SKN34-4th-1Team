import { dailyReportPushRegistrationSchema, dailyReportPushSettingsSchema } from '@govbiz/shared/data/models/DailyReportPushDto'
import type { DailyReportPushRegistration } from '@govbiz/shared/domain/entities/DailyReportPush'
import { apiRequest } from './client'

const path = '/api/v1/me/daily-reports/push'
export async function getPushSettings(accessToken: string, deviceId: string, signal?: AbortSignal) {
  return dailyReportPushSettingsSchema.parse(await apiRequest(`${path}?${new URLSearchParams({ deviceId })}`, { accessToken, signal }))
}
export async function registerPush(accessToken: string, input: DailyReportPushRegistration, signal?: AbortSignal) {
  await apiRequest(path, { method: 'PUT', body: dailyReportPushRegistrationSchema.parse(input), accessToken, signal })
}
export async function disablePush(accessToken: string, deviceId: string, signal?: AbortSignal) {
  await apiRequest(`${path}?${new URLSearchParams({ deviceId })}`, { method: 'DELETE', accessToken, signal })
}
