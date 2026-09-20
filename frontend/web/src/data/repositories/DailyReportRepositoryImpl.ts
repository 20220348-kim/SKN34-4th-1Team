import type { DailyReportEmailAction, DailyReportSettingsInput } from '../../domain/entities/DailyReport'
import type { DailyReportRepository } from '../../domain/repositories/DailyReportRepository'
import { dailyReportRequest as request } from '../api/dailyReportApi'
import { dailyReportResponseSchema, dailyReportSettingsSchema } from '../models/DailyReportDto'

const mine = '/api/v1/me/daily-reports'

export class DailyReportRepositoryImpl implements DailyReportRepository {
  settings(signal?: AbortSignal) { return request(`${mine}/settings`, 'GET', dailyReportSettingsSchema, undefined, signal) }
  saveSettings(input: DailyReportSettingsInput, signal?: AbortSignal) { return request(`${mine}/settings`, 'PUT', dailyReportSettingsSchema, input, signal) }
  verifyEmail(signal?: AbortSignal) { return request<void>(`${mine}/verify-email`, 'POST', 'empty', undefined, signal) }
  emailAction(action: DailyReportEmailAction, token: string, signal?: AbortSignal) {
    return request<void>(`/api/v1/daily-reports/email/${action}`, 'POST', 'empty', { token }, signal)
  }
  async latest(signal?: AbortSignal) { return (await request(`${mine}/latest`, 'GET', dailyReportResponseSchema, undefined, signal)).report }
  async preview(signal?: AbortSignal) { return (await request(`${mine}/preview`, 'POST', dailyReportResponseSchema, undefined, signal)).report }
}
