import type { DeadlineReminderSetting, NotificationSettings } from '../entities/NotificationSettings'

export interface NotificationSettingsRepository {
  settings(signal?: AbortSignal): Promise<NotificationSettings>
  saveDeadlineReminder(setting: DeadlineReminderSetting, signal?: AbortSignal): Promise<NotificationSettings>
}
