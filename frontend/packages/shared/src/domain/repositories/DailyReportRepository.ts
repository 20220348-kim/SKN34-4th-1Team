import type { DailyReport, DailyReportEmailAction, DailyReportSettings, DailyReportSettingsInput } from '../entities/DailyReport'

export interface DailyReportRepository {
  settings(signal?: AbortSignal): Promise<DailyReportSettings>
  saveSettings(input: DailyReportSettingsInput, signal?: AbortSignal): Promise<DailyReportSettings>
  verifyEmail(signal?: AbortSignal): Promise<void>
  emailAction(action: DailyReportEmailAction, token: string, signal?: AbortSignal): Promise<void>
  latest(signal?: AbortSignal): Promise<DailyReport | null>
  preview(signal?: AbortSignal): Promise<DailyReport | null>
}
